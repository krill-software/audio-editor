import "@krill-software/desktop-ui/styles";
import "./styles.css";
import {
  mountChrome,
  buildEmptyState,
  buildErrorState,
  showBootError,
  checkForUpdates,
  type ErrorStateRefs,
} from "@krill-software/desktop-ui";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getMatches } from "@tauri-apps/plugin-cli";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

interface AudioInfo {
  path: string;
  sample_rate: number;
  channels: number;
  bits_per_sample: number;
  sample_format: string;
  total_frames: number;
  duration_ms: number;
  byte_size: number;
  peaks: number[]; // flat min/max pairs
}

interface AppState {
  window?: { width: number; height: number; x: number; y: number };
  recent?: string[];
}

// ---- DOM refs --------------------------------------------------------

let titleEl: HTMLElement;
let viewportEl: HTMLElement;
let railEl: HTMLElement;
let mainContentEl: HTMLDivElement;
let emptyEl: HTMLElement;
let errorState: ErrorStateRefs;

let workEl: HTMLElement;
let waveCanvas: HTMLCanvasElement;
let playheadEl: HTMLDivElement;
let transportEl: HTMLElement;
let playBtn: HTMLButtonElement;
let timeEl: HTMLElement;

// ---- App state --------------------------------------------------------

let current: AudioInfo | null = null;
let isPlaying = false;
let playheadRaf = 0;

// ---- Zoom / view state ----
/** Frame range currently visible. Defaults to the whole track on load
 *  and after structural edits. Scroll-wheel adjusts these around the
 *  cursor; clamping keeps `viewEnd > viewStart`. */
let viewStartFrame = 0;
let viewEndFrame = 0;
/** Cached peaks for the current view. Refetched from the backend
 *  whenever the view changes. */
let viewPeaks: number[] = [];
let peaksReqId = 0;

// ---- Recording state ----
interface RecStartInfo { sample_rate: number; channels: number; }
interface RecStatus { frames: number; peak: number; }
let recording = false;
let recFormat: RecStartInfo | null = null;
let recPollRaf = 0;
let recOverlayEl: HTMLDivElement;
let recLevelEl: HTMLDivElement;
let recTimeEl: HTMLDivElement;

// ---- Selection state ----
interface Selection { startFrame: number; endFrame: number; }
let selection: Selection | null = null;
let selectionEl: HTMLDivElement;
let cutBtn: HTMLButtonElement;
let trimBtn: HTMLButtonElement;
let silenceBtn: HTMLButtonElement;

// ---- Formatting -------------------------------------------------------

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r);
  const ms = Math.floor((r - whole) * 1000);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

// ---- Display state ---------------------------------------------------

type Display = "empty" | "audio" | "error" | "recording";
function setDisplay(s: Display) {
  document.body.dataset.state = s;
  emptyEl.hidden = s !== "empty";
  errorState.element.hidden = s !== "error";
  workEl.hidden = s !== "audio";
  transportEl.hidden = s !== "audio";
  recOverlayEl.hidden = s !== "recording";
  if (s !== "audio" && s !== "recording") {
    titleEl.textContent = "";
    current = null;
    isPlaying = false;
  }
  refreshRailState();
}

// ---- Waveform rendering ---------------------------------------------

function drawWaveform() {
  if (!current) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = waveCanvas.clientWidth;
  const cssH = waveCanvas.clientHeight;
  const w = Math.floor(cssW * dpr);
  const h = Math.floor(cssH * dpr);
  if (waveCanvas.width !== w) waveCanvas.width = w;
  if (waveCanvas.height !== h) waveCanvas.height = h;

  const ctx = waveCanvas.getContext("2d", { alpha: false });
  if (!ctx) return;

  // background
  const bg = getComputedStyle(document.body).getPropertyValue("--fm-bg").trim() || "#FAFAFF";
  const ink = getComputedStyle(document.body).getPropertyValue("--fm-text").trim() || "#30343F";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // peak strokes — prefer the windowed peaks (zoomed view); fall back
  // to the full-track peaks shipped with the file load.
  const peaks = viewPeaks.length > 0 ? viewPeaks : current.peaks;
  const buckets = Math.floor(peaks.length / 2);
  if (buckets === 0) return;

  const mid = h / 2;
  const halfH = h / 2 - 2 * dpr;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  for (let i = 0; i < buckets; i++) {
    const x = (i / buckets) * w + 0.5;
    const mn = peaks[i * 2];
    const mx = peaks[i * 2 + 1];
    const y1 = mid - mx * halfH;
    const y2 = mid - mn * halfH;
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y2);
  }
  ctx.stroke();

  // centerline
  ctx.strokeStyle = getComputedStyle(document.body)
    .getPropertyValue("--fm-rule-strong")
    .trim() || "rgba(48, 52, 63, 0.16)";
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
}

