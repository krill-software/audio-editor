//! Microphone capture via cpal.
//!
//! cpal's `Stream` is `!Send`, so we own it on a dedicated thread for
//! the lifetime of the recording. The thread:
//!   1. negotiates the device's default input config
//!   2. spins up an input stream whose callback pushes samples into a
//!      shared `Vec<f32>` and updates a peak meter
//!   3. parks until the stop signal flips
//!   4. drops the stream (which closes capture) and returns
//!
//! The negotiated `(sample_rate, channels)` is shipped back through a
//! oneshot before parking so the caller knows the format synchronously.

use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

/// Shared handle to an in-progress recording.
pub struct RecHandle {
    pub samples: Arc<Mutex<Vec<f32>>>,
    /// Most recent peak (|sample| max) over the last input callback,
    /// for the level meter. f32 stored bit-packed in an atomic via
    /// `peak.store(value.to_bits())`.
    pub peak_bits: Arc<AtomicU32>,
    pub sample_rate: u32,
    pub channels: u16,
    pub stop: Arc<AtomicBool>,
    pub join: Option<thread::JoinHandle<()>>,
}

impl RecHandle {
    pub fn current_peak(&self) -> f32 {
        f32::from_bits(self.peak_bits.load(Ordering::Relaxed))
    }
}

/// Start capturing from the default input device. Returns once the
/// stream is live and we know the format. Recording continues until
/// `stop` is set or the handle is dropped.
pub fn start() -> Result<RecHandle, String> {
    let samples = Arc::new(Mutex::new(Vec::<f32>::with_capacity(48_000 * 60)));
    let peak_bits = Arc::new(AtomicU32::new(0));
    let stop = Arc::new(AtomicBool::new(false));

    // The thread reports the negotiated format via this oneshot.
    let (tx, rx) = mpsc::channel::<Result<(u32, u16), String>>();

    let samples_for_thread = Arc::clone(&samples);
    let peak_for_thread = Arc::clone(&peak_bits);
    let stop_for_thread = Arc::clone(&stop);

    let join = thread::spawn(move || {
        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                let _ = tx.send(Err("no default input device".to_string()));
                return;
            }
        };
        let supported = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Err(format!("default_input_config: {e}")));
                return;
            }
        };
        let sample_rate = supported.sample_rate().0;
        let channels = supported.channels();
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();

        let err_fn = |err| eprintln!("audio-editor: input stream error: {err}");

        let build_result = match format {
            cpal::SampleFormat::F32 => {
                let samples = Arc::clone(&samples_for_thread);
                let peak = Arc::clone(&peak_for_thread);
                device.build_input_stream(
                    &config,
                    move |data: &[f32], _| ingest_f32(&samples, &peak, data),
                    err_fn,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let samples = Arc::clone(&samples_for_thread);
                let peak = Arc::clone(&peak_for_thread);
                device.build_input_stream(
                    &config,
                    move |data: &[i16], _| {
                        let scaled: Vec<f32> =
                            data.iter().map(|&v| v as f32 / i16::MAX as f32).collect();
                        ingest_f32(&samples, &peak, &scaled);
                    },
                    err_fn,
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let samples = Arc::clone(&samples_for_thread);
                let peak = Arc::clone(&peak_for_thread);
                device.build_input_stream(
                    &config,
                    move |data: &[u16], _| {
                        let scaled: Vec<f32> = data
                            .iter()
                            .map(|&v| (v as f32 / u16::MAX as f32) * 2.0 - 1.0)
                            .collect();
                        ingest_f32(&samples, &peak, &scaled);
                    },
                    err_fn,
                    None,
                )
            }
            other => {
                let _ = tx.send(Err(format!("unsupported input sample format: {other:?}")));
                return;
            }
        };
        let stream = match build_result {
            Ok(s) => s,
            Err(e) => {
                let _ = tx.send(Err(format!("build_input_stream: {e}")));
                return;
            }
        };
        if let Err(e) = stream.play() {
            let _ = tx.send(Err(format!("stream.play: {e}")));
            return;
        }
        // Format is locked in; tell the caller.
        let _ = tx.send(Ok((sample_rate, channels)));

        // Park until told to stop. Polling is fine — recording rarely
        // wants ms-level latency on stop, and we don't want to hold
        // an extra channel just for the wake.
        while !stop_for_thread.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(50));
        }
        drop(stream); // closes capture
    });

    let (sample_rate, channels) = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| format!("waiting for input stream: {e}"))?
        .map_err(|e| e)?;

    Ok(RecHandle {
        samples,
        peak_bits,
        sample_rate,
        channels,
        stop,
        join: Some(join),
    })
}

/// Stop signalled — joins the capture thread.
pub fn stop(handle: &mut RecHandle) {
    handle.stop.store(true, Ordering::Relaxed);
    if let Some(j) = handle.join.take() {
        let _ = j.join();
    }
}

fn ingest_f32(samples: &Arc<Mutex<Vec<f32>>>, peak: &Arc<AtomicU32>, data: &[f32]) {
    let mut local_peak = 0.0f32;
    for &v in data {
        let abs = v.abs();
        if abs > local_peak {
            local_peak = abs;
        }
    }
    peak.store(local_peak.to_bits(), Ordering::Relaxed);
    samples.lock().unwrap().extend_from_slice(data);
}
