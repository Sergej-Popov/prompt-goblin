import { listen } from "@tauri-apps/api/event";

let timerInterval: ReturnType<typeof setInterval> | null = null;
let startTime = 0;

const overlayLabel = document.getElementById("overlay-label") as HTMLElement;
const overlayTimer = document.getElementById("overlay-timer") as HTMLElement;
const overlayTranscript = document.getElementById(
  "overlay-transcript"
) as HTMLElement;

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

// Listen for recording events from the main window
listen("recording-started", () => {
  overlayLabel.textContent = "Listening...";
  overlayTranscript.textContent = "";
  overlayTranscript.classList.remove("visible");
  startTimer();
});

listen("recording-stopped", () => {
  overlayLabel.textContent = "Done";
  stopTimer();
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
