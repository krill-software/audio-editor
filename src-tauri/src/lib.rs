mod record;

use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use krill_desktop_core::{dev as kdev, fs as kfs, state as kstate, updater::BuilderExt};

const HISTORY_MAX: usize = 10;
/// Recordings always land at this rate / depth per SPEC.
const REC_BITS_PER_SAMPLE: u16 = 24;

const SLUG: &str = "krill-audio-editor";
const PEAK_BUCKETS: usize = 4000;

// ---- Loaded audio (kept in app state) -----------------------------------

#[derive(Default)]
struct LoadedAudio {
    path: String,
    samples: std::sync::Arc<Vec<f32>>, // interleaved
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    sample_format: String, // "int" | "float"
}

// ---- Playhead tracking (computed from Instant + sample_rate) ------------

struct Playhead {
    playing: bool,
    /// Sample frame at the moment playback last started or paused.
    anchor_frame: u64,
    /// When playback last started (only meaningful when `playing`).
    started_at: Instant,
    sample_rate: u32,
    total_frames: u64,
}

impl Default for Playhead {
    fn default() -> Self {
        Self {
            playing: false,
            anchor_frame: 0,
            started_at: Instant::now(),
            sample_rate: 48_000,
            total_frames: 0,
        }
    }
}

impl Playhead {
    fn current_frame(&self) -> u64 {
        if !self.playing {
            return self.anchor_frame.min(self.total_frames);
        }
        let elapsed = self.started_at.elapsed().as_secs_f64();
        let frames = (elapsed * self.sample_rate as f64) as u64;
        (self.anchor_frame + frames).min(self.total_frames)
    }
}

// ---- Audio playback thread ----------------------------------------------

enum AudioCmd {
    Play {
        samples: std::sync::Arc<Vec<f32>>,
        sample_rate: u32,
        channels: u16,
        start_frame: u64,
    },
    Pause,
    Resume,
    Stop,
}

fn spawn_audio_thread() -> mpsc::Sender<AudioCmd> {
    let (tx, rx) = mpsc::channel::<AudioCmd>();
    thread::spawn(move || {
        let (_stream, handle) = match rodio::OutputStream::try_default() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("audio: failed to open default output: {e}");
                return;
            }
        };
        let mut sink: Option<rodio::Sink> = None;
        while let Ok(cmd) = rx.recv() {
            match cmd {
                AudioCmd::Play {
                    samples,
                    sample_rate,
                    channels,
                    start_frame,
                } => {
                    if let Some(s) = sink.take() {
                        s.stop();
                    }
                    let skip = (start_frame as usize) * (channels as usize);
                    let tail: Vec<f32> = if skip < samples.len() {
                        samples[skip..].to_vec()
                    } else {
                        Vec::new()
                    };
                    let new_sink = match rodio::Sink::try_new(&handle) {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("audio: sink create failed: {e}");
                            continue;
                        }
                    };
                    let src =
                        rodio::buffer::SamplesBuffer::new(channels, sample_rate, tail);
                    new_sink.append(src);
                    new_sink.play();
                    sink = Some(new_sink);
                }
                AudioCmd::Pause => {
                    if let Some(s) = &sink {
                        s.pause();
                    }
                }
                AudioCmd::Resume => {
                    if let Some(s) = &sink {
                        s.play();
                    }
                }
                AudioCmd::Stop => {
                    if let Some(s) = sink.take() {
                        s.stop();
                    }
                }
            }
        }
    });
    tx
}

// ---- Tauri state -------------------------------------------------------

struct AppAudio {
    loaded: Mutex<LoadedAudio>,
    playhead: Mutex<Playhead>,
    tx: mpsc::Sender<AudioCmd>,
    recording: Mutex<Option<record::RecHandle>>,
    history: Mutex<Vec<Snapshot>>,
}

/// Buffer snapshot for undo. Stored before each edit op; restored on
/// `undo`. We cap the stack at HISTORY_MAX entries so a long edit
/// session doesn't grow without bound.
#[derive(Clone)]
struct Snapshot {
    samples: Arc<Vec<f32>>,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    sample_format: String,
}

// ---- WAV open ----------------------------------------------------------

#[derive(Debug, Serialize)]
struct AudioInfo {
    path: String,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    sample_format: String,
    total_frames: u64,
    duration_ms: u64,
    byte_size: u64,
    peaks: Vec<f32>, // flat [min0, max0, min1, max1, ...] mono peaks
}