// ---- Playhead -------------------------------------------------------

function updatePlayheadEl(frame: number) {
  if (!current || current.total_frames === 0) {
    playheadEl.style.left = "0px";
    return;
  }
  // Position relative to the current zoom view, not the whole track.
  if (frame < viewStartFrame || frame > viewEndFrame) {
    playheadEl.hidden = true;
  } else {
    playheadEl.hidden = false;
    const pct = (frame - viewStartFrame) / viewLengthFrames();
    playheadEl.style.left = `${pct * waveCanvas.clientWidth}px`;
  }
  const seconds = frame / current.sample_rate;
  const total = current.total_frames / current.sample_rate;
  if (timeEl) timeEl.textContent = `${formatTime(seconds)} / ${formatTime(total)}`;
}

function startPlayheadLoop() {
  cancelAnimationFrame(playheadRaf);
  const tick = async () => {
    if (!isPlaying || !current) return;
    try {
      const f = await invoke<number>("playhead");
      updatePlayheadEl(f);
      if (f >= current.total_frames) {
        isPlaying = false;
        setPlayButtonLabel(false);
        try { await invoke("stop"); } catch { /* ignore */ }
        return;
      }
    } catch { /* ignore */ }
    playheadRaf = requestAnimationFrame(tick);
  };
  playheadRaf = requestAnimationFrame(tick);
}

function stopPlayheadLoop() {
  cancelAnimationFrame(playheadRaf);
  playheadRaf = 0;
}

// ---- Transport ------------------------------------------------------

function setPlayButtonLabel(playing: boolean) {
  playBtn.replaceChildren(svgIcon(playing ? "pause" : "play", 16));
  playBtn.title = playing ? "Pause" : "Play";
  playBtn.dataset.playing = playing ? "true" : "false";
}

async function togglePlay() {
  if (!current) return;
  if (isPlaying) {
    try { await invoke("pause"); } catch (e) { console.warn("pause:", e); return; }
    isPlaying = false;
    setPlayButtonLabel(false);
    stopPlayheadLoop();
  } else {
    try { await invoke("play"); } catch (e) { console.warn("play:", e); return; }
    isPlaying = true;
    setPlayButtonLabel(true);
    startPlayheadLoop();
  }
}

async function seekFromClick(clientX: number) {
  if (!current) return;
  // Seek inside the current zoom view rather than against the full track.
  const frame = frameAtClientXInView(clientX);
  try { await invoke("seek", { frame }); } catch (e) { console.warn("seek:", e); return; }
  updatePlayheadEl(frame);
  if (isPlaying) startPlayheadLoop();
}

// ---- Open file ------------------------------------------------------

async function openPath(path: string): Promise<void> {
  let info: AudioInfo;
  try {
    info = await invoke<AudioInfo>("open_wav", { path });
  } catch (e) {
    console.error("open_wav failed:", e);
    errorState.setFilename(basename(path));
    setDisplay("error");
    return;
  }

  current = info;
  isPlaying = false;
  setPlayButtonLabel(false);
  setDisplay("audio");
  updateTitleBar(basename(info.path));
  resetView();
  void fetchViewPeaks();
  requestAnimationFrame(() => {
    drawWaveform();
    updatePlayheadEl(0);
  });
}

async function openViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "WAV", extensions: ["wav"] }],
  });
  if (typeof selected === "string") await openPath(selected);
}

function updateTitleBar(name: string) {
  titleEl.textContent = name;
  if (!current) return;
  const total = current.total_frames / current.sample_rate;
  if (timeEl) timeEl.textContent = `${formatTime(0)} / ${formatTime(total)}`;
  const title = `${name} — Audio Editor`;
  document.title = title;
  getCurrentWindow().setTitle(title).catch(() => {});
}

