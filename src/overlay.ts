import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  drawWaveform,
  isWaveformColorScheme,
  isWaveformStyle,
  type WaveformColorScheme,
  type WaveformStyle,
} from "./waveform-styles";

let timerInterval: ReturnType<typeof setInterval> | null = null;
let startTime = 0;
let waveRaf = 0;
let overlayRecordingActive = false;
let targetMicLevel = 0;
let displayedMicLevel = 0;
let wavePhase = 0;
let listeningDelayTimer: ReturnType<typeof setTimeout> | null = null;
let currentWaveformStyle: WaveformStyle = "classic";
let currentWaveformColorScheme: WaveformColorScheme = "aurora";

const LISTENING_READY_DELAY_MS = 1000;

const MIC_ACTIVITY_RMS_THRESHOLD = 0.01;
const OVERLAY_WAVE_INPUT_GAIN = 18;
const OVERLAY_WAVE_AMPLITUDE_PX = 12;
const OVERLAY_WAVE_SMOOTHING = 0.18;

const overlayLabel = document.getElementById("overlay-label") as HTMLElement;
const overlayTimer = document.getElementById("overlay-timer") as HTMLElement;
const overlayTranscript = document.getElementById(
  "overlay-transcript"
) as HTMLElement;
const overlayWaveCanvas = document.getElementById(
  "overlay-wave-canvas"
) as HTMLCanvasElement;
const recordingDot = document.getElementById("recording-dot") as HTMLElement;
const overlayHud = document.getElementById("overlay-hud") as HTMLElement;
const overlayHudModel = document.getElementById("overlay-hud-model") as HTMLElement;
const overlayHudLatency = document.getElementById("overlay-hud-latency") as HTMLElement;
const overlayHudConfidence = document.getElementById("overlay-hud-confidence") as HTMLElement;
const overlayPill = document.getElementById("overlay-pill") as HTMLElement;
let showDebugHud = false;

function hideTranscriptPreview() {
  overlayTranscript.textContent = "";
  overlayTranscript.classList.remove("visible");
}

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

