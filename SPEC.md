# Audio Editor — Spec (v1)

A minimal, single-file Linux audio editor. Open one WAV, view its waveform, play it, cut/trim/split, save as a new file. **Recording is a verb inside the editor**, not a separate app — "new file from microphone" gives you a buffer that fills from the mic; when you hit stop you're already in the editor with the result. The bar is Audacity-without-the-modes, not Reaper.

## Goals

- Open, edit, save one WAV file at a time — fast launch, no project/session concept.
- Cover the 80% of casual audio-editing jobs: trim, cut, split, fade, normalize, gain, save.
- Record from the system microphone as a first-class operation, into the same waveform surface.
- Feel like a native Linux desktop app (`.desktop` entry, file associations, XDG dirs).
- **Live feedback.** Scrolling waveform while recording; live waveform redraw on edits; sample-accurate playback cursor.

## Non-goals (v1)

- No multitrack. One file, one waveform, one timeline.
- No effects beyond gain / normalize / fades. No EQ, reverb, compression, pitch-shift, time-stretch.
- No non-destructive edit graph — every cut commits to samples; undo is in-session only.
- No formats other than WAV — no MP3 / FLAC / OGG / AAC in or out (see *Format lock* below).
- No MIDI, no instruments, no plugins (VST/LV2/CLAP).
- No multi-tab or multi-window session management (one file per window).
- No Windows/macOS builds.
- No settings panel; no dark-mode toggle; no telemetry.

## Stack