// ---- Fullscreen / drag-drop ----------------------------------------

async function toggleFullscreen(): Promise<void> {
  const w = getCurrentWindow();
  const isFs = await w.isFullscreen().catch(() => false);
  await w.setFullscreen(!isFs).catch(() => {});
  document.body.dataset.fullscreen = isFs ? "false" : "true";
  requestAnimationFrame(drawWaveform);
}

function installFullscreenEscape() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && document.body.dataset.fullscreen === "true") {
        e.preventDefault();
        void toggleFullscreen();
      }
    },
    { capture: true },
  );
}

async function installFileDrop() {
  const wv = getCurrentWebview();
  await wv.onDragDropEvent(async (e) => {
    if (e.payload.type === "drop") {
      const path = e.payload.paths[0];
      if (path) await openPath(path);
    }
  });
}

function installSpacePlay() {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    const mod = e.ctrlKey || e.metaKey;

    if (e.code === "Space" && !mod && !e.altKey) {
      e.preventDefault();
      void togglePlay();
      return;
    }
    if (e.code === "KeyR" && !mod && !e.altKey) {
      e.preventDefault();
      if (recording) void stopRecording();
      else void startRecording();
      return;
    }
    if (e.code === "Escape" && selection) {
      e.preventDefault();
      selection = null;
      paintSelection();
      refreshRailState();
      return;
    }
    if (mod && e.code === "KeyZ" && !e.shiftKey) {
      e.preventDefault();
      void undoEdit();
      return;
    }
    if (mod && e.code === "KeyS" && !e.shiftKey) {
      e.preventDefault();
      void save();
      return;
    }
    if (mod && e.code === "KeyS" && e.shiftKey) {
      e.preventDefault();
      void saveAs();
      return;
    }
  });
}

// ---- Zoom -----------------------------------------------------------

/** Reset the visible range to the whole track. Called on load and
 *  after any structural edit that changes total_frames. */
function resetView(): void {
  if (!current) return;
  viewStartFrame = 0;
  viewEndFrame = current.total_frames;
  viewPeaks = [];
}

function viewLengthFrames(): number {
  return Math.max(1, viewEndFrame - viewStartFrame);
}

/** Pull peaks for the current view from the backend at a bucket count
 *  matching the canvas's CSS-pixel width. Drops stale responses via
 *  `peaksReqId`. */
async function fetchViewPeaks(): Promise<void> {
  if (!current) return;
  const myReq = ++peaksReqId;
  const buckets = Math.max(64, Math.floor(waveCanvas.clientWidth));
  try {
    const peaks = await invoke<number[]>("peaks_window", {
      start: viewStartFrame,
      end: viewEndFrame,
      buckets,
    });
    if (myReq !== peaksReqId) return; // a newer request superseded us
    viewPeaks = peaks;
    drawWaveform();
  } catch (e) {
    console.warn("peaks_window failed:", e);
  }
}

/** Map a CSS-pixel X within the canvas to a frame in the current
 *  view (not the full track). */
function frameAtClientXInView(clientX: number): number {
  const rect = waveCanvas.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return Math.round(viewStartFrame + pct * viewLengthFrames());
}

/** Zoom around a focal frame (e.g. the wheel cursor) by `factor`
 *  (>1 = zoom in / shorter view; <1 = zoom out / longer view). */
function zoomViewBy(factor: number, focalFrame: number): void {
  if (!current) return;
  const total = current.total_frames;
  const oldLen = viewLengthFrames();
  let newLen = Math.round(oldLen / factor);
  // Minimum useful view: one CSS pixel per frame is overkill; clamp to
  // ~the canvas width so the view never collapses below pixel detail.
  const minLen = Math.max(64, Math.floor(waveCanvas.clientWidth));
  newLen = Math.max(minLen, Math.min(total, newLen));
  // Keep the focal frame at the same canvas position before/after.
  const focalPct = (focalFrame - viewStartFrame) / oldLen;
  let newStart = focalFrame - Math.round(focalPct * newLen);
  if (newStart < 0) newStart = 0;
  if (newStart + newLen > total) newStart = total - newLen;
  viewStartFrame = newStart;
  viewEndFrame = newStart + newLen;
  void fetchViewPeaks();
}

