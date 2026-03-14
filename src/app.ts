import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  register,
  unregister,
  isRegistered,
} from "@tauri-apps/plugin-global-shortcut";
import { loadSettings, type Settings } from "./settings";
import { transcriber } from "./gemini";

let isRecording = false;
let settings: Settings;

// Silence detection state
let lastSpeechTime = 0;
let silenceTimer: ReturnType<typeof setTimeout> | null = null;

// Incremental typing state
let lastTypedLength = 0;

export async function initApp() {
  settings = await loadSettings();

  // Configure transcriber
  if (settings.geminiApiKey) {
    transcriber.configure(settings.geminiApiKey, settings.language);
  }

  // Set up transcription callbacks
  transcriber.setCallbacks(onTranscript, onStatus);

  // Listen for audio chunks from Rust
  await listen<{ data: string; rms: number }>("audio-chunk", (event) => {
    const { data, rms } = event.payload;

    // Send audio to Gemini
    transcriber.sendAudio(data);

    // Silence detection for auto-stop
    if (settings.autoStopOnSilence && isRecording) {
      // RMS threshold for "speech" vs "silence" (tuned for typical mic input)
      const speechThreshold = 0.02;
      if (rms > speechThreshold) {
        lastSpeechTime = Date.now();
        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
      } else if (!silenceTimer && lastSpeechTime > 0) {
        // Only start silence timer after we've detected at least some speech
        silenceTimer = setTimeout(() => {
          if (isRecording) {
            stopRecording();
          }
        }, settings.autoStopSilenceMs);
      }
    }
  });

  // Register global hotkey
  await registerHotkey(settings.hotkey);
}

async function registerHotkey(hotkey: string) {
  try {
    const alreadyRegistered = await isRegistered(hotkey);
    if (alreadyRegistered) {
      await unregister(hotkey);
    }
    await register(hotkey, (event) => {
      if (event.state === "Pressed") {
        toggleRecording();
      }
    });
  } catch (err) {
    console.error("Failed to register hotkey:", err);
  }
}

async function toggleRecording() {
  if (isRecording) {
    await stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  if (!settings.geminiApiKey) {
    console.error("No API key configured");
    return;
  }

  isRecording = true;
  lastSpeechTime = 0;
  lastTypedLength = 0;
  transcriber.resetTranscript();

  // Show overlay
  try {
    const overlay = await WebviewWindow.getByLabel("overlay");
    if (overlay) {
      await overlay.show();
      await overlay.emit("recording-started", {});
    }
  } catch (err) {
    console.error("Failed to show overlay:", err);
  }

  // Connect to Gemini and start recording
  await transcriber.connect();
  try {
    await invoke("start_recording");
  } catch (err) {
    console.error("Failed to start recording:", err);
    isRecording = false;
  }
}

async function stopRecording() {
  isRecording = false;

  // Clear silence timer
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  // Stop audio capture
  try {
    await invoke("stop_recording");
  } catch (err) {
    console.error("Failed to stop recording:", err);
  }

  // Small delay to let final transcription arrive
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Type the final text (all-at-once mode)
  const finalText = transcriber.getTranscript().trim();
  if (finalText && settings.typingMode === "all_at_once") {
    try {
      await invoke("type_text", { text: finalText });
    } catch (err) {
      console.error("Failed to type text:", err);
    }
  }

  // Disconnect from Gemini
  await transcriber.disconnect();

  // Hide overlay
  try {
    const overlay = await WebviewWindow.getByLabel("overlay");
    if (overlay) {
      await overlay.emit("recording-stopped", {});
      // Small delay so user sees the stop state
      setTimeout(async () => {
        try {
          await overlay.hide();
        } catch {
          // ignore
        }
      }, 300);
    }
  } catch (err) {
    console.error("Failed to hide overlay:", err);
  }
}

function onTranscript(text: string, _isFinal: boolean) {
  // Emit to overlay for display
  emit("transcript-update", { text });

  // Incremental typing mode
  if (settings.typingMode === "incremental" && isRecording) {
    const newText = text.slice(lastTypedLength);
    if (newText.length > 0) {
      // In incremental mode, we type new characters as they arrive
      // We don't use backspaces for now since transcription is append-only
      // from the inputAudioTranscription stream
      invoke("type_text", { text: newText }).catch((err) =>
        console.error("Incremental type failed:", err)
      );
      lastTypedLength = text.length;
    }
  }
}

function onStatus(
  status: "connecting" | "connected" | "disconnected" | "error",
  message?: string
) {
  emit("gemini-status", { status, message });
}

export function reloadSettings(newSettings: Settings) {
  const oldHotkey = settings.hotkey;
  settings = newSettings;

  // Reconfigure transcriber
  if (settings.geminiApiKey) {
    transcriber.configure(settings.geminiApiKey, settings.language);
  }

  // Re-register hotkey if changed
  if (oldHotkey !== settings.hotkey) {
    unregister(oldHotkey).then(() => registerHotkey(settings.hotkey));
  }
}
