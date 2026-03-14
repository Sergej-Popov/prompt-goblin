import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  register,
  unregister,
  isRegistered,
} from "@tauri-apps/plugin-global-shortcut";
import {
  loadSettings,
  saveProviderLastKnownGoodModel,
  type Settings,
} from "./settings";
import { debugLog, isDebugLoggingEnabled } from "./logger";
import {
  createLiveTranscriber,
  getProviderApiKey,
  getProviderFallbackModels,
  getProviderLabel,
  getProviderSelectedModel,
} from "./stt/service";
import type { LiveTranscriber } from "./stt/types";

let isRecording = false;
let settings: Settings;
let transcriber: LiveTranscriber = createLiveTranscriber("gemini");
let activeProvider: Settings["sttProvider"] = "gemini";
let overlayListeningReady = false;

// Silence detection state
let lastSpeechTime = 0;
let silenceTimer: ReturnType<typeof setTimeout> | null = null;

// Incremental typing state
let lastTypedLength = 0;
let recordingStartedAt = 0;
let recordingChunkCount = 0;
let recordingApproxAudioBytes = 0;
let lastAudioProgressLogAt = 0;
let lastTranscriptProgressChars = 0;
let stoppingDueToDisconnect = false;
let lastTranscriptEventAt = 0;
let lastTranscriptStallWarnAt = 0;
let incrementalTypeCallCount = 0;
let incrementalTypeCharCount = 0;
let incrementalTypeFailureCount = 0;
let lastAudioTurnBoundaryAt = 0;
let audioTurnBoundaryCount = 0;
let recoveryInProgress = false;
let suppressAutoStopForRecovery = false;
let lastRecoveryAttemptAt = 0;
let recoveryAttemptCount = 0;
let recoverySuccessCount = 0;
let recoveryFailureCount = 0;

const TRANSCRIPT_STALL_WARN_MS = 5000;
const TRANSCRIPT_STALL_WARN_LOG_INTERVAL_MS = 5000;
const STALL_RECOVERY_TRIGGER_MS = 8500;
const STALL_RECOVERY_COOLDOWN_MS = 12000;
const PERIODIC_AUDIO_TURN_BOUNDARY_MS = 12000;

function ensureTranscriberForProvider() {
  if (settings.sttProvider === activeProvider) {
    return;
  }

  transcriber = createLiveTranscriber(settings.sttProvider);
  transcriber.setCallbacks(onTranscript, onStatus);
  activeProvider = settings.sttProvider;
}

function configureTranscriberFromSettings() {
  ensureTranscriberForProvider();
  const apiKey = getProviderApiKey(settings);
  if (!apiKey) {
    return;
  }

  transcriber.configure({
    apiKey,
    language: settings.language,
    preferredModel: getProviderSelectedModel(settings),
    fallbackModels: getProviderFallbackModels(settings),
  });
}

function providerLabelForLogs(): string {
  return getProviderLabel(settings.sttProvider);
}

async function emitOverlayEvent(eventName: string, payload: Record<string, unknown> = {}) {
  try {
    const overlay = await WebviewWindow.getByLabel("overlay");
    if (overlay) {
      await overlay.emit(eventName, payload);
    }
  } catch {
    // best-effort overlay messaging
  }
}

function previewText(text: string, maxLen = 140): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > maxLen
    ? `${normalized.slice(0, maxLen)}...`
    : normalized;
}