function installWheelZoom(host: HTMLElement): void {
  host.addEventListener(
    "wheel",
    (e) => {
      if (!current) return;
      e.preventDefault();
      const focal = frameAtClientXInView(e.clientX);
      // deltaY < 0 = scroll up = zoom in (shorter view). Step size
      // calibrated so a typical wheel notch moves ~1.2× per tick.
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomViewBy(factor, focal);
    },
    { passive: false },
  );
}

// ---- Recording ------------------------------------------------------

async function startRecording(): Promise<void> {
  if (recording) return;
  try {
    recFormat = await invoke<RecStartInfo>("record_start");
  } catch (e) {
    console.error("record_start failed:", e);
    return;
  }
  recording = true;
  selection = null;
  setDisplay("recording");
  pollRecording();
}

async function stopRecording(): Promise<void> {
  if (!recording) return;
  recording = false;
  cancelAnimationFrame(recPollRaf);
  let info: AudioInfo;
  try {
    info = await invoke<AudioInfo>("record_stop");
  } catch (e) {
    console.error("record_stop failed:", e);
    setDisplay("empty");
    return;
  }
  current = info;
  selection = null;
  setDisplay("audio");
  resetView();
  void fetchViewPeaks();
  drawWaveform();
  updateTitleBar("untitled.wav");
  updatePlayheadEl(0);
  recFormat = null;
}

function pollRecording(): void {
  if (!recording) return;
  void invoke<RecStatus>("record_status").then((s) => {
    if (!recording || !recFormat) return;
    const seconds = s.frames / recFormat.sample_rate;
    recTimeEl.textContent = formatTime(seconds);
    // Level meter: width as % of container based on peak.
    const pct = Math.min(100, Math.max(0, s.peak * 100));
    recLevelEl.style.width = `${pct}%`;
    recLevelEl.dataset.hot = s.peak > 0.95 ? "true" : "false";
  });
  recPollRaf = requestAnimationFrame(pollRecording);
}

// ---- Selection on the waveform --------------------------------------

function frameAtClientX(clientX: number): number {
  return frameAtClientXInView(clientX);
}

function paintSelection(): void {
  if (!current || !selection) {
    selectionEl.hidden = true;
    return;
  }
  const w = waveCanvas.clientWidth;
  const viewLen = viewLengthFrames();
  // Clip to the visible view; if the selection is entirely off-screen
  // hide the band, otherwise show the visible portion.
  const visStart = Math.max(selection.startFrame, viewStartFrame);
  const visEnd = Math.min(selection.endFrame, viewEndFrame);
  if (visEnd <= visStart) {
    selectionEl.hidden = true;
    return;
  }
  selectionEl.hidden = false;
  selectionEl.style.left = `${((visStart - viewStartFrame) / viewLen) * w}px`;
  selectionEl.style.width = `${((visEnd - visStart) / viewLen) * w}px`;
}

function installSelectionDrag(host: HTMLElement): void {
  let dragging = false;
  let anchorFrame = 0;
  host.addEventListener("mousedown", (e) => {
    if (!current || recording) return;
    if (e.button !== 0) return;
    if (e.shiftKey) {
      // Shift-click extends current selection's far edge.
      if (!selection) return;
      const f = frameAtClientX(e.clientX);
      selection = {
        startFrame: Math.min(selection.startFrame, f),
        endFrame: Math.max(selection.endFrame, f),
      };
      paintSelection();
      refreshRailState();
      return;
    }
    dragging = true;
    anchorFrame = frameAtClientX(e.clientX);
    selection = { startFrame: anchorFrame, endFrame: anchorFrame };
    paintSelection();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging || !current) return;
    const f = frameAtClientX(e.clientX);
    selection = {
      startFrame: Math.min(anchorFrame, f),
      endFrame: Math.max(anchorFrame, f),
    };
    paintSelection();
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    if (selection && selection.endFrame === selection.startFrame) {
      // Click without drag — treat as a seek, not a selection.
      selection = null;
      paintSelection();
    }
    refreshRailState();
  });
}