fn read_wav_to_f32(
    path: &Path,
) -> Result<(Vec<f32>, hound::WavSpec), String> {
    let mut reader =
        hound::WavReader::open(path).map_err(|e| format!("can't read WAV: {e}"))?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let bits = spec.bits_per_sample as i32;
            let max = ((1i64 << (bits - 1)) - 1) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max).unwrap_or(0.0))
                .collect()
        }
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.unwrap_or(0.0))
            .collect(),
    };
    Ok((samples, spec))
}

fn compute_peaks(samples: &[f32], channels: u16, buckets: usize) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    let total_frames = samples.len() / ch;
    if total_frames == 0 || buckets == 0 {
        return Vec::new();
    }
    let buckets = buckets.min(total_frames);
    let per = total_frames as f64 / buckets as f64;
    let mut out = Vec::with_capacity(buckets * 2);
    for b in 0..buckets {
        let start_f = (b as f64 * per) as usize;
        let end_f = (((b + 1) as f64 * per) as usize).min(total_frames);
        let mut mn = 0.0f32;
        let mut mx = 0.0f32;
        for f in start_f..end_f {
            // collapse channels: take the per-frame extremes across all channels
            for c in 0..ch {
                let v = samples[f * ch + c];
                if v < mn {
                    mn = v;
                }
                if v > mx {
                    mx = v;
                }
            }
        }
        out.push(mn);
        out.push(mx);
    }
    out
}

#[tauri::command]
fn open_wav(
    path: String,
    audio: tauri::State<'_, AppAudio>,
) -> Result<AudioInfo, String> {
    let p = Path::new(&path);
    let byte_size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let (samples, spec) = read_wav_to_f32(p)?;
    let channels = spec.channels.max(1);
    let total_frames = (samples.len() / channels as usize) as u64;
    let duration_ms = if spec.sample_rate > 0 {
        (total_frames * 1000) / spec.sample_rate as u64
    } else {
        0
    };
    let peaks = compute_peaks(&samples, channels, PEAK_BUCKETS);
    let abs = kfs::absolute_path(p);

    // stop anything playing
    let _ = audio.tx.send(AudioCmd::Stop);

    let samples_arc = std::sync::Arc::new(samples);

    {
        let mut loaded = audio.loaded.lock().unwrap();
        loaded.path = abs.clone();
        loaded.samples = std::sync::Arc::clone(&samples_arc);
        loaded.sample_rate = spec.sample_rate;
        loaded.channels = channels;
        loaded.bits_per_sample = spec.bits_per_sample;
        loaded.sample_format = match spec.sample_format {
            hound::SampleFormat::Int => "int",
            hound::SampleFormat::Float => "float",
        }
        .to_string();
    }
    {
        let mut ph = audio.playhead.lock().unwrap();
        ph.playing = false;
        ph.anchor_frame = 0;
        ph.sample_rate = spec.sample_rate;
        ph.total_frames = total_frames;
    }

    Ok(AudioInfo {
        path: abs,
        sample_rate: spec.sample_rate,
        channels,
        bits_per_sample: spec.bits_per_sample,
        sample_format: match spec.sample_format {
            hound::SampleFormat::Int => "int".to_string(),
            hound::SampleFormat::Float => "float".to_string(),
        },
        total_frames,
        duration_ms,
        byte_size,
        peaks,
    })
}

// ---- Transport commands ------------------------------------------------

#[tauri::command]
fn play(audio: tauri::State<'_, AppAudio>) -> Result<(), String> {
    let (samples, sample_rate, channels, start_frame, total_frames) = {
        let loaded = audio.loaded.lock().unwrap();
        let ph = audio.playhead.lock().unwrap();
        if loaded.samples.is_empty() {
            return Err("no file loaded".into());
        }
        let anchor = if ph.anchor_frame >= ph.total_frames {
            0
        } else {
            ph.anchor_frame
        };
        (
            std::sync::Arc::clone(&loaded.samples),
            loaded.sample_rate,
            loaded.channels,
            anchor,
            ph.total_frames,
        )
    };
    audio
        .tx
        .send(AudioCmd::Play {
            samples,
            sample_rate,
            channels,
            start_frame,
        })
        .map_err(|e| e.to_string())?;
    let mut ph = audio.playhead.lock().unwrap();
    ph.anchor_frame = start_frame;
    ph.started_at = Instant::now();
    ph.playing = true;
    ph.total_frames = total_frames;
    Ok(())
}

#[tauri::command]
fn pause(audio: tauri::State<'_, AppAudio>) -> Result<(), String> {
    let now = {
        let ph = audio.playhead.lock().unwrap();
        ph.current_frame()
    };
    audio.tx.send(AudioCmd::Pause).map_err(|e| e.to_string())?;
    let mut ph = audio.playhead.lock().unwrap();
    ph.anchor_frame = now;
    ph.playing = false;
    Ok(())
}

