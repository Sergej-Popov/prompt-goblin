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
  saveCorrectionProviderLastKnownGoodModel,
  saveProviderLastKnownGoodModel,
  type Settings,
} from "./settings";
import { debugLog, isDebugLoggingEnabled } from "./logger";
import {
  getCorrectionFallbackModels,
  getCorrectionLabel,
  getCorrectionRuntime,
  getCorrectionSelectedModel,
  isTranscriptionCorrectionEnabled,
} from "./correction/service";
import { processIncrementalTranscriptUpdate } from "./incremental-typing";
import {
  createLiveTranscriber,
  getProviderAuth,
  getProviderFallbackModels,
  getProviderLabel,
  getProviderSelectedModel,
} from "./stt/service";
import type { LiveTranscriber } from "./stt/types";
import { applyTextCommands, getCommandTailGuardChars } from "./text-commands";
import { escapeWhitespaceForLog } from "./string-utils";

let isRecording = false;
let settings: Settings;
let transcriber: LiveTranscriber = createLiveTranscriber("gemini");
let activeProvider: Settings["sttProvider"] = "gemini";
let overlayListeningReady = false;
let pttKeyHeld = false;

// Silence detection state
let lastSpeechTime = 0;
let silenceTimer: ReturnType<typeof setTimeout> | null = null;

// Incremental tail flush state
let incrementalTailFlushTimer: ReturnType<typeof setTimeout> | null = null;

// Incremental typing state
let lastTypedLength = 0;
let latestRawTranscript = "";
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
let sessionOutcome: "typed" | "clipboard_only" | "typed_and_clipboard" | "fallback_clipboard" | "cancelled" | "empty" | "failed" = "empty";
let latestMicRms = 0;
let connectedAt = 0;
let firstTranscriptAt = 0;
let estimatedConfidencePct = 0;
let hudLastEmitAt = 0;

const TRANSCRIPT_STALL_WARN_MS = 5000;
const TRANSCRIPT_STALL_WARN_LOG_INTERVAL_MS = 5000;
const STALL_RECOVERY_TRIGGER_MS = 8500;
const STALL_RECOVERY_COOLDOWN_MS = 12000;
const PERIODIC_AUDIO_TURN_BOUNDARY_MS = 12000;
const OPENAI_PERIODIC_AUDIO_TURN_BOUNDARY_MS = 2500;
const HUD_EMIT_INTERVAL_MS = 180;
const INCREMENTAL_TAIL_FLUSH_MS = 800;
const COMMAND_TAIL_GUARD_CHARS = getCommandTailGuardChars();

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
  const auth = getProviderAuth(settings);
  if (!auth) {
    return;
  }

  transcriber.configure({
    auth,
    language: settings.language,
    preferredModel: getProviderSelectedModel(settings),
    fallbackModels: getProviderFallbackModels(settings),
  });
}

function providerLabelForLogs(): string {
  return getProviderLabel(settings.sttProvider);
}