// ---- Edit ops -------------------------------------------------------

async function applyEdit(cmd: "edit_cut" | "edit_trim" | "edit_silence"): Promise<void> {
  if (!current || !selection) return;
  const { startFrame, endFrame } = selection;
  if (endFrame <= startFrame) return;
  try {
    const info = await invoke<AudioInfo>(cmd, { start: startFrame, end: endFrame });
    current = info;
    selection = null;
    setDisplay("audio");
    resetView();
    void fetchViewPeaks();
    drawWaveform();
    paintSelection();
    updatePlayheadEl(0);
  } catch (e) {
    console.error(`${cmd} failed:`, e);
  }
}

async function undoEdit(): Promise<void> {
  try {
    const info = await invoke<AudioInfo | null>("edit_undo");
    if (!info) return;
    current = info;
    selection = null;
    setDisplay("audio");
    resetView();
    void fetchViewPeaks();
    drawWaveform();
    paintSelection();
    updatePlayheadEl(0);
  } catch (e) {
    console.error("edit_undo failed:", e);
  }
}

// ---- Save -----------------------------------------------------------

async function save(): Promise<void> {
  if (!current) return;
  const path = await invoke<string>("current_path");
  if (path) {
    try {
      await invoke("save_wav", { path });
    } catch (e) {
      console.error("save_wav failed:", e);
    }
  } else {
    await saveAs();
  }
}

async function saveAs(): Promise<void> {
  if (!current) return;
  const chosen = await saveDialog({
    title: "Save WAV as…",
    defaultPath: "untitled.wav",
    filters: [{ name: "WAV", extensions: ["wav"] }],
  });
  if (typeof chosen !== "string") return;
  try {
    const abs = await invoke<string>("save_wav", { path: chosen });
    updateTitleBar(basename(abs));
  } catch (e) {
    console.error("save_wav failed:", e);
  }
}

// ---- Rail -----------------------------------------------------------

function buildRail() {
  // Preserve the aux-topbar that initChrome put at the top; only swap
  // out the content below it.
  const topbar = railEl.querySelector(".aux-topbar");
  railEl.replaceChildren();
  if (topbar) railEl.appendChild(topbar);

  // Capture
  const cap = railBlock("Capture");
  const recBtn = railBtnIcon("Record", "mic", () => void startRecording());
  recBtn.dataset.action = "record";
  cap.appendChild(recBtn);
  const recStopBtn = railBtnIcon("Stop recording", "square", () => void stopRecording());
  recStopBtn.dataset.action = "rec-stop";
  cap.appendChild(recStopBtn);
  railEl.appendChild(cap);

  // Edit
  const ed = railBlock("Edit");
  cutBtn = railBtnIcon("Cut", "scissors", () => void applyEdit("edit_cut"));
  cutBtn.title = "Remove the selected range";
  ed.appendChild(cutBtn);
  trimBtn = railBtnIcon("Trim", "crop", () => void applyEdit("edit_trim"));
  trimBtn.title = "Keep only the selected range";
  ed.appendChild(trimBtn);
  silenceBtn = railBtnIcon("Silence", "volume-x", () => void applyEdit("edit_silence"));
  silenceBtn.title = "Replace the selected range with silence";
  ed.appendChild(silenceBtn);
  railEl.appendChild(ed);

  const hint = document.createElement("div");
  hint.className = "rail-hint";
  hint.textContent = "Drag on the waveform to select. Shift-click extends. Scroll to zoom.";
  railEl.appendChild(hint);

  refreshRailState();
}

function railBlock(label: string): HTMLDivElement {
  const block = document.createElement("div");
  block.className = "rail-block";
  const h = document.createElement("div");
  h.className = "rail-header";
  h.textContent = label;
  block.appendChild(h);
  return block;
}

function railBtnIcon(label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "rail-btn";
  b.append(svgIcon(icon, 14));
  const span = document.createElement("span");
  span.textContent = label;
  b.append(span);
  b.addEventListener("click", onClick);
  return b;
}

/** Enable/disable rail buttons based on whether there's audio + a
 *  selection + recording in flight. Reads body[data-state] indirectly
 *  via the module-level flags so we don't have to query the DOM. */