#[tauri::command]
fn stop(audio: tauri::State<'_, AppAudio>) -> Result<(), String> {
    audio.tx.send(AudioCmd::Stop).map_err(|e| e.to_string())?;
    let mut ph = audio.playhead.lock().unwrap();
    ph.anchor_frame = 0;
    ph.playing = false;
    Ok(())
}

#[tauri::command]
fn seek(frame: u64, audio: tauri::State<'_, AppAudio>) -> Result<(), String> {
    let was_playing = {
        let mut ph = audio.playhead.lock().unwrap();
        let total = ph.total_frames;
        ph.anchor_frame = frame.min(total);
        let p = ph.playing;
        ph.playing = false;
        p
    };
    if was_playing {
        play(audio)?;
    } else {
        // stop any in-flight playback so we don't keep hearing the old position
        let _ = audio.tx.send(AudioCmd::Stop);
    }
    Ok(())
}

#[tauri::command]
fn playhead(audio: tauri::State<'_, AppAudio>) -> u64 {
    let ph = audio.playhead.lock().unwrap();
    ph.current_frame()
}

// ---- App state (window geometry + recent files) ------------------------

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppState {
    window: Option<kstate::WindowGeometry>,
    recent: Option<Vec<String>>,
}

#[tauri::command]
fn load_state() -> Option<AppState> {
    kstate::load(SLUG, "state.json")
}

#[tauri::command]
fn save_state(state: AppState) -> Result<(), String> {
    kstate::save(SLUG, "state.json", &state)
}

#[tauri::command]
fn dev_test_file() -> Option<String> {
    kdev::test_file(env!("CARGO_MANIFEST_DIR"), &["test.wav"])
}

// ---- Recording ---------------------------------------------------------

#[derive(Debug, Serialize)]
struct RecStartInfo {
    sample_rate: u32,
    channels: u16,
}

#[tauri::command]
fn record_start(audio: tauri::State<'_, AppAudio>) -> Result<RecStartInfo, String> {
    {
        let mut g = audio.recording.lock().unwrap();
        if g.is_some() {
            return Err("already recording".into());
        }
        let handle = record::start()?;
        let info = RecStartInfo {
            sample_rate: handle.sample_rate,
            channels: handle.channels,
        };
        *g = Some(handle);
        // Stop playback if any; recording owns the audio surface now.
        let _ = audio.tx.send(AudioCmd::Stop);
        Ok(info)
    }
}

#[derive(Debug, Serialize)]
struct RecStatus {
    frames: u64,
    peak: f32,
}

#[tauri::command]
fn record_status(audio: tauri::State<'_, AppAudio>) -> RecStatus {
    let g = audio.recording.lock().unwrap();
    match g.as_ref() {
        Some(h) => {
            let samples = h.samples.lock().unwrap();
            let frames = (samples.len() / h.channels.max(1) as usize) as u64;
            RecStatus { frames, peak: h.current_peak() }
        }
        None => RecStatus { frames: 0, peak: 0.0 },
    }
}

#[tauri::command]
fn record_stop(audio: tauri::State<'_, AppAudio>) -> Result<AudioInfo, String> {
    let handle = {
        let mut g = audio.recording.lock().unwrap();
        g.take().ok_or_else(|| "not recording".to_string())?
    };
    let mut handle = handle;
    record::stop(&mut handle);
    let samples = Arc::new(std::mem::take(&mut *handle.samples.lock().unwrap()));
    let channels = handle.channels.max(1);
    let sample_rate = handle.sample_rate;
    let total_frames = (samples.len() / channels as usize) as u64;
    let duration_ms = if sample_rate > 0 {
        (total_frames * 1000) / sample_rate as u64
    } else {
        0
    };
    let peaks = compute_peaks(&samples, channels, PEAK_BUCKETS);

    {
        let mut loaded = audio.loaded.lock().unwrap();
        loaded.path = String::new(); // unsaved recording
        loaded.samples = Arc::clone(&samples);
        loaded.sample_rate = sample_rate;
        loaded.channels = channels;
        loaded.bits_per_sample = REC_BITS_PER_SAMPLE;
        loaded.sample_format = "int".to_string();
    }
    {
        let mut ph = audio.playhead.lock().unwrap();
        ph.playing = false;
        ph.anchor_frame = 0;
        ph.sample_rate = sample_rate;
        ph.total_frames = total_frames;
    }
    // Reset history — recordings start a fresh edit timeline.
    audio.history.lock().unwrap().clear();

    Ok(AudioInfo {
        path: String::new(),
        sample_rate,
        channels,
        bits_per_sample: REC_BITS_PER_SAMPLE,
        sample_format: "int".to_string(),
        total_frames,
        duration_ms,
        byte_size: 0,
        peaks,
    })
}