function getPeriodicAudioTurnBoundaryMs(): number {
  return settings.sttProvider === "openai"
    ? OPENAI_PERIODIC_AUDIO_TURN_BOUNDARY_MS
    : PERIODIC_AUDIO_TURN_BOUNDARY_MS;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function estimateConfidence(
  transcriptLength: number,
  msSincePreviousUpdate: number,
  isFinal: boolean
): number {
  let score = 0.3;
  score += Math.min(0.35, transcriptLength / 240);
  score += Math.min(0.18, latestMicRms / 0.07);

  if (msSincePreviousUpdate > 0 && msSincePreviousUpdate <= 1400) {
    score += 0.12;
  } else if (msSincePreviousUpdate <= 2800) {
    score += 0.06;
  }

  if (isFinal) {
    score += 0.08;
  }

  if (recoveryInProgress) {
    score -= 0.12;
  }

  return Math.round(clamp(score, 0.05, 0.99) * 100);
}

function computeHudLatencyMs(now = Date.now()): number | null {
  if (recordingStartedAt <= 0) {
    return null;
  }
  if (firstTranscriptAt > 0) {
    return Math.max(0, firstTranscriptAt - recordingStartedAt);
  }
  if (connectedAt > 0) {
    return Math.max(0, connectedAt - recordingStartedAt);
  }
  return Math.max(0, now - recordingStartedAt);
}

function emitHudUpdate(force = false) {
  if (!isRecording) {
    return;
  }

  const now = Date.now();
  if (!force && now - hudLastEmitAt < HUD_EMIT_INTERVAL_MS) {
    return;
  }

  hudLastEmitAt = now;
  const latencyMs = computeHudLatencyMs(now);
  const activeModel = transcriber.getActiveModel();

  void emitOverlayEvent("recording-hud-update", {
    provider: providerLabelForLogs(),
    model: activeModel,
    latencyMs,
    confidencePct: estimatedConfidencePct,
    confidenceMode: "estimated",
    debugEnabled: isDebugLoggingEnabled(),
    waveformStyle: settings.waveformStyle,
    waveformColorScheme: settings.waveformColorScheme,
  });
}

function emitOverlayHudModel(provider: string, model: string) {
  void emitOverlayEvent("recording-hud-update", {
    provider,
    model,
    latencyMs: computeHudLatencyMs(),
    confidencePct: estimatedConfidencePct,
    confidenceMode: "estimated",
    debugEnabled: isDebugLoggingEnabled(),
    waveformStyle: settings.waveformStyle,
    waveformColorScheme: settings.waveformColorScheme,
  });
}

/**
 * Returns true if the difference between two strings is "meaningful" —
 * length diff > 5 OR the strings differ by >10% of the longer string length.
 */
function isMeaningfulDiff(a: string, b: string): boolean {
  if (a === b) return false
  const lenDiff = Math.abs(a.length - b.length)
  if (lenDiff > 5) return true
  const longer = Math.max(a.length, b.length)
  if (longer === 0) return false
  return lenDiff / longer > 0.1
}

async function waitForReviewDecision(
  finalText: string,
  correctionChanged: boolean,
  timeoutMs: number
): Promise<"confirmed" | "cancelled"> {
  return new Promise((resolve) => {
    let settled = false
    let countdownTimer: ReturnType<typeof setTimeout> | null = null
    let unlistenConfirm: (() => void) | null = null
    let unlistenCancel: (() => void) | null = null

    const settle = (outcome: "confirmed" | "cancelled") => {
      if (settled) return
      settled = true
      if (countdownTimer) {
        clearTimeout(countdownTimer)
        countdownTimer = null
      }
      unlistenConfirm?.()
      unlistenCancel?.()
      resolve(outcome)
    }

    // Register listeners — listen() returns an unlisten function via a Promise
    listen<Record<string, never>>("review-confirmed", () => {
      settle("confirmed")
    }).then((unlisten) => {
      unlistenConfirm = unlisten
      // If already settled (e.g., timeout fired before listen resolved), clean up immediately
      if (settled) unlisten()
    }).catch(() => {})

    listen<Record<string, never>>("review-cancelled", () => {
      settle("cancelled")
    }).then((unlisten) => {
      unlistenCancel = unlisten
      if (settled) unlisten()
    }).catch(() => {})

    // Auto-confirm countdown
    if (timeoutMs > 0) {
      countdownTimer = setTimeout(() => {
        countdownTimer = null
        settle("confirmed")
      }, timeoutMs)
    }

    // Emit the review event to the overlay after setting up listeners
    void emitOverlayEvent("recording-review", {
      text: finalText,
      correctionChanged,
      timeoutMs,
    })
  })
}

function processFinalTranscriptForTyping(text: string): string {
  return applyTextCommands(text, settings).trim()
}

function typeText(text: string) {
  return invoke("type_text", { text, lineBreakMode: settings.lineBreakMode });
}

function copyToClipboard(text: string) {
  return invoke("copy_to_clipboard", { text });
}

async function deliverTranscript(finalText: string): Promise<void> {
  if (!finalText) {
    return;
  }

  const mode = settings.clipboardMode;

  // clipboard_only: skip typing, just copy
  if (mode === "clipboard_only") {
    try {
      await copyToClipboard(finalText);
      sessionOutcome = "clipboard_only";
      debugLog(`Transcript copied to clipboard (clipboard_only, ${finalText.length} chars)`, "INFO");
      void emitOverlayEvent("session-toast", { message: "Text copied to clipboard. Paste to insert." });
    } catch (err) {
      debugLog(`Failed to copy to clipboard: ${String(err)}`, "ERROR");
    }
    return;
  }

  // typing_and_clipboard: type AND copy
  if (mode === "typing_and_clipboard") {
    try {
      await typeText(finalText);
      sessionOutcome = "typed_and_clipboard";
      debugLog(`Typed transcript (typing_and_clipboard, ${finalText.length} chars)`, "INFO");
    } catch (err) {
      debugLog(`Failed to type text (typing_and_clipboard): ${String(err)}`, "ERROR");
    }
    try {
      await copyToClipboard(finalText);
      debugLog(`Transcript also copied to clipboard (typing_and_clipboard)`, "INFO");
    } catch (err) {
      debugLog(`Failed to copy to clipboard (typing_and_clipboard): ${String(err)}`, "ERROR");
    }
    return;
  }

  // typing_with_fallback: try typing, fall back to clipboard on error
  if (mode === "typing_with_fallback") {
    try {
      await typeText(finalText);
      sessionOutcome = "typed";
      debugLog(`Typed transcript (typing_with_fallback, ${finalText.length} chars)`, "INFO");
    } catch (err) {
      debugLog(`Typing failed (typing_with_fallback): ${String(err)}; falling back to clipboard`, "WARN");
      try {
        await copyToClipboard(finalText);
        sessionOutcome = "fallback_clipboard";
        debugLog(`Fallback clipboard copy succeeded (${finalText.length} chars)`, "INFO");
        void emitOverlayEvent("session-toast", { message: "Typing failed — text copied to clipboard. Paste to insert." });
      } catch (clipErr) {
        debugLog(`Fallback clipboard copy also failed: ${String(clipErr)}`, "ERROR");
      }
    }
    return;
  }

  // typing_only (default): type only, no clipboard
  try {
    await typeText(finalText);
    sessionOutcome = "typed";
    debugLog(`Typed transcript (typing_only, ${finalText.length} chars)`, "INFO");
  } catch (err) {
    sessionOutcome = "failed";
    debugLog(`Failed to type text: ${String(err)}`, "ERROR");
  }
}

function buildModelCandidates(preferredModel: string, fallbackModels: string[]): string[] {
  const unique = new Set<string>();
  for (const model of [preferredModel, ...fallbackModels]) {
    const normalized = model.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

async function maybeCorrectFinalTranscript(text: string): Promise<string> {
  if (!text || settings.typingMode !== "all_at_once" || !isTranscriptionCorrectionEnabled(settings)) {
    return text;
  }

  const auth = getProviderAuth(settings);
  const correctionModel = getCorrectionSelectedModel(settings);
  if (!auth || !correctionModel) {
    return text;
  }

  const provider = settings.sttProvider;
  const authMode = settings.providers.openai.authMode;
  const runtime = getCorrectionRuntime(provider, authMode);
  const candidates = buildModelCandidates(correctionModel, getCorrectionFallbackModels(settings));
  let lastError: unknown = null;

  void emitOverlayProcessingState(getOverlayCorrectionLabel());

  debugLog(
    `Starting transcript correction with ${runtime.label} (${candidates.length} candidate model${candidates.length === 1 ? "" : "s"})`,
    "INFO"
  );

  for (const candidate of candidates) {
    try {
      const corrected = (
        await runtime.correctText(
          auth,
          candidate,
          text,
          settings.language,
          settings.targetLanguage
        )
      ).trim();
      if (!corrected) {
        continue;
      }

      settings.transcriptionCorrection.providers[provider].lastKnownGoodModel = candidate;
      saveCorrectionProviderLastKnownGoodModel(provider, candidate).catch(() => {
        // ignore best-effort cache update failures
      });
      debugLog(`Transcript correction succeeded with ${runtime.label} model '${candidate}'`, "INFO");
      return corrected;
    } catch (err) {
      lastError = err;
      debugLog(
        `Transcript correction failed with ${runtime.label} model '${candidate}': ${String(err)}`,
        "WARN"
      );
    }
  }

  if (lastError) {
    debugLog(`Transcript correction skipped after failure: ${String(lastError)}`, "WARN");
  }
  return text;
}

function shouldShowTranslationLabel(): boolean {
  return Boolean(
    settings.targetLanguage &&
      settings.targetLanguage !== "auto" &&
      settings.language !== "auto" &&
      settings.targetLanguage !== settings.language
  );
}

function getOverlayCorrectionLabel(): string {
  return shouldShowTranslationLabel() ? "Correcting and Translating..." : "Correcting...";
}

function emitOverlayProcessingState(label: string): Promise<void> {
  if (label.startsWith("Correcting")) {
    emitOverlayHudModel(getCorrectionLabel(settings.sttProvider, settings.providers.openai.authMode), getCorrectionSelectedModel(settings));
  } else {
    emitOverlayHudModel(providerLabelForLogs(), transcriber.getActiveModel());
  }

  return emitOverlayEvent("recording-phase", {
    state: label.startsWith("Correcting") ? "correcting" : "transcribing",
    label,
  });
}

function processIncrementalTranscriptForTyping(text: string, isFinal: boolean): string {
  const update = processIncrementalTranscriptUpdate(
    text,
    isFinal,
    settings,
    COMMAND_TAIL_GUARD_CHARS,
    { lastTypedLength, latestRawTranscript }
  );

  lastTypedLength = update.lastTypedLength;
  latestRawTranscript = update.latestRawTranscript;

  return update.newText;
}

/**
 * Flushes the held-back guard tail in incremental typing mode.
 * Called after a short idle period (no new transcript updates) so the user
 * doesn't have to wait for auto-stop to see the last ~60 chars.
 */
function flushIncrementalTail() {
  incrementalTailFlushTimer = null;

  if (!isRecording || settings.typingMode !== "incremental") {
    return;
  }

  const tailText = processIncrementalTranscriptForTyping(latestRawTranscript, true);
  if (!tailText) {
    return;
  }

  const callIndex = incrementalTypeCallCount + 1;
  incrementalTypeCallCount = callIndex;
  incrementalTypeCharCount += tailText.length;

  debugLog(
    `Flushing incremental tail after ${INCREMENTAL_TAIL_FLUSH_MS}ms idle: +${tailText.length} chars (typedTotal=${incrementalTypeCharCount})`,
    "INFO"
  );

  typeText(tailText).catch((err) => {
    incrementalTypeFailureCount += 1;
    debugLog(
      `Incremental tail flush type failed: ${String(err)}`,
      "ERROR"
    );
  });
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
    latestMicRms = rms;

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
        transcriber.isConnected() &&
        !recoveryInProgress &&
        recordingChunkCount >= 200 &&
        now - lastAudioTurnBoundaryAt >= getPeriodicAudioTurnBoundaryMs()
      ) {
        if (transcriber.signalAudioStreamBoundary("periodic")) {
          audioTurnBoundaryCount += 1;
          lastAudioTurnBoundaryAt = now;
          if (isDebugLoggingEnabled()) {
            debugLog(
              `Periodic audio turn boundary #${audioTurnBoundaryCount} sent at ${Math.max(0, now - recordingStartedAt)}ms`,
              "INFO"
            );
          }
        }
      }

      if (
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

        if (settings.sttProvider === "openai" && transcriber.isConnected() && !recoveryInProgress) {
          const forced = transcriber.signalAudioStreamBoundary("stall-watchdog");
          if (forced) {
            audioTurnBoundaryCount += 1;
            lastAudioTurnBoundaryAt = now;
            debugLog("OpenAI stall watchdog forced an audio turn boundary", "WARN");
          }
        }

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

    if (isRecording) {
      emitHudUpdate();
    }

    // Silence detection for auto-stop
    if (settings.autoStopOnSilence && isRecording && settings.recordingMode !== "push_to_talk") {
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
          if (isRecording && !suppressAutoStopForRecovery) {
            stopRecording();
          }
        }, settings.autoStopSilenceMs);
      }
    }
  });

  // Register global hotkey
  await registerHotkey(settings.hotkey);

  // Register Escape as cancel-recording key
  try {
    const escAlreadyRegistered = await isRegistered("Escape");
    if (escAlreadyRegistered) {
      await unregister("Escape");
    }
    await register("Escape", (event) => {
      if (event.state === "Pressed" && isRecording) {
        void cancelRecording();
      }
    });
  } catch (err) {
    console.error("Failed to register Escape cancel hotkey:", err);
  }
}