export async function initApp() {
  settings = await loadSettings();

  // Configure transcriber
  configureTranscriberFromSettings();

  // Set up transcription callbacks
  transcriber.setCallbacks(onTranscript, onStatus);

  // Listen for audio chunks from Rust
  await listen<{ data: string; rms: number }>("audio-chunk", (event) => {
    const { data, rms } = event.payload;

    if (isRecording) {
      recordingChunkCount += 1;
      recordingApproxAudioBytes += Math.floor((data.length * 3) / 4);
      const now = Date.now();
      if (isDebugLoggingEnabled() && now - lastAudioProgressLogAt >= 2000) {
        const elapsedMs = recordingStartedAt > 0 ? now - recordingStartedAt : 0;
        debugLog(
          `Audio capture progress: ${recordingChunkCount} chunks, ~${recordingApproxAudioBytes} bytes, elapsed ${elapsedMs}ms, latest RMS ${rms.toFixed(4)}`,
          "INFO"
        );
        lastAudioProgressLogAt = now;
      }

      if (
        isDebugLoggingEnabled() &&
        transcriber.isConnected() &&
        !recoveryInProgress &&
        recordingChunkCount >= 200 &&
        now - lastAudioTurnBoundaryAt >= PERIODIC_AUDIO_TURN_BOUNDARY_MS
      ) {
        if (transcriber.signalAudioStreamBoundary("periodic")) {
          audioTurnBoundaryCount += 1;
          lastAudioTurnBoundaryAt = now;
          debugLog(
            `Periodic audio turn boundary #${audioTurnBoundaryCount} sent at ${Math.max(0, now - recordingStartedAt)}ms`,
            "INFO"
          );
        }
      }

      if (
        isDebugLoggingEnabled() &&
        recordingChunkCount >= 100 &&
        now - lastTranscriptEventAt >= TRANSCRIPT_STALL_WARN_MS &&
        now - lastTranscriptStallWarnAt >= TRANSCRIPT_STALL_WARN_LOG_INTERVAL_MS
      ) {
        const stalledForMs = now - lastTranscriptEventAt;
        debugLog(
          `Transcript watchdog: audio is flowing but no transcript updates for ${stalledForMs}ms (chunks=${recordingChunkCount}, ~audioBytes=${recordingApproxAudioBytes}, transcriptChars=${transcriber.getTranscript().length}, latestRMS=${rms.toFixed(4)})`,
          "WARN"
        );
        lastTranscriptStallWarnAt = now;

        if (
          stalledForMs >= STALL_RECOVERY_TRIGGER_MS &&
          !recoveryInProgress &&
          now - lastRecoveryAttemptAt >= STALL_RECOVERY_COOLDOWN_MS
        ) {
          void recoverFromTranscriptStall(stalledForMs);
        }
      }
    }

    // Send audio to active provider
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
  const providerApiKey = getProviderApiKey(settings);
  if (!providerApiKey) {
    console.error("No API key configured");
    debugLog(`${providerLabelForLogs()} start blocked: API key missing`, "WARN");
    return;
  }

  configureTranscriberFromSettings();

  isRecording = true;
  recordingStartedAt = Date.now();
  recordingChunkCount = 0;
  recordingApproxAudioBytes = 0;
  lastAudioProgressLogAt = recordingStartedAt;
  lastSpeechTime = 0;
  lastTypedLength = 0;
  lastTranscriptProgressChars = 0;
  lastTranscriptEventAt = recordingStartedAt;
  lastTranscriptStallWarnAt = 0;
  incrementalTypeCallCount = 0;
  incrementalTypeCharCount = 0;
  incrementalTypeFailureCount = 0;
  lastAudioTurnBoundaryAt = recordingStartedAt;
  audioTurnBoundaryCount = 0;
  recoveryInProgress = false;
  suppressAutoStopForRecovery = false;
  lastRecoveryAttemptAt = 0;
  recoveryAttemptCount = 0;
  recoverySuccessCount = 0;
  recoveryFailureCount = 0;
  overlayListeningReady = false;
  transcriber.resetTranscript();

  debugLog(
    `Starting recording: device='${settings.microphoneDeviceId}', loudness=${settings.recordingLoudness}%, typingMode='${settings.typingMode}', autoStop=${settings.autoStopOnSilence}, silenceMs=${settings.autoStopSilenceMs}`,
    "INFO"
  );

  // Show overlay in loading state immediately
  try {
    const overlay = await WebviewWindow.getByLabel("overlay");
    if (overlay) {
      await overlay.show();
      await overlay.emit("recording-started", { state: "loading" });
    }
  } catch (err) {
    console.error("Failed to show overlay:", err);
  }

  // Start audio capture first, then connect provider so early speech is buffered.
  try {
    await invoke("start_recording", {
      deviceId: settings.microphoneDeviceId,
      inputGain: settings.recordingLoudness / 100,
    });

    await transcriber.connect();
    debugLog(
      `${providerLabelForLogs()} session connected state after connect() call: ${transcriber.isConnected()}`,
      "INFO"
    );

    if (transcriber.isConnected() && !overlayListeningReady) {
      overlayListeningReady = true;
      await emitOverlayEvent("recording-ready", { state: "listening" });
    }

    const activeModel = transcriber.getActiveModel();
    settings.providers[settings.sttProvider].lastKnownGoodModel = activeModel;
    saveProviderLastKnownGoodModel(settings.sttProvider, activeModel).catch(() => {
      // ignore best-effort cache update failures
    });
    debugLog(`Recording started with device '${settings.microphoneDeviceId}'`, "INFO");
    debugLog(
      `Recording uses ${providerLabelForLogs()} model '${activeModel}'`,
      "INFO"
    );

    if (!transcriber.isConnected()) {
      debugLog(
        `${providerLabelForLogs()} disconnected immediately after recording start; stopping capture`,
        "WARN"
      );
      await stopRecording();
    }
  } catch (err) {
    console.error("Failed to start recording:", err);
    debugLog(`Failed to start recording: ${String(err)}`, "ERROR");
    isRecording = false;
    await emitOverlayEvent("recording-stopped", {});
  }
}

async function stopRecording() {
  isRecording = false;
  const stoppedAt = Date.now();
  const durationMs = recordingStartedAt > 0 ? stoppedAt - recordingStartedAt : 0;

  // Clear silence timer
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  // Stop audio capture
  try {
    await invoke("stop_recording");
    debugLog("Recording stopped", "INFO");
  } catch (err) {
    console.error("Failed to stop recording:", err);
    debugLog(`Failed to stop recording: ${String(err)}`, "ERROR");
  }

  // Small delay to let final transcription arrive
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Type the final text (all-at-once mode)
  const finalText = transcriber.getTranscript().trim();
  debugLog(
    `Stopping recording summary: duration=${durationMs}ms, chunks=${recordingChunkCount}, ~audioBytes=${recordingApproxAudioBytes}, transcriptChars=${finalText.length}, typedCalls=${incrementalTypeCallCount}, typedChars=${incrementalTypeCharCount}, typeFailures=${incrementalTypeFailureCount}, turnBoundaries=${audioTurnBoundaryCount}, recoveryAttempts=${recoveryAttemptCount}, recoverySuccess=${recoverySuccessCount}, recoveryFailures=${recoveryFailureCount}`,
    "INFO"
  );
  if (finalText) {
    debugLog(`Transcript preview: "${previewText(finalText)}"`, "INFO");
  } else {
    debugLog("Transcript is empty after stop", "WARN");
  }
  if (finalText && settings.typingMode === "all_at_once") {
    try {
      await invoke("type_text", { text: finalText });
      debugLog(`Typed final transcript (${finalText.length} chars)`, "INFO");
    } catch (err) {
      console.error("Failed to type text:", err);
      debugLog(`Failed to type text: ${String(err)}`, "ERROR");
    }
  }

  // Disconnect from provider
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

  recordingStartedAt = 0;
  recordingChunkCount = 0;
  recordingApproxAudioBytes = 0;
  lastAudioProgressLogAt = 0;
  lastTranscriptProgressChars = 0;
  lastTranscriptEventAt = 0;
  lastTranscriptStallWarnAt = 0;
  incrementalTypeCallCount = 0;
  incrementalTypeCharCount = 0;
  incrementalTypeFailureCount = 0;
  lastAudioTurnBoundaryAt = 0;
  audioTurnBoundaryCount = 0;
  recoveryInProgress = false;
  suppressAutoStopForRecovery = false;
  lastRecoveryAttemptAt = 0;
  recoveryAttemptCount = 0;
  recoverySuccessCount = 0;
  recoveryFailureCount = 0;
  overlayListeningReady = false;
}

async function recoverFromTranscriptStall(stalledForMs: number) {
  if (!isRecording || recoveryInProgress) {
    return;
  }

  recoveryInProgress = true;
  suppressAutoStopForRecovery = true;
  recoveryAttemptCount += 1;
  lastRecoveryAttemptAt = Date.now();

  debugLog(
    `Starting live recovery attempt #${recoveryAttemptCount} after transcript stall (${stalledForMs}ms without updates)`,
    "WARN"
  );

  try {
    await transcriber.reconnectForRecovery();
    if (!transcriber.isConnected()) {
      throw new Error(
        `${providerLabelForLogs()} recovery reconnect completed but session is not connected`
      );
    }

    recoverySuccessCount += 1;
    lastTranscriptEventAt = Date.now();
    lastTranscriptStallWarnAt = 0;
    lastAudioTurnBoundaryAt = Date.now();
    debugLog(
      `Live recovery attempt #${recoveryAttemptCount} succeeded`,
      "INFO"
    );
  } catch (err) {
    recoveryFailureCount += 1;
    debugLog(
      `Live recovery attempt #${recoveryAttemptCount} failed: ${String(err)}`,
      "ERROR"
    );

    if (isRecording) {
      debugLog(
        "Recovery failed while recording; stopping capture to avoid silent data loss",
        "ERROR"
      );
      await stopRecording().catch((stopErr) => {
        debugLog(`Failed to stop recording after recovery failure: ${String(stopErr)}`, "ERROR");
      });
    }
  } finally {
    suppressAutoStopForRecovery = false;
    recoveryInProgress = false;
  }
}

function onTranscript(text: string, _isFinal: boolean) {
  const now = Date.now();
  const msSincePreviousUpdate =
    lastTranscriptEventAt > 0 ? now - lastTranscriptEventAt : 0;

  if (
    isRecording &&
    isDebugLoggingEnabled() &&
    lastTranscriptStallWarnAt > 0 &&
    msSincePreviousUpdate >= TRANSCRIPT_STALL_WARN_MS
  ) {
    debugLog(
      `Transcript watchdog recovered after ${msSincePreviousUpdate}ms without updates (transcriptChars=${text.length})`,
      "INFO"
    );
  }

  lastTranscriptEventAt = now;
  lastTranscriptStallWarnAt = 0;

  // Emit to overlay for display
  emit("transcript-update", { text });

  if (
    isRecording &&
    isDebugLoggingEnabled() &&
    text.length >= lastTranscriptProgressChars + 40
  ) {
    debugLog(`Transcript growth: ${text.length} chars`, "INFO");
    lastTranscriptProgressChars = text.length;
  }

  // Incremental typing mode
  if (settings.typingMode === "incremental" && isRecording) {
    const newText = text.slice(lastTypedLength);
    if (newText.length > 0) {
      const callIndex = incrementalTypeCallCount + 1;
      const typedChars = newText.length;
      const typedStartedAt = Date.now();

      incrementalTypeCallCount = callIndex;
      incrementalTypeCharCount += typedChars;

      if (isDebugLoggingEnabled()) {
        debugLog(
          `Typing incremental chunk #${callIndex}: +${typedChars} chars (typedTotal=${incrementalTypeCharCount}, transcriptTotal=${text.length})`,
          "INFO"
        );
      }

      // In incremental mode, we type new characters as they arrive
      // We don't use backspaces for now since transcription is append-only
      // from the inputAudioTranscription stream
      invoke("type_text", { text: newText })
        .then(() => {
          if (isDebugLoggingEnabled()) {
            debugLog(
              `Typed incremental chunk #${callIndex} in ${Date.now() - typedStartedAt}ms (+${typedChars} chars)`,
              "INFO"
            );
          }
        })
        .catch((err) => {
          incrementalTypeFailureCount += 1;
          console.error("Incremental type failed:", err);
          debugLog(
            `Incremental type failed for chunk #${callIndex} after ${Date.now() - typedStartedAt}ms: ${String(err)}`,
            "ERROR"
          );
        });
      lastTypedLength = text.length;
    }
  }
}

function onStatus(
  status: "connecting" | "connected" | "disconnected" | "error",
  message?: string
) {
  debugLog(
    `${providerLabelForLogs()} status: ${status}${message ? ` (${message})` : ""}`,
    status === "error" ? "ERROR" : "INFO"
  );
  emit("stt-status", { status, message, provider: settings.sttProvider });
  emit("gemini-status", { status, message });

  if (status === "connected" && isRecording && !overlayListeningReady) {
    overlayListeningReady = true;
    void emitOverlayEvent("recording-ready", { state: "listening" });
  }

  if (
    (status === "disconnected" || status === "error") &&
    isRecording &&
    !suppressAutoStopForRecovery &&
    !stoppingDueToDisconnect
  ) {
    stoppingDueToDisconnect = true;
    debugLog(`${providerLabelForLogs()} dropped during recording; auto-stopping capture`, "WARN");
    stopRecording()
      .catch((err) => {
        debugLog(`Auto-stop after disconnect failed: ${String(err)}`, "ERROR");
      })
      .finally(() => {
        stoppingDueToDisconnect = false;
      });
  }
}

export function reloadSettings(newSettings: Settings) {
  const oldHotkey = settings.hotkey;
  settings = newSettings;

  // Reconfigure transcriber
  configureTranscriberFromSettings();

  // Re-register hotkey if changed
  if (oldHotkey !== settings.hotkey) {
    unregister(oldHotkey).then(() => registerHotkey(settings.hotkey));
  }
}