function refreshRailState(): void {
  const hasAudio = current !== null;
  const hasSel = hasAudio && selection !== null && selection.endFrame > selection.startFrame;
  const rec = recording;
  const recBtn = railEl.querySelector<HTMLButtonElement>('[data-action="record"]');
  const recStopBtn = railEl.querySelector<HTMLButtonElement>('[data-action="rec-stop"]');
  if (recBtn) recBtn.disabled = rec;
  if (recStopBtn) recStopBtn.disabled = !rec;
  if (cutBtn) cutBtn.disabled = !hasSel || rec;
  if (trimBtn) trimBtn.disabled = !hasSel || rec;
  if (silenceBtn) silenceBtn.disabled = !hasSel || rec;
}

// ---- Init -----------------------------------------------------------

function initChrome() {
  const chrome = mountChrome({
    productName: "Audio Editor",
    actions: {},
    showAuxPane: true,
    showStatusLine: false,
    updater: true,
  });
  titleEl = chrome.title; // hidden via CSS but still useful for tests
  viewportEl = chrome.viewport;
  railEl = chrome.aux!;
  railEl.setAttribute("aria-label", "Tools");

  // Shell-app layout: main pane gets its own topbar (drag + window
  // controls). Below that is the scrollable content area renderers
  // swap. desktop-ui's #titlebar + #status-line are hidden via CSS.
  const mainTopbar = buildMainTopbar();
  mainContentEl = document.createElement("div");
  mainContentEl.className = "main-content";

  // Work area: waveform + controls stacked vertically.
  workEl = document.createElement("div");
  workEl.id = "work";
  workEl.hidden = true;

  const waveWrap = document.createElement("div");
  waveWrap.id = "wave-wrap";
  waveCanvas = document.createElement("canvas");
  waveCanvas.id = "wave";
  playheadEl = document.createElement("div");
  playheadEl.id = "playhead";
  selectionEl = document.createElement("div");
  selectionEl.id = "selection";
  selectionEl.hidden = true;
  waveWrap.appendChild(waveCanvas);
  waveWrap.appendChild(selectionEl);
  waveWrap.appendChild(playheadEl);
  installSelectionDrag(waveWrap);
  waveWrap.addEventListener("click", (e) => {
    if (!selection) void seekFromClick(e.clientX);
  });
  installWheelZoom(waveWrap);
  workEl.appendChild(waveWrap);

  // Controls component: [<<10s] [<1s] [▶/⏸] [>1s] [>>10s] + timecode
  transportEl = buildControls();
  transportEl.hidden = true;
  workEl.appendChild(transportEl);

  mainContentEl.appendChild(workEl);

  // Recording overlay — shown only while capturing.
  recOverlayEl = buildRecordOverlay();
  mainContentEl.appendChild(recOverlayEl);

  emptyEl = buildEmptyState();
  mainContentEl.appendChild(emptyEl);

  errorState = buildErrorState({ message: "Can't open this WAV." });
  errorState.element.hidden = true;
  mainContentEl.appendChild(errorState.element);

  viewportEl.replaceChildren(mainTopbar, mainContentEl);

  // Aux pane: topbar (hamburger) + rail content.
  railEl.replaceChildren();
  railEl.appendChild(buildAuxTopbar());
  buildRail();

  document.body.dataset.state = "empty";
  document.body.dataset.aux = "visible";
}

// ---- Shell topbars + hamburger --------------------------------------

function buildMainTopbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "main-topbar";
  bar.setAttribute("data-tauri-drag-region", "true");
  const min = document.createElement("button");
  min.className = "main-topbar-btn";
  min.type = "button";
  min.title = "Minimize";
  min.append(svgIcon("minus", 14));
  min.addEventListener("click", () => { void getCurrentWindow().minimize(); });
  const max = document.createElement("button");
  max.className = "main-topbar-btn";
  max.type = "button";
  max.title = "Maximize";
  max.append(svgIcon("square", 12));
  max.addEventListener("click", () => { void getCurrentWindow().toggleMaximize(); });
  const close = document.createElement("button");
  close.className = "main-topbar-btn";
  close.type = "button";
  close.title = "Close";
  close.setAttribute("data-kind", "close");
  close.append(svgIcon("x", 14));
  close.addEventListener("click", () => { void getCurrentWindow().close(); });
  bar.append(min, max, close);
  return bar;
}

function buildAuxTopbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "aux-topbar";
  bar.setAttribute("data-tauri-drag-region", "true");
  const hamburger = document.createElement("button");
  hamburger.className = "main-topbar-btn";
  hamburger.type = "button";
  hamburger.title = "Menu";
  hamburger.append(svgIcon("menu", 16));
  hamburger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHamburgerMenu(bar);
  });
  bar.appendChild(hamburger);
  return bar;
}

function toggleHamburgerMenu(anchor: HTMLElement): void {
  const existing = document.querySelector(".menu-popover");
  if (existing) { existing.remove(); return; }
  const pop = document.createElement("div");
  pop.className = "menu-popover";
  const items: Array<{ label: string; shortcut?: string; action: () => void; enabled?: () => boolean } | { sep: true }> = [
    { label: "Open…",   shortcut: "Ctrl+O",       action: () => void openViaDialog() },
    { sep: true },
    { label: "Save",    shortcut: "Ctrl+S",       action: () => void save(),   enabled: () => current !== null && !recording },
    { label: "Save as…", shortcut: "Ctrl+Shift+S", action: () => void saveAs(), enabled: () => current !== null && !recording },
    { sep: true },
    { label: "Undo",    shortcut: "Ctrl+Z",       action: () => void undoEdit(), enabled: () => current !== null && !recording },
    { sep: true },
    { label: "Check for updates…", action: () => void checkForUpdates("Audio Editor") },
    { label: "Quit",    shortcut: "Ctrl+Q",       action: () => void getCurrentWindow().close() },
  ];
  for (const it of items) {
    if ("sep" in it) {
      const s = document.createElement("div");
      s.className = "menu-popover-sep";
      pop.appendChild(s);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "menu-popover-item";
    btn.type = "button";
    const label = document.createElement("span");
    label.textContent = it.label;
    btn.appendChild(label);
    if (it.shortcut) {
      const k = document.createElement("span");
      k.className = "menu-popover-shortcut";
      k.textContent = it.shortcut;
      btn.appendChild(k);
    }
    if (it.enabled && !it.enabled()) btn.setAttribute("disabled", "");
    btn.addEventListener("click", () => {
      if (it.enabled && !it.enabled()) return;
      pop.remove();
      it.action();
    });
    pop.appendChild(btn);
  }
  anchor.parentElement?.appendChild(pop);
  setTimeout(() => {
    const handler = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node)) {
        pop.remove();
        document.removeEventListener("click", handler);
      }
    };
    document.addEventListener("click", handler);
  }, 0);
}

// ---- Controls (<<10s < ▶ > >>10s + timecode) -------------------------

function buildControls(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.id = "transport";

  const row = document.createElement("div");
  row.className = "controls";

  const back10 = controlBtn("Back 10s", "skip-back",      () => void seekRelative(-10));
  const back1  = controlBtn("Back 1s",  "chevron-left",   () => void seekRelative(-1));
  playBtn      = controlBtn("Play",     "play",           () => void togglePlay());
  playBtn.classList.add("control-play");
  const fwd1   = controlBtn("Forward 1s",  "chevron-right", () => void seekRelative(1));
  const fwd10  = controlBtn("Forward 10s", "skip-forward",  () => void seekRelative(10));

  row.append(back10, back1, playBtn, fwd1, fwd10);
  wrap.appendChild(row);

  timeEl = document.createElement("div");
  timeEl.id = "transport-time";
  timeEl.className = "mono";
  timeEl.textContent = "0:00.000 / 0:00.000";
  wrap.appendChild(timeEl);

  return wrap;
}

function controlBtn(title: string, icon: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "control-btn";
  b.title = title;
  b.append(svgIcon(icon, 16));
  b.addEventListener("click", onClick);
  return b;
}

async function seekRelative(deltaSeconds: number): Promise<void> {
  if (!current) return;
  const frames = await invoke<number>("playhead");
  const target = Math.max(0, Math.min(
    current.total_frames,
    frames + Math.round(deltaSeconds * current.sample_rate),
  ));
  await invoke("seek", { frame: target });
  updatePlayheadEl(target);
}