- **Shell:** Tauri 2 (Rust backend + system webview).
- **Frontend:** TypeScript + Vite.
- **Chrome + palette:** [`@krill-software/desktop-ui`](https://github.com/krill-software/desktop-ui) (git dep). Locked-palette CSS, custom titlebar, menu bar, status line via `mountChrome()`.
- **Core helpers:** [`krill-desktop-core`](https://github.com/krill-software/desktop-core) (Cargo git dep). State I/O, recent files, file helpers.
- **Audio capture:** [`cpal`](https://crates.io/crates/cpal) — ALSA/Pulse/PipeWire on Linux through one API.
- **WAV I/O:** [`hound`](https://crates.io/crates/hound) — read/write PCM WAV.
- **Playback:** [`rodio`](https://crates.io/crates/rodio) on top of cpal — `Sink` with seek/pause/volume.
- **Waveform render:** `<canvas>` with downsampled peak buffers per zoom level (one min/max pair per pixel column).

Rationale: WAV stays simple end-to-end (PCM in, PCM out, no codec licensing). cpal handles PipeWire-via-pulse-shim on modern Linux without extra deps. The split mirrors image-editor: heavy I/O in Rust, live preview in the webview.

## Format lock

New recordings are written as **48 kHz / 24-bit signed PCM, mono or stereo** (whatever the input device exposes). Opened files may be any PCM WAV (8/16/24/32-bit int, 32-bit float, 8 k–192 k, mono/stereo). On save, files are written back at the same rate/depth they were opened with — no silent resampling. Recordings are always 48 k/24-bit; recordings saved without prior edits keep that.

This is the "one theme, locked" rule applied to audio: one capture format, no picker.

## Architecture — buffer + journal

Audio lives in one **interleaved f32 sample buffer** in Rust (decoded on open, captured live on record). Edits are journaled as a stack of ops applied to that buffer.

```
[wav bytes]  →  decode (hound)  →  [f32 sample buffer]  →  ops stack  →  [waveform canvas]
                                                              │
                                                              └──→  on save-as: apply stack, encode (hound)
```

- Ops are plain values: `{ kind: "cut", from: 480_000, to: 528_000 }`, `{ kind: "fade-in", from, to }`, `{ kind: "gain", from, to, db: -3 }`, `{ kind: "normalize", peak_db: -1 }`.
- Every op operates on **sample indices**, not seconds — the source of truth is samples; the UI converts to mm:ss.ms for display.
- The waveform canvas reads from a cached **peak buffer** (min/max per pixel column). The peak buffer is rebuilt incrementally — a cut only invalidates from the cut point onward.

### Recording

- "New from mic" opens a fresh window with an empty buffer.
- `cpal` capture callback pushes samples into the buffer. The peak buffer extends per chunk; the waveform scrolls left as samples arrive.
- Stop commits the buffer. The recording is now an edit target like any opened file. First save is, naturally, a save-as.

### Undo / redo

- Snapshot the ops stack on every committed op. `Ctrl+Z` pops, `Ctrl+Shift+Z` pushes forward.
- In-flight slider drags (gain, fade length) don't commit until release.
- Undo is **session-only**. Once you save-as to disk, the previous file is the previous version; we don't track it.
- Recording is itself an op-free state; "undo" after a stop discards the recorded samples (with confirmation — recordings are unique).

### Save model — destructive, save-as always

Every save is a save-as. There is no "Save" that overwrites the open file. `Ctrl+S` and `Ctrl+Shift+S` both open the save dialog with a sensible default filename:

- Opened file `interview.wav`, edited → default `interview-edit.wav` (or `interview-edit-1.wav`, `-2.wav` on collisions).
- Fresh recording → default `recording-YYYY-MM-DD-HHMMSS.wav`.

Originals are never touched. The filesystem is the across-save undo. Dirty marker clears on successful save.

## Features (v1)

### File I/O
- **Open:** drag-drop, CLI arg, `Ctrl+O`. Accepts any PCM WAV.
- **New (record):** `Ctrl+N` opens an empty window in armed state, ready to record.
- **Save / Save As:** both `Ctrl+S` and `Ctrl+Shift+S` open the save dialog (destructive save-as model). No overwrite of the loaded file.
- **Recent files:** last 10, persisted in XDG state.

### Recording
- Input device selector: **popover from the input level meter** in the rail. Lists `cpal`'s available input devices; persists last choice across sessions. Defaults to the system default.
- Format: 48 kHz, 24-bit, channels = device default (mono or stereo).
- Controls: `Record` (or `R`), `Stop` (or `R` again / `Space`). Pause is *not* a v1 feature — stop then record-append (M3 stretch).
- During recording: **scrolling waveform draws left** as samples arrive, level meter shows current peak, timer counts mm:ss.ms.
- Clipping indicator on the meter (peak ≥ -0.1 dBFS) latches red until manually cleared.

### Editing
- **Selection:** click-drag on the waveform selects a range. `Shift+click` extends. `Esc` clears.
- **Cut** (`Ctrl+X` or `Delete`): removes the selected range, closes the gap. Cursor stays at the cut point.
- **Trim** (`Ctrl+T`): inverse of cut — keeps the selection, discards everything else.
- **Split** (`S`): inserts a marker at the playhead. Markers split the waveform visually; they aren't an edit by themselves but constrain the next cut to between markers if no selection is active.
- **Fade in / Fade out** (`Ctrl+I` / `Ctrl+Shift+I`): linear fade across the current selection (or first/last 1.0 s if no selection).
- **Gain** (rail slider, ±24 dB): applied to selection (or whole file).
- **Normalize** (`Ctrl+Shift+N`): scale so peak hits −1 dBFS. Whole file only in v1.
- **Silence** (`Ctrl+L`): replace selection with silence (preserves length, useful for blanking a cough).

### Playback
- Transport: Play/Pause (`Space`), Stop (`Ctrl+.`), seek by clicking the timeline. Loop selection (`L`).
- Playhead is drawn on the canvas; updates per `requestAnimationFrame` from rodio's stream position.
- Output device: system default. No picker in v1.

### Viewport
- **Zoom:** `Ctrl+=` / `Ctrl+-` / `Ctrl+0` (fit). Horizontal mouse-wheel with `Ctrl` zooms toward the cursor. Vertical scroll is the timeline.
- **Pan:** click-drag on the timeline ruler; space-drag on the waveform.
- **Fit-to-window** on open.
- Time ruler above the waveform: tick density adapts to zoom (frames → ms → s → min).

### Preview mode
- `F` toggles chrome-free preview: waveform only, centered, no rail. `Esc` returns.

## UX principles

1. **One window, one file.** Opening a second file launches a second process/window.
2. **The waveform is the main surface.** Tools live in a thin right rail; transport bar sits under the waveform.
3. **Keyboard reachable.** Every op has a shortcut; the rail is for discovery and slider controls.
4. **Recording is not a mode.** It's the initial state of a new file. There is no "recording view" to leave.
5. **No modal dialogs during edit.** Save is the only modal.
6. **Save is always safe.** No save ever overwrites the file you opened.

## Window chrome

- Custom titlebar (from desktop-ui `mountChrome()`), filename centered, dirty `•` prefix.
- **Right rail (260px):** input meter + device popover, gain slider, normalize / fade buttons, marker list. Manipulation app — controls live next to the work.
- **Status line:**
  - `#status-info` (left): file identity — `WAV · 48 kHz · 24-bit · stereo · 3.42 MB`.
  - `#status-state` (right): position / state — `00:01:23.456 / 00:04:12.000 · 100%`.

## Keybindings (v1)

| Action | Key |
|---|---|
| Open | `Ctrl+O` |
| New (arm record) | `Ctrl+N` |
| Save / Save As (both prompt) | `Ctrl+S` / `Ctrl+Shift+S` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Record / Stop record | `R` |
| Play / Pause | `Space` |
| Stop playback | `Ctrl+.` |
| Loop selection | `L` |
| Cut selection | `Ctrl+X` or `Delete` |
| Trim to selection | `Ctrl+T` |
| Split marker at playhead | `S` |
| Fade in / Fade out | `Ctrl+I` / `Ctrl+Shift+I` |
| Silence selection | `Ctrl+L` |
| Normalize | `Ctrl+Shift+N` |
| Zoom in / out / fit | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Preview mode | `F` |
| Quit | `Ctrl+Q` |

## File handling

- **Formats in/out:** WAV only (PCM, int 8/16/24/32 or f32, 8 k–192 k, mono/stereo).
- **Dirty tracking:** ops stack non-empty since last save → dirty.
- **External changes:** not watched (audio files rarely mutate under the user).
- **No autosave.** Recordings live only in memory until the user saves; closing an unsaved recording prompts.

## Linux integration

- Binary: `krill-audio-editor`.
- `.desktop` MIME types: `audio/wav`, `audio/x-wav`.
- State: `$XDG_STATE_HOME/krill-audio-editor/` — window geometry, recent files, last input device id.
- Distribution: AppImage primary; `.deb` secondary.

## Iconography

Shimmering Blush disc + a single Lucide glyph in Ghost White. Candidate: **`audio-waveform`** (or `waveform` depending on Lucide's current naming). Recorded into [`scripts/render-icons.py`](https://github.com/krill-software/.github/blob/main/scripts/render-icons.py)'s `APPS` map.

## Out of scope / open questions

- Pause-during-record / append to existing file — M3 stretch.
- Multi-channel files (>2 ch) — opened as-is but no channel-specific edits in v1.
- Sample-rate conversion on save — explicitly not done in v1.
- Spectrogram view — v2 at earliest.
- Cue points / BWF metadata — v2.

## Milestones

1. **M1 — Skeleton + open/play.** Done. Tauri app, open WAV via CLI / drag-drop / `Ctrl+O`, hound decodes any PCM WAV to f32, waveform on `<canvas>`, rodio playback with a tracking playhead.
2. **M2 — Record.** Done. `R` toggles capture from the default input via cpal. Live duration counter + level meter while recording; stop commits the buffer into the editor as if it were just opened. Saving writes WAV via hound at the recording's negotiated rate / 24-bit signed PCM.
3. **M3 — Edit.** Done. Drag-select on the waveform; **cut** / **trim** / **silence** apply to the selection; snapshot-based undo (`Ctrl+Z`, capped at 10 levels). `Esc` clears the selection. `Ctrl+S` saves to the loaded path; `Ctrl+Shift+S` opens a save-as dialog.
4. **M4 — Polish.** Fades in/out, gain, normalize, loop playback, scrolling waveform during capture, input device popover, recent files. Deferred.
5. **M5 — Packaging.** `.desktop`, MIME associations, AppImage + `.deb` via shared release workflow, canonical Lucide `audio-lines` icon (already in `APPS` map), org-page card + landing page. Deferred (next pass).
6. **M6 — Suite convention pass.** Done. `desktop-ui` bumped to v0.10.0, version-in-statusInfo, JetBrains Mono chrome, golden-ratio window dims, regenerated icon.