// ---- Editing -----------------------------------------------------------

fn push_history(audio: &AppAudio) {
    let loaded = audio.loaded.lock().unwrap();
    let snap = Snapshot {
        samples: Arc::clone(&loaded.samples),
        sample_rate: loaded.sample_rate,
        channels: loaded.channels,
        bits_per_sample: loaded.bits_per_sample,
        sample_format: loaded.sample_format.clone(),
    };
    drop(loaded);
    let mut h = audio.history.lock().unwrap();
    h.push(snap);
    if h.len() > HISTORY_MAX {
        h.remove(0);
    }
}

/// Rebuild AudioInfo from current LoadedAudio. Used as the return for
/// every edit so the frontend gets fresh peaks + duration.
fn current_info(audio: &AppAudio) -> AudioInfo {
    let loaded = audio.loaded.lock().unwrap();
    let channels = loaded.channels.max(1);
    let total_frames = (loaded.samples.len() / channels as usize) as u64;
    let duration_ms = if loaded.sample_rate > 0 {
        (total_frames * 1000) / loaded.sample_rate as u64
    } else {
        0
    };
    let peaks = compute_peaks(&loaded.samples, channels, PEAK_BUCKETS);
    AudioInfo {
        path: loaded.path.clone(),
        sample_rate: loaded.sample_rate,
        channels,
        bits_per_sample: loaded.bits_per_sample,
        sample_format: loaded.sample_format.clone(),
        total_frames,
        duration_ms,
        byte_size: 0,
        peaks,
    }
}

/// Frame range → sample indices into the interleaved buffer.
fn sample_range(loaded: &LoadedAudio, start_frame: u64, end_frame: u64) -> (usize, usize) {
    let ch = loaded.channels.max(1) as usize;
    let total = loaded.samples.len();
    let start = (start_frame as usize).saturating_mul(ch).min(total);
    let end = (end_frame as usize).saturating_mul(ch).min(total);
    if end < start {
        (start, start)
    } else {
        (start, end)
    }
}

#[tauri::command]
fn edit_cut(
    start: u64,
    end: u64,
    audio: tauri::State<'_, AppAudio>,
) -> Result<AudioInfo, String> {
    push_history(&audio);
    let _ = audio.tx.send(AudioCmd::Stop);
    {
        let mut loaded = audio.loaded.lock().unwrap();
        let (s, e) = sample_range(&loaded, start, end);
        let mut new_buf: Vec<f32> = Vec::with_capacity(loaded.samples.len() - (e - s));
        new_buf.extend_from_slice(&loaded.samples[..s]);
        new_buf.extend_from_slice(&loaded.samples[e..]);
        loaded.samples = Arc::new(new_buf);
    }
    sync_playhead(&audio);
    Ok(current_info(&audio))
}

#[tauri::command]
fn edit_trim(
    start: u64,
    end: u64,
    audio: tauri::State<'_, AppAudio>,
) -> Result<AudioInfo, String> {
    push_history(&audio);
    let _ = audio.tx.send(AudioCmd::Stop);
    {
        let mut loaded = audio.loaded.lock().unwrap();
        let (s, e) = sample_range(&loaded, start, end);
        let kept: Vec<f32> = loaded.samples[s..e].to_vec();
        loaded.samples = Arc::new(kept);
    }
    sync_playhead(&audio);
    Ok(current_info(&audio))
}

#[tauri::command]
fn edit_silence(
    start: u64,
    end: u64,
    audio: tauri::State<'_, AppAudio>,
) -> Result<AudioInfo, String> {
    push_history(&audio);
    let _ = audio.tx.send(AudioCmd::Stop);
    {
        let mut loaded = audio.loaded.lock().unwrap();
        let (s, e) = sample_range(&loaded, start, end);
        let mut new_buf = (*loaded.samples).clone();
        for v in &mut new_buf[s..e] {
            *v = 0.0;
        }
        loaded.samples = Arc::new(new_buf);
    }
    Ok(current_info(&audio))
}