function buildRecordOverlay(): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.id = "rec-overlay";
  wrap.hidden = true;
  const label = document.createElement("div");
  label.className = "rec-label";
  label.textContent = "Recording…";
  wrap.appendChild(label);
  recTimeEl = document.createElement("div");
  recTimeEl.id = "rec-time";
  recTimeEl.className = "mono";
  recTimeEl.textContent = "0.0";
  wrap.appendChild(recTimeEl);
  const meter = document.createElement("div");
  meter.id = "rec-meter";
  recLevelEl = document.createElement("div");
  recLevelEl.id = "rec-meter-fill";
  meter.appendChild(recLevelEl);
  wrap.appendChild(meter);
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "control-btn control-play";
  stopBtn.title = "Stop";
  stopBtn.append(svgIcon("square", 16));
  stopBtn.addEventListener("click", () => void stopRecording());
  wrap.appendChild(stopBtn);
  return wrap;
}

// ---- Inline SVG icons ------------------------------------------------

/** Hand-rolled subset of Lucide-style glyphs. Two viewBoxes:
 *    12×12 / 1.2 stroke for window controls (matches desktop-ui)
 *    24×24 / 1.8 stroke for everything else (matches the suite nav set). */
function svgIcon(kind: string, size = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const small = kind === "minus" || kind === "square" || kind === "x" || kind === "menu";
  svg.setAttribute("viewBox", small ? "0 0 12 12" : "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", small ? "1.2" : "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");

  const paths: Record<string, string[]> = {
    "minus":  ["M2 6h8"],
    "square": ["M2.5 2.5h7v7H2.5z"],
    "x":      ["M3 3l6 6", "M9 3l-6 6"],
    "menu":   ["M2 3h8", "M2 6h8", "M2 9h8"],
    // Controls
    "play": [
      "M6 4l14 8-14 8z",
    ],
    "pause": [
      "M6 4h4v16H6z",
      "M14 4h4v16h-4z",
    ],
    "skip-back": [
      "M19 20L9 12l10-8z",
      "M5 4v16",
    ],
    "skip-forward": [
      "M5 4l10 8-10 8z",
      "M19 4v16",
    ],
    "chevron-left":  ["M15 18l-6-6 6-6"],
    "chevron-right": ["M9 18l6-6-6-6"],
    // Edit actions
    "scissors": [
      "M6 6a3 3 0 1 1 0-6 3 3 0 0 1 0 6z",
      "M6 24a3 3 0 1 1 0-6 3 3 0 0 1 0 6z",
      "M8.12 8.12L20 20",
      "M14.8 14.8L20 4",
      "M8.12 15.88L11 13",
    ],
    "crop": [
      "M6 2v14a2 2 0 0 0 2 2h14",
      "M18 22V8a2 2 0 0 0-2-2H2",
    ],
    "volume-x": [
      "M11 5L6 9H2v6h4l5 4z",
      "M22 9l-6 6",
      "M16 9l6 6",
    ],
    "mic": [
      "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z",
      "M19 10v2a7 7 0 0 1-14 0v-2",
      "M12 19v4",
      "M8 23h8",
    ],
  };
  for (const d of paths[kind] ?? []) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

let resizeRaf = 0;
window.addEventListener("resize", () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (current) {
      drawWaveform();
      paintSelection();
      void fetchViewPeaks();
    }
  });
});

async function boot() {
  initChrome();
  installFullscreenEscape();
  installSpacePlay();
  await installFileDrop();

  let opened = false;
  try {
    const matches = await getMatches();
    const arg = matches.args.file?.value;
    if (typeof arg === "string" && arg.length > 0) {
      await openPath(arg);
      opened = true;
    }
  } catch {
    /* cli plugin unavailable */
  }

  if (!opened && import.meta.env.DEV) {
    try {
      const dev = await invoke<string | null>("dev_test_file");
      if (dev) await openPath(dev);
    } catch {
      /* no test file */
    }
  }

  // Touch save/load to keep linker honest (M1 has nothing to persist beyond geometry).
  void invoke<AppState | null>("load_state").catch(() => null);
}

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