overlayPill.addEventListener("mousedown", (event) => {
  if (event.button !== 0) {
    return;
  }

  void getCurrentWindow().startDragging();
});

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function startTimer() {
  startTime = Date.now();
  overlayTimer.textContent = "0:00";
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    overlayTimer.textContent = formatTime(elapsed);
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function setOverlayState(
  state: "loading" | "listening" | "transcribing" | "correcting" | "done",
  customLabel?: string
) {
  recordingDot.classList.remove("loading", "listening", "transcribing", "correcting", "done");
  recordingDot.classList.add(state);

  if (customLabel) {
    overlayLabel.textContent = customLabel;
    return;
  }

  if (state === "loading") {
    overlayLabel.textContent = "Loading...";
    return;
  }

  if (state === "listening") {
    overlayLabel.textContent = "Listening...";
    return;
  }

  if (state === "transcribing") {
    overlayLabel.textContent = "Transcribing...";
    return;
  }

  if (state === "correcting") {
    overlayLabel.textContent = "Correcting...";
    return;
  }

  overlayLabel.textContent = "Done";
}

function formatHudLatency(latencyMs: number | null | undefined): string {
  if (latencyMs === null || latencyMs === undefined || !Number.isFinite(latencyMs)) {
    return "Latency --";
  }

  if (latencyMs < 1000) {
    return `Latency ${Math.max(0, Math.round(latencyMs))}ms`;
  }

  return `Latency ${(latencyMs / 1000).toFixed(1)}s`;
}

function formatHudConfidence(
  confidencePct: number | null | undefined,
  mode: string | null | undefined
): string {
  if (confidencePct === null || confidencePct === undefined || !Number.isFinite(confidencePct)) {
    return "Confidence --";
  }

  const marker = mode === "estimated" ? "~" : "";
  return `Confidence${marker} ${Math.round(confidencePct)}%`;
}

function setHudVisibility() {
  overlayHud.style.display = showDebugHud ? "flex" : "none";
  if (!showDebugHud) {
    hideTranscriptPreview();
  }
}

function resetHud() {
  overlayHudModel.textContent = "Model --";
  overlayHudLatency.textContent = "Latency --";
  overlayHudConfidence.textContent = "Confidence --";
  overlayHud.removeAttribute("title");
  setHudVisibility();
}

function formatHudModel(provider: string | null | undefined, model: string | null | undefined): string {
  const normalizedProvider = provider?.trim() ?? "";
  const normalizedModel = model?.trim() ?? "";
  if (!normalizedProvider && !normalizedModel) {
    return "Model --";
  }
  if (!normalizedProvider) {
    return normalizedModel;
  }
  if (!normalizedModel) {
    return normalizedProvider;
  }
  return `${normalizedProvider}: ${normalizedModel}`;
}

function setupOverlayWave() {
  const ctx = overlayWaveCanvas.getContext("2d");
  if (!ctx) {
    return;
  }

  let lastCssWidth = 0;
  let lastCssHeight = 0;

  const resize = () => {
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = overlayWaveCanvas.clientWidth;
    const cssHeight = overlayWaveCanvas.clientHeight || 28;
    lastCssWidth = cssWidth;
    lastCssHeight = cssHeight;
    overlayWaveCanvas.width = Math.floor(cssWidth * ratio);
    overlayWaveCanvas.height = Math.floor(cssHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const draw = () => {
    const currentWidth = overlayWaveCanvas.clientWidth;
    const currentHeight = overlayWaveCanvas.clientHeight || 28;
    if (currentWidth !== lastCssWidth || currentHeight !== lastCssHeight) {
      resize();
    }

    const width = overlayWaveCanvas.clientWidth;
    const height = overlayWaveCanvas.clientHeight || 28;

    displayedMicLevel += (targetMicLevel - displayedMicLevel) * OVERLAY_WAVE_SMOOTHING;
    if (!overlayRecordingActive) {
      targetMicLevel = 0;
      displayedMicLevel *= 0.92;
    } else if (displayedMicLevel > 0.002) {
      wavePhase += 0.12 + displayedMicLevel * 0.2;
    }

    ctx.clearRect(0, 0, width, height);

    const amplitude = overlayRecordingActive
      ? displayedMicLevel * OVERLAY_WAVE_AMPLITUDE_PX
      : 0;

    drawWaveform(currentWaveformStyle, {
      ctx,
      width,
      height,
      amplitude,
      phase: wavePhase,
      active: overlayRecordingActive,
      colorScheme: currentWaveformColorScheme,
    });

    waveRaf = requestAnimationFrame(draw);
  };

  resize();
  window.addEventListener("resize", resize);
  waveRaf = requestAnimationFrame(draw);
}

setupOverlayWave();
resetHud();

// Listen for recording events from the main window
listen<{
  state?: "loading" | "listening";
  waveformStyle?: string;
  waveformColorScheme?: string;
}>("recording-started", (event) => {
  if (listeningDelayTimer) {
    clearTimeout(listeningDelayTimer);
    listeningDelayTimer = null;
  }

  if (isWaveformStyle(event.payload?.waveformStyle)) {
    currentWaveformStyle = event.payload.waveformStyle;
  }
  if (isWaveformColorScheme(event.payload?.waveformColorScheme)) {
    currentWaveformColorScheme = event.payload.waveformColorScheme;
  }

  overlayRecordingActive = true;
  targetMicLevel = 0;
  displayedMicLevel = 0;
  wavePhase = 0;
  resetHud();
  setOverlayState(event.payload?.state === "listening" ? "listening" : "loading");
  hideTranscriptPreview();
  startTimer();
});

listen("recording-ready", () => {
  if (!overlayRecordingActive) {
    return;
  }

  if (listeningDelayTimer) {
    clearTimeout(listeningDelayTimer);
  }

  listeningDelayTimer = setTimeout(() => {
    listeningDelayTimer = null;
    if (!overlayRecordingActive) {
      return;
    }
    setOverlayState("listening");
  }, LISTENING_READY_DELAY_MS);
});

listen<{
  state?: "transcribing" | "correcting";
  label?: string;
}>("recording-phase", (event) => {
  if (!overlayRecordingActive) {
    return;
  }

  if (listeningDelayTimer) {
    clearTimeout(listeningDelayTimer);
    listeningDelayTimer = null;
  }

  if (event.payload?.state) {
    setOverlayState(event.payload.state, event.payload.label);
  }
});

listen("recording-stopped", () => {
  if (listeningDelayTimer) {
    clearTimeout(listeningDelayTimer);
    listeningDelayTimer = null;
  }

  overlayRecordingActive = false;
  targetMicLevel = 0;
  resetHud();
  setOverlayState("done");
  stopTimer();
});

listen<{ waveformStyle?: string; waveformColorScheme?: string }>(
  "overlay-settings-updated",
  (event) => {
  if (isWaveformStyle(event.payload.waveformStyle)) {
    currentWaveformStyle = event.payload.waveformStyle;
  }
    if (isWaveformColorScheme(event.payload.waveformColorScheme)) {
      currentWaveformColorScheme = event.payload.waveformColorScheme;
    }
  }
);

listen<{
  latencyMs?: number | null;
  confidencePct?: number | null;
  confidenceMode?: string;
  provider?: string;
  model?: string;
  debugEnabled?: boolean;
  waveformStyle?: string;
  waveformColorScheme?: string;
}>("recording-hud-update", (event) => {
  showDebugHud = event.payload.debugEnabled === true;
  setHudVisibility();
  if (isWaveformStyle(event.payload.waveformStyle)) {
    currentWaveformStyle = event.payload.waveformStyle;
  }
  if (isWaveformColorScheme(event.payload.waveformColorScheme)) {
    currentWaveformColorScheme = event.payload.waveformColorScheme;
  }
  overlayHudLatency.textContent = formatHudLatency(event.payload.latencyMs);
  overlayHudConfidence.textContent = formatHudConfidence(
    event.payload.confidencePct,
    event.payload.confidenceMode
  );

  const provider = event.payload.provider?.trim() ?? "";
  const model = event.payload.model?.trim() ?? "";
  overlayHudModel.textContent = formatHudModel(provider, model);
  if (provider || model) {
    overlayHud.title = `${provider}${provider && model ? " - " : ""}${model}`;
  }
});

listen<{ rms: number }>("audio-chunk", (event) => {
  if (!overlayRecordingActive) {
    return;
  }

  const rms = event.payload.rms;
  const receivingAudio = rms >= MIC_ACTIVITY_RMS_THRESHOLD;
  targetMicLevel = receivingAudio ? Math.min(1, rms * OVERLAY_WAVE_INPUT_GAIN) : 0;
});

// Listen for transcript updates
listen<{ text: string }>("transcript-update", (event) => {
  if (!showDebugHud) {
    hideTranscriptPreview();
    return;
  }

  const text = event.payload.text;
  if (text) {
    // Show last ~40 chars of transcript
    const displayText =
      text.length > 40 ? "..." + text.slice(-40) : text;
    overlayTranscript.textContent = displayText;
    overlayTranscript.classList.add("visible");
    return;
  }

  hideTranscriptPreview();
});

window.addEventListener("beforeunload", () => {
  if (waveRaf) {
    cancelAnimationFrame(waveRaf);
  }
});