async function registerHotkey(hotkey: string) {
  try {
    const alreadyRegistered = await isRegistered(hotkey);
    if (alreadyRegistered) {
      await unregister(hotkey);
    }
    await register(hotkey, (event) => {
      if (settings.recordingMode === "push_to_talk") {
        if (event.state === "Pressed") {
          if (!isRecording && !pttKeyHeld) {
            pttKeyHeld = true;
            void startRecording();
          }
        } else if (event.state === "Released") {
          pttKeyHeld = false;
          if (isRecording) {
            void stopRecording();
          }
        }
      } else {
        if (event.state === "Pressed") {
          void toggleRecording();
        }
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
  const providerAuth = getProviderAuth(settings);
  if (!providerAuth) {
    console.error("No provider credentials configured");
    debugLog(`${providerLabelForLogs()} start blocked: credentials missing`, "WARN");
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
  latestRawTranscript = "";
  lastTranscriptProgressChars = 0;
  lastTranscriptEventAt = recordingStartedAt;
  lastTranscriptStallWarnAt = 0;
  incrementalTypeCallCount = 0;
  incrementalTypeCharCount = 0;
  incrementalTypeFailureCount = 0;
  sessionOutcome = "empty";
  lastAudioTurnBoundaryAt = recordingStartedAt;
  audioTurnBoundaryCount = 0;
  recoveryInProgress = false;
  suppressAutoStopForRecovery = false;
  lastRecoveryAttemptAt = 0;
  recoveryAttemptCount = 0;
  recoverySuccessCount = 0;
  recoveryFailureCount = 0;
  latestMicRms = 0;
  connectedAt = 0;
  firstTranscriptAt = 0;
  estimatedConfidencePct = 0;
  hudLastEmitAt = 0;
  overlayListeningReady = false;
  if (incrementalTailFlushTimer) {
    clearTimeout(incrementalTailFlushTimer);
    incrementalTailFlushTimer = null;
  }
  transcriber.resetTranscript();

    debugLog(
      `Starting recording: device='${settings.microphoneDeviceId}', loudness=${settings.recordingLoudness}%, typingMode='${settings.typingMode}', lineBreakMode='${settings.lineBreakMode}', autoStop=${settings.autoStopOnSilence}, silenceMs=${settings.autoStopSilenceMs}`,
      "INFO"
    );

  // Show overlay in loading state immediately
  try {
    const overlay = await WebviewWindow.getByLabel("overlay");
    if (overlay) {
      await overlay.show();
      await overlay.emit("recording-started", {
        state: "loading",
        playListeningDing: settings.playListeningDing,
        listeningDingSound: settings.listeningDingSound,
        listeningDingVolume: settings.listeningDingVolume,
        waveformStyle: settings.waveformStyle,
        waveformColorScheme: settings.waveformColorScheme,
      });
      await overlay.emit("recording-hud-update", {
        provider: providerLabelForLogs(),
        model: "",
        latencyMs: null,
        confidencePct: 0,
        confidenceMode: "estimated",
        debugEnabled: isDebugLoggingEnabled(),
        waveformStyle: settings.waveformStyle,
        waveformColorScheme: settings.waveformColorScheme,
      });
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

  // Clear incremental tail flush timer (stopRecording handles the final flush)
  if (incrementalTailFlushTimer) {
    clearTimeout(incrementalTailFlushTimer);
    incrementalTailFlushTimer = null;
  }

  // Stop audio capture
  await emitOverlayProcessingState("Transcribing...");

  try {
    await invoke("stop_recording");
    debugLog("Recording stopped", "INFO");
  } catch (err) {
    console.error("Failed to stop recording:", err);
    debugLog(`Failed to stop recording: ${String(err)}`, "ERROR");
  }

  // Wait for any pending transcription turn to settle (or timeout after 1500ms)
  await transcriber.waitForPendingTurnSettle(1500);

  // Type the final text (all-at-once mode)
  const finalRawText = transcriber.getTranscript().trim();
  const correctedRawText = await maybeCorrectFinalTranscript(finalRawText);
  const finalText = processFinalTranscriptForTyping(correctedRawText);
  if (finalText) {
    debugLog(
      `Transcript preview: "${previewText(finalText)}" (raw: "${escapeWhitespaceForLog(finalText)}")`,
      "INFO"
    );
  } else {
    debugLog("Transcript is empty after stop", "WARN");
  }
  if (finalText && settings.typingMode === "all_at_once") {
    if (settings.holdBeforeType && finalText) {
      const correctionChanged = isMeaningfulDiff(finalRawText, correctedRawText)
      const decision = await waitForReviewDecision(
        finalText,
        correctionChanged,
        settings.holdBeforeTypeTimeoutMs
      )
      if (decision === "confirmed") {
        await deliverTranscript(finalText)
      } else {
        sessionOutcome = "cancelled"
      }
    } else {
      await deliverTranscript(finalText)
    }
  }

  if (settings.typingMode === "incremental") {
    const tailText = processIncrementalTranscriptForTyping(latestRawTranscript, true);
    if (tailText) {
      try {
        await typeText(tailText);
        incrementalTypeCallCount += 1;
        incrementalTypeCharCount += tailText.length;
      } catch (err) {
        incrementalTypeFailureCount += 1;
        debugLog(`Failed to type final incremental tail: ${String(err)}`, "ERROR");
      }
    }

    // If any incremental chunks failed to type, fall back to clipboard with the full transcript
    if (incrementalTypeFailureCount > 0) {
      const mode = settings.clipboardMode;
      if (mode === "typing_with_fallback" || mode === "typing_and_clipboard" || mode === "clipboard_only") {
        const fullText = processFinalTranscriptForTyping(transcriber.getTranscript().trim());
        if (fullText) {
          try {
            await copyToClipboard(fullText);
            sessionOutcome = mode === "typing_and_clipboard" ? "typed_and_clipboard" : "fallback_clipboard";
            debugLog(`Incremental typing had ${incrementalTypeFailureCount} failure(s); full transcript copied to clipboard as fallback`, "WARN");
            if (mode !== "typing_and_clipboard") {
              void emitOverlayEvent("session-toast", { message: "Typing failed — text copied to clipboard. Paste to insert." });
            }
          } catch (clipErr) {
            sessionOutcome = "failed";
            debugLog(`Incremental fallback clipboard copy failed: ${String(clipErr)}`, "ERROR");
          }
        }
      } else {
        sessionOutcome = "failed";
      }
    } else if (incrementalTypeCharCount > 0) {
      sessionOutcome = "typed";
    }
  }

  debugLog(
    `Session summary: outcome=${sessionOutcome}, deliveryMode=${settings.clipboardMode}, duration=${durationMs}ms, transcriptChars=${finalRawText.length}, deliveredChars=${finalText.length}, typedCalls=${incrementalTypeCallCount}, typedChars=${incrementalTypeCharCount}, typeFailures=${incrementalTypeFailureCount}, chunks=${recordingChunkCount}, ~audioBytes=${recordingApproxAudioBytes}, turnBoundaries=${audioTurnBoundaryCount}, recoveryAttempts=${recoveryAttemptCount}, recoverySuccess=${recoverySuccessCount}, recoveryFailures=${recoveryFailureCount}`,
    "INFO"
  );

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
  latestMicRms = 0;
  connectedAt = 0;
  firstTranscriptAt = 0;
  estimatedConfidencePct = 0;
  hudLastEmitAt = 0;
  overlayListeningReady = false;
}

async function cancelRecording() {
  if (!isRecording) {
    return;
  }

  isRecording = false;
  debugLog("Recording cancelled by user — transcript discarded", "INFO");
  sessionOutcome = "cancelled";
  const cancelDurationMs = recordingStartedAt > 0 ? Date.now() - recordingStartedAt : 0;
  debugLog(
    `Session summary: outcome=cancelled, deliveryMode=${settings.clipboardMode}, duration=${cancelDurationMs}ms, transcriptChars=${latestRawTranscript.length}, chunks=${recordingChunkCount}`,
    "INFO"
  );

  // Clear timers
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (incrementalTailFlushTimer) {
    clearTimeout(incrementalTailFlushTimer);
    incrementalTailFlushTimer = null;
  }

  // Stop audio capture
  try {
    await invoke("stop_recording");
  } catch (err) {
    debugLog(`Failed to stop recording on cancel: ${String(err)}`, "ERROR");
  }

  // Disconnect without waiting for pending transcript
  await transcriber.disconnect();

  // Emit cancelled event to overlay
  try {
    const overlay = await WebviewWindow.getByLabel("overlay");
    if (overlay) {
      await overlay.emit("recording-cancelled", {});
      setTimeout(async () => {
        try {
          await overlay.hide();
        } catch {
          // ignore
        }
      }, 300);
    }
  } catch {
    // best-effort
  }

  // Reset counters (same as stopRecording)
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
  latestMicRms = 0;
  connectedAt = 0;
  firstTranscriptAt = 0;
  estimatedConfidencePct = 0;
  hudLastEmitAt = 0;
  overlayListeningReady = false;
  pttKeyHeld = false;
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

function onTranscript(text: string, isFinal: boolean) {
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
  latestRawTranscript = text;

  if (firstTranscriptAt === 0 && text.trim().length > 0) {
    firstTranscriptAt = now;
  }

  estimatedConfidencePct = estimateConfidence(text.length, msSincePreviousUpdate, isFinal);
  emitHudUpdate(true);

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
    const newText = processIncrementalTranscriptForTyping(text, isFinal);
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
      typeText(newText)
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
    }

    // Reset the tail flush timer. When no new transcript updates arrive
    // for INCREMENTAL_TAIL_FLUSH_MS, flush the held-back guard chars
    // so the user doesn't wait for auto-stop to see the last words.
    if (!isFinal) {
      if (incrementalTailFlushTimer) {
        clearTimeout(incrementalTailFlushTimer);
      }
      incrementalTailFlushTimer = setTimeout(flushIncrementalTail, INCREMENTAL_TAIL_FLUSH_MS);
    } else {
      // isFinal already typed everything (no guard holdback), no flush needed
      if (incrementalTailFlushTimer) {
        clearTimeout(incrementalTailFlushTimer);
        incrementalTailFlushTimer = null;
      }
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
    if (connectedAt === 0) {
      connectedAt = Date.now();
    }
    overlayListeningReady = true;
    void emitOverlayEvent("recording-ready", { state: "listening" });
    emitHudUpdate(true);
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
  const oldRecordingMode = settings.recordingMode;
  settings = newSettings;

  void emitOverlayEvent("overlay-settings-updated", {
    playListeningDing: settings.playListeningDing,
    listeningDingSound: settings.listeningDingSound,
    listeningDingVolume: settings.listeningDingVolume,
    waveformStyle: settings.waveformStyle,
    waveformColorScheme: settings.waveformColorScheme,
  });

  // Reconfigure transcriber
  configureTranscriberFromSettings();

  // Re-register hotkey if changed
  if (oldHotkey !== settings.hotkey || oldRecordingMode !== settings.recordingMode) {
    unregister(oldHotkey).then(() => registerHotkey(settings.hotkey));
  }
}
