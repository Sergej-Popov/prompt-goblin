import { listen } from "@tauri-apps/api/event";

let timerInterval: ReturnType<typeof setInterval> | null = null;
let startTime = 0;
let waveRaf = 0;
let overlayRecordingActive = false;
let targetMicLevel = 0;
let displayedMicLevel = 0;
let wavePhase = 0;
let listeningDelayTimer: ReturnType<typeof setTimeout> | null = null;

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

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
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

function setOverlayState(state: "loading" | "listening" | "done") {
  recordingDot.classList.remove("loading", "listening", "done");
  recordingDot.classList.add(state);

  if (state === "loading") {
    overlayLabel.textContent = "Loading...";
    return;
  }

  if (state === "listening") {
    overlayLabel.textContent = "Listening...";
    return;
  }

  overlayLabel.textContent = "Done";
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

    const baseY = height / 2;
    const amplitude = overlayRecordingActive
      ? displayedMicLevel * OVERLAY_WAVE_AMPLITUDE_PX
      : 0;

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "rgba(108, 99, 255, 0.3)");
    gradient.addColorStop(0.5, "rgba(74, 222, 128, 0.95)");
    gradient.addColorStop(1, "rgba(108, 99, 255, 0.3)");

    ctx.lineWidth = 2;
    ctx.strokeStyle = gradient;
    ctx.shadowColor = "rgba(74, 222, 128, 0.45)";
    ctx.shadowBlur = 12;
    ctx.beginPath();

    for (let x = 0; x <= width; x += 2) {
      const progress = x / Math.max(width, 1);
      const envelope = Math.sin(progress * Math.PI);
      const y =
        baseY +
        Math.sin(progress * 10 + wavePhase) * amplitude * envelope +
        Math.sin(progress * 22 + wavePhase * 1.8) * amplitude * 0.16;

      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
    ctx.shadowBlur = 0;

    waveRaf = requestAnimationFrame(draw);
  };

  resize();
  window.addEventListener("resize", resize);
  waveRaf = requestAnimationFrame(draw);
}

setupOverlayWave();

// Listen for recording events from the main window
listen<{ state?: "loading" | "listening" }>("recording-started", (event) => {
  if (listeningDelayTimer) {
    clearTimeout(listeningDelayTimer);
    listeningDelayTimer = null;
  }

  overlayRecordingActive = true;
  targetMicLevel = 0;
  displayedMicLevel = 0;
  wavePhase = 0;
  setOverlayState(event.payload?.state === "listening" ? "listening" : "loading");
  overlayTranscript.textContent = "";
  overlayTranscript.classList.remove("visible");
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

listen("recording-stopped", () => {
  if (listeningDelayTimer) {
    clearTimeout(listeningDelayTimer);
    listeningDelayTimer = null;
  }

  overlayRecordingActive = false;
  targetMicLevel = 0;
  setOverlayState("done");
  stopTimer();
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
  const text = event.payload.text;
  if (text) {
    // Show last ~40 chars of transcript
    const displayText =
      text.length > 40 ? "..." + text.slice(-40) : text;
    overlayTranscript.textContent = displayText;
    overlayTranscript.classList.add("visible");
  }
});

window.addEventListener("beforeunload", () => {
  if (waveRaf) {
    cancelAnimationFrame(waveRaf);
  }
});