#[tauri::command]
fn edit_undo(audio: tauri::State<'_, AppAudio>) -> Result<Option<AudioInfo>, String> {
    let snap = {
        let mut h = audio.history.lock().unwrap();
        h.pop()
    };
    let snap = match snap {
        Some(s) => s,
        None => return Ok(None),
    };
    let _ = audio.tx.send(AudioCmd::Stop);
    {
        let mut loaded = audio.loaded.lock().unwrap();
        loaded.samples = snap.samples;
        loaded.sample_rate = snap.sample_rate;
        loaded.channels = snap.channels;
        loaded.bits_per_sample = snap.bits_per_sample;
        loaded.sample_format = snap.sample_format;
    }
    sync_playhead(&audio);
    Ok(Some(current_info(&audio)))
}

/// After any structural buffer change, re-anchor the playhead to a
/// valid frame within the new buffer length.
fn sync_playhead(audio: &AppAudio) {
    let loaded = audio.loaded.lock().unwrap();
    let total = (loaded.samples.len() / loaded.channels.max(1) as usize) as u64;
    drop(loaded);
    let mut ph = audio.playhead.lock().unwrap();
    ph.total_frames = total;
    ph.anchor_frame = ph.anchor_frame.min(total);
    ph.playing = false;
}

// ---- Save --------------------------------------------------------------

#[tauri::command]
fn save_wav(path: String, audio: tauri::State<'_, AppAudio>) -> Result<String, String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| kfs::format_io_err(&path, e))?;
        }
    }
    let (samples, sample_rate, channels, bits, fmt) = {
        let loaded = audio.loaded.lock().unwrap();
        (
            Arc::clone(&loaded.samples),
            loaded.sample_rate,
            loaded.channels,
            loaded.bits_per_sample,
            loaded.sample_format.clone(),
        )
    };
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: bits,
        sample_format: if fmt == "float" {
            hound::SampleFormat::Float
        } else {
            hound::SampleFormat::Int
        },
    };
    let mut writer =
        hound::WavWriter::create(p, spec).map_err(|e| format!("create wav: {e}"))?;
    match (spec.sample_format, bits) {
        (hound::SampleFormat::Float, 32) => {
            for &v in samples.iter() {
                writer.write_sample(v).map_err(|e| format!("write: {e}"))?;
            }
        }
        (hound::SampleFormat::Int, b) => {
            // Scale f32 [-1, 1] → signed int max for the given depth.
            let max = ((1i64 << (b - 1)) - 1) as f32;
            for &v in samples.iter() {
                let clipped = v.clamp(-1.0, 1.0);
                let sample = (clipped * max) as i32;
                writer.write_sample(sample).map_err(|e| format!("write: {e}"))?;
            }
        }
        _ => return Err(format!("unsupported sample format: {fmt} / {bits}-bit")),
    }
    writer.finalize().map_err(|e| format!("finalize wav: {e}"))?;

    // Update the loaded path so subsequent saves (Ctrl+S) target it.
    let abs = kfs::absolute_path(p);
    audio.loaded.lock().unwrap().path = abs.clone();
    Ok(abs)
}

#[tauri::command]
fn current_path(audio: tauri::State<'_, AppAudio>) -> String {
    audio.loaded.lock().unwrap().path.clone()
}

/// Peaks for a sub-range of the loaded buffer. Used by the frontend to
/// redraw the waveform at any zoom level — `start_frame` / `end_frame`
/// bound the view, `buckets` is how many min/max pairs we want back
/// (one pair per pixel column is the typical caller pattern).
#[tauri::command]
fn peaks_window(
    start: u64,
    end: u64,
    buckets: usize,
    audio: tauri::State<'_, AppAudio>,
) -> Vec<f32> {
    let loaded = audio.loaded.lock().unwrap();
    let ch = loaded.channels.max(1) as usize;
    let total_frames = loaded.samples.len() / ch;
    let total_u64 = total_frames as u64;
    let s = start.min(total_u64) as usize;
    let e = end.min(total_u64) as usize;
    if e <= s || buckets == 0 {
        return Vec::new();
    }
    let slice = &loaded.samples[s * ch..e * ch];
    compute_peaks(slice, loaded.channels.max(1), buckets)
}

// ---- Boot --------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let tx = spawn_audio_thread();
    let audio = AppAudio {
        loaded: Mutex::new(LoadedAudio::default()),
        playhead: Mutex::new(Playhead::default()),
        tx,
        recording: Mutex::new(None),
        history: Mutex::new(Vec::with_capacity(HISTORY_MAX)),
    };

    tauri::Builder::default()
        .with_updater()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(audio)
        .invoke_handler(tauri::generate_handler![
            open_wav,
            play,
            pause,
            stop,
            seek,
            playhead,
            record_start,
            record_status,
            record_stop,
            edit_cut,
            edit_trim,
            edit_silence,
            edit_undo,
            save_wav,
            current_path,
            peaks_window,
            load_state,
            save_state,
            dev_test_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
