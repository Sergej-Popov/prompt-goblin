import {
  getDefaultSettings,
  getProviderApiKey as getProviderApiKeyFromSettings,
  getProviderLastKnownGoodModel,
  getProviderModelCache,
  getProviderSelectedModel,
  loadSettings,
  saveProviderLastKnownGoodModel,
  saveProviderModelCache,
  saveSettings,
  type SttProvider,
  type Settings,
} from "./settings";
import { initApp, reloadSettings } from "./app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  configureDebugLogging,
  debugLog,
  isDebugLoggingEnabled,
  openDebugLogFolder,
} from "./logger";
import {
  getProviderLabel,
  getProviderRuntime,
} from "./stt/service";
import {
  getMainDom,
  populateLiveModelOptions as renderLiveModelOptions,
  populateUI as renderUI,
  setLiveModelHint as renderLiveModelHint,
  updateConnectionStatus as renderConnectionStatus,
  updateTypingModeHint as renderTypingModeHint,
  type ConnectionStatus,
  type MainDom,
} from "./main/dom";
import { wavToPcmChunksBase64 } from "./main/audio";
import {
  MODEL_CACHE_TTL_MS,
  isModelCacheFresh,
  selectPreferredModel,
} from "./main/model-cache";
import { base64ToBytes, fingerprintApiKey, normalizeHotkey } from "./main/utils";

// ── DOM Elements ────────────────────────────────────────────

let apiKeyInput: HTMLInputElement;
let sttProviderSelect: HTMLSelectElement;
let hotkeyInput: HTMLInputElement;
let liveModelSelect: HTMLSelectElement;
let refreshModelsBtn: HTMLButtonElement;
let liveModelHint: HTMLElement;
let microphoneSelect: HTMLSelectElement;
let recordingLoudnessInput: HTMLInputElement;
let recordingLoudnessValue: HTMLElement;
let refreshMicrophonesBtn: HTMLButtonElement;
let micTestBtn: HTMLButtonElement;
let micTestStatus: HTMLElement;
let micTestTranscript: HTMLElement;
let micSignalIndicator: HTMLElement;
let micWaveCanvas: HTMLCanvasElement;
let debugLoggingCheckbox: HTMLInputElement;
let openDebugFolderBtn: HTMLButtonElement;
let debugLogPath: HTMLElement;
let toggleKeyBtn: HTMLButtonElement;
let apiKeyHelpBtn: HTMLButtonElement;
let apiKeyHelpModal: HTMLElement;
let closeApiKeyHelpBtn: HTMLButtonElement;
let connectionStatus: HTMLElement;
let testApiKeyBtn: HTMLButtonElement;
let typingModeRadios: NodeListOf<HTMLInputElement>;
let typingModeHint: HTMLElement;
let autoStopCheckbox: HTMLInputElement;
let silenceTimeoutField: HTMLElement;
let silenceTimeoutInput: HTMLInputElement;
let languageSelect: HTMLSelectElement;
let resetDefaultsBtn: HTMLButtonElement;
let saveStatus: HTMLElement;
let windowMinimizeBtn: HTMLButtonElement | null;
let windowCloseBtn: HTMLButtonElement;
let dom: MainDom;

let currentSettings: Settings;
let lastTestedApiKey = "";

interface InputDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

let micTestActive = false;
let micTestStartedAt = 0;
let micTestAutoStopTimer: number | null = null;
let micTestStopInProgress = false;
let targetMicLevel = 0;
let displayedMicLevel = 0;
let micPhase = 0;
let micWaveRaf = 0;
let lastMicTestPlaybackUrl: string | null = null;
let lastMicTestAudio: HTMLAudioElement | null = null;
const MIC_ACTIVITY_RMS_THRESHOLD = 0.01;
const MIC_TEST_DURATION_MS = 5000;
const AUTOSAVE_DEBOUNCE_MS = 450;

function getActiveProvider(): SttProvider {
  return sttProviderSelect.value === "openai" ? "openai" : "gemini";
}

function getActiveProviderRuntime() {
  return getProviderRuntime(getActiveProvider());
}

function getActiveProviderLabel(): string {
  return getProviderLabel(getActiveProvider());
}

function updateApiKeyTextForProvider() {
  const provider = getActiveProvider();
  const keySectionTitle = document.querySelector(
    ".settings-section .section-heading-row h2"
  ) as HTMLElement | null;
  if (keySectionTitle) {
    keySectionTitle.textContent = `${getProviderLabel(provider).toUpperCase()} API KEY`;
  }
  apiKeyInput.placeholder = `Paste your ${getProviderLabel(provider)} API key...`;
}

let autosaveTimer: number | null = null;
let saveStatusTimer: number | null = null;
let saveInFlight = false;
let savePending = false;

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
  }
});

window.addEventListener("DOMContentLoaded", async () => {
  dom = getMainDom(document);
  ({
    apiKeyInput,
    sttProviderSelect,
    hotkeyInput,
    liveModelSelect,
    refreshModelsBtn,
    liveModelHint,
    microphoneSelect,
    recordingLoudnessInput,
    recordingLoudnessValue,
    refreshMicrophonesBtn,
    micTestBtn,
    micTestStatus,
    micTestTranscript,
    micSignalIndicator,
    micWaveCanvas,
    debugLoggingCheckbox,
    openDebugFolderBtn,
    debugLogPath,
    toggleKeyBtn,
    apiKeyHelpBtn,
    apiKeyHelpModal,
    closeApiKeyHelpBtn,
    connectionStatus,
    testApiKeyBtn,
    typingModeRadios,
    typingModeHint,
    autoStopCheckbox,
    silenceTimeoutField,
    silenceTimeoutInput,
    languageSelect,
    resetDefaultsBtn,
    saveStatus,
    windowMinimizeBtn,
    windowCloseBtn,
  } = dom);

  // Load settings
  currentSettings = await loadSettings();
  populateUI(currentSettings);
  updateApiKeyTextForProvider();
  await refreshLiveModelList(false);
  await refreshMicrophoneList(currentSettings.microphoneDeviceId);
  await configureDebugLogging(currentSettings.debugLoggingEnabled);
  updateDebugLogHint();
  setupMicWave();

  // Set up event listeners
  setupEventListeners();

  // Initialize the app (hotkey, audio listener, etc.)
  await initApp();

  // Update status based on API key
  updateConnectionStatus(
    getProviderApiKeyFromSettings(currentSettings, currentSettings.sttProvider)
      ? "untested"
      : "disconnected"
  );
  testApiKeyBtn.disabled = !getProviderApiKeyFromSettings(currentSettings, currentSettings.sttProvider);

  // Listen for status updates from the app
  await listen<{ status: string; message?: string; provider?: SttProvider }>(
    "stt-status",
    (event) => {
      updateConnectionStatus(
        event.payload.status as
          | "connected"
          | "disconnected"
          | "error"
          | "connecting",
        event.payload.message
      );
    }
  );

  await listen<{ rms: number }>("mic-level", (event) => {
    const rms = event.payload.rms;
    const receivingAudio = rms >= MIC_ACTIVITY_RMS_THRESHOLD;
    targetMicLevel = receivingAudio ? Math.min(1, rms * 14) : 0;
    if (micTestActive) {
      micTestStatus.textContent = receivingAudio ? "Receiving audio" : "Listening...";
      setMicSignalState(receivingAudio, true);
    }
  });

  await listen<{ monitoring: boolean }>("mic-monitoring-status", (event) => {
    micTestActive = event.payload.monitoring;
    if (!micTestActive) {
      clearMicTestAutoStop();
      micTestStartedAt = 0;
      targetMicLevel = 0;
      micTestStatus.textContent = "Idle";
      setMicSignalState(false, false);
    } else {
      if (!micTestStartedAt) {
        micTestStartedAt = Date.now();
      }
      micTestStatus.textContent = "Listening...";
      setMicSignalState(false, true);
    }
    updateMicTestButton();
  });

  window.addEventListener("beforeunload", () => {
    clearMicTestAutoStop();
    if (micWaveRaf) {
      cancelAnimationFrame(micWaveRaf);
    }
    cleanupMicTestPlayback();
    invoke("stop_mic_monitoring").catch(() => {
      // ignore cleanup failures
    });
  });
});

function populateUI(settings: Settings) {
  renderUI(dom, settings);
  updateRecordingLoudnessValue();
}

function setupEventListeners() {
  // Toggle API key visibility
  toggleKeyBtn.addEventListener("click", () => {
    const isPassword = apiKeyInput.type === "password";
    apiKeyInput.type = isPassword ? "text" : "password";
  });

  apiKeyHelpBtn.addEventListener("click", () => {
    openApiKeyHelpModal();
  });

  closeApiKeyHelpBtn.addEventListener("click", () => {
    closeApiKeyHelpModal();
  });

  if (windowMinimizeBtn) {
    windowMinimizeBtn.addEventListener("click", async () => {
      try {
        await getCurrentWindow().minimize();
      } catch (err) {
        console.error("Failed to minimize window:", err);
      }
    });
  }

  windowCloseBtn.addEventListener("click", async () => {
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.error("Failed to close window:", err);
    }
  });

  apiKeyHelpModal.addEventListener("click", (event) => {
    if (event.target === apiKeyHelpModal) {
      closeApiKeyHelpModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !apiKeyHelpModal.hasAttribute("hidden")) {
      closeApiKeyHelpModal();
    }
  });

  sttProviderSelect.addEventListener("change", async () => {
    currentSettings.sttProvider = getActiveProvider();
    const providerSettings = currentSettings.providers[currentSettings.sttProvider];
    apiKeyInput.value = providerSettings.apiKey;
    updateApiKeyTextForProvider();
    updateConnectionStatus(providerSettings.apiKey ? "untested" : "disconnected");
    testApiKeyBtn.disabled = !providerSettings.apiKey;
    await refreshLiveModelList(false);
    scheduleAutosave(0);
  });

  // Typing mode change
  typingModeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      updateTypingModeHint(radio.value);
      scheduleAutosave(0);
    });
  });

  // Auto-stop toggle
  autoStopCheckbox.addEventListener("change", () => {
    silenceTimeoutField.style.display = autoStopCheckbox.checked
      ? "flex"
      : "none";
    scheduleAutosave(0);
  });

  resetDefaultsBtn.addEventListener("click", async () => {
    await handleResetToDefaults();
  });

  testApiKeyBtn.addEventListener("click", async () => {
    await handleApiKeyTest();
  });

  refreshModelsBtn.addEventListener("click", async () => {
    await refreshLiveModelList(true);
  });

  liveModelSelect.addEventListener("change", () => {
    if (apiKeyInput.value.trim() !== lastTestedApiKey) {
      updateConnectionStatus("untested");
    }
    scheduleAutosave(0);
  });

  apiKeyInput.addEventListener("input", () => {
    const provider = getActiveProvider();
    const apiKey = apiKeyInput.value.trim();
    testApiKeyBtn.disabled = !apiKey;

    if (!apiKey) {
      lastTestedApiKey = "";
      updateConnectionStatus("disconnected");
      populateLiveModelOptions([], "");
      setLiveModelHint("Enter API key to fetch models.");
      scheduleAutosave();
      return;
    }

    if (apiKey !== lastTestedApiKey) {
      updateConnectionStatus("untested");
    }

    const cache = currentSettings.providers[provider].modelCache;
    const fingerprint = fingerprintApiKey(apiKey);
    const cacheMatches =
      cache &&
      cache.apiKeyFingerprint === fingerprint &&
      Array.isArray(cache.models) &&
      cache.models.length > 0;

    if (!cacheMatches) {
      setLiveModelHint("Model list may be outdated. Click Refresh.");
    }

    scheduleAutosave();
  });

  hotkeyInput.addEventListener("input", () => {
    scheduleAutosave();
  });

  silenceTimeoutInput.addEventListener("input", () => {
    scheduleAutosave();
  });

  languageSelect.addEventListener("change", () => {
    scheduleAutosave(0);
  });

  refreshMicrophonesBtn.addEventListener("click", async () => {
    await refreshMicrophoneList(microphoneSelect.value || "default");
  });

  recordingLoudnessInput.addEventListener("input", () => {
    updateRecordingLoudnessValue();
    scheduleAutosave();
  });

  micTestBtn.addEventListener("click", async () => {
    if (micTestActive) {
      await stopMicTest();
    } else {
      await startMicTest();
    }
  });

  microphoneSelect.addEventListener("change", async () => {
    if (micTestActive) {
      await stopMicTest();
      await startMicTest();
    }
    scheduleAutosave(0);
  });

  debugLoggingCheckbox.addEventListener("change", () => {
    scheduleAutosave(0);
  });

  openDebugFolderBtn.addEventListener("click", async () => {
    try {
      await openDebugLogFolder();
    } catch (err) {
      console.error("Failed to open debug logs folder:", err);
      debugLog(`Failed to open debug logs folder: ${String(err)}`, "ERROR");
      debugLogPath.textContent = "Could not open debug logs folder.";
    }
  });
}

function openApiKeyHelpModal() {
  apiKeyHelpModal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
}

function closeApiKeyHelpModal() {
  apiKeyHelpModal.setAttribute("hidden", "");
  document.body.classList.remove("modal-open");
}

function setLiveModelHint(text: string) {
  renderLiveModelHint(dom, text);
}

function populateLiveModelOptions(models: string[], preferredModel: string) {
  renderLiveModelOptions(dom, models, preferredModel);
}

async function refreshLiveModelList(forceApiRefresh: boolean) {
  const provider = getActiveProvider();
  const providerLabel = getActiveProviderLabel();
  const providerRuntime = getActiveProviderRuntime();
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    populateLiveModelOptions([], "");
    setLiveModelHint("Enter API key to fetch models.");
    return;
  }

  const now = Date.now();
  const fingerprint = fingerprintApiKey(apiKey);
  const cache = currentSettings.providers[provider].modelCache;
  const cacheIsFresh = isModelCacheFresh(cache, fingerprint, now, MODEL_CACHE_TTL_MS);

  if (!forceApiRefresh && cacheIsFresh && cache) {
    const preferred = selectPreferredModel(
      cache.models,
      currentSettings.providers[provider].selectedModel,
      currentSettings.providers[provider].lastKnownGoodModel
    );
    populateLiveModelOptions(cache.models, preferred);
    setLiveModelHint(`Loaded ${cache.models.length} models from cache.`);
    debugLog(`Using cached ${providerLabel} models (count=${cache.models.length})`, "INFO");
    return;
  }

  try {
    refreshModelsBtn.disabled = true;
    setLiveModelHint(`Fetching models from ${providerLabel} API...`);
    debugLog(`Fetching model list from ${providerLabel} API`, "INFO");
    const models = await providerRuntime.fetchModels(apiKey);

    if (models.length === 0) {
      throw new Error(`No ${providerLabel} transcription models returned by API`);
    }

    const preferred = selectPreferredModel(
      models,
      currentSettings.providers[provider].selectedModel,
      currentSettings.providers[provider].lastKnownGoodModel
    );
    populateLiveModelOptions(models, preferred);

    currentSettings.providers[provider].modelCache = {
      apiKeyFingerprint: fingerprint,
      fetchedAt: Date.now(),
      models,
    };
    await saveProviderModelCache(provider, currentSettings.providers[provider].modelCache);

    if (!models.includes(currentSettings.providers[provider].selectedModel)) {
      currentSettings.providers[provider].selectedModel = selectPreferredModel(
        models,
        currentSettings.providers[provider].selectedModel,
        currentSettings.providers[provider].lastKnownGoodModel
      );
      liveModelSelect.value = currentSettings.providers[provider].selectedModel;
    }

    setLiveModelHint(`Loaded ${models.length} models from API.`);
    debugLog(`Loaded ${providerLabel} models from API (count=${models.length})`, "INFO");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setLiveModelHint(`Failed to load models: ${message}`);
    debugLog(`Failed to load model list: ${message}`, "ERROR");
  } finally {
    refreshModelsBtn.disabled = false;
  }
}

function updateMicTestButton() {
  micTestBtn.textContent = micTestActive ? "Stop mic test" : "Start mic test";
}

function clearMicTestAutoStop() {
  if (micTestAutoStopTimer !== null) {
    window.clearTimeout(micTestAutoStopTimer);
    micTestAutoStopTimer = null;
  }
}

function setMicSignalState(isSignalDetected: boolean, isListening: boolean) {
  const statusText = micSignalIndicator.querySelector(".status-text") as HTMLElement;
  micSignalIndicator.className = "status-indicator";

  if (!isListening) {
    micSignalIndicator.classList.add("disconnected");
    statusText.textContent = "No signal";
    return;
  }

  if (isSignalDetected) {
    micSignalIndicator.classList.add("connected");
    statusText.textContent = "Signal detected";
  } else {
    micSignalIndicator.classList.add("disconnected");
    statusText.textContent = "Listening";
  }
}

async function startMicTest() {
  try {
    clearMicTestAutoStop();
    cleanupMicTestPlayback();
    await invoke("start_mic_monitoring", {
      deviceId: microphoneSelect.value || "default",
      inputGain: getRecordingInputGain(),
    });
    micTestActive = true;
    micTestStartedAt = Date.now();
    micTestStatus.textContent = "Listening...";
    micTestTranscript.textContent = "Transcript: Listening...";
    setMicSignalState(false, true);
    micTestAutoStopTimer = window.setTimeout(() => {
      if (micTestActive) {
        void stopMicTest();
      }
    }, MIC_TEST_DURATION_MS);
    updateMicTestButton();
  } catch (err) {
    console.error("Failed to start mic test:", err);
    micTestStatus.textContent = "Mic test failed";
    micTestTranscript.textContent = "Transcript: -";
    setMicSignalState(false, false);
  }
}

async function stopMicTest() {
  if (micTestStopInProgress) {
    return;
  }

  micTestStopInProgress = true;
  clearMicTestAutoStop();

  let recordedWavBase64: string | null = null;
  try {
    recordedWavBase64 = await invoke<string | null>(
      "stop_mic_monitoring_with_recording"
    );
  } catch (err) {
    console.error("Failed to stop mic test:", err);
  } finally {
    micTestActive = false;
    micTestStartedAt = 0;
    targetMicLevel = 0;
    micTestStatus.textContent = "Idle";
    setMicSignalState(false, false);
    updateMicTestButton();
    micTestStopInProgress = false;
  }

  if (!recordedWavBase64) {
    micTestStatus.textContent = "No audio captured";
    micTestTranscript.textContent = "Transcript: No audio captured";
    return;
  }

  micTestStatus.textContent = "Transcribing...";
  const transcript = await transcribeMicTestRecording(recordedWavBase64);
  if (transcript) {
    debugLog(`Mic test transcript preview: "${transcript.slice(0, 140)}${transcript.length > 140 ? "..." : ""}"`, "INFO");
    micTestTranscript.textContent = `Transcript: ${transcript}`;
  } else {
    debugLog("Mic test transcript is empty", "WARN");
    micTestTranscript.textContent = "Transcript: (No speech detected)";
  }

  micTestStatus.textContent = "Playing back...";
  const played = await playMicTestRecording(recordedWavBase64);
  micTestStatus.textContent = played ? "Playback complete" : "Playback failed";
}

async function transcribeMicTestRecording(wavBase64: string): Promise<string> {
  const provider = getActiveProvider();
  const providerRuntime = getActiveProviderRuntime();
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    return `${getActiveProviderLabel()} API key required for transcription`;
  }

  try {
    const pcmChunksBase64 = await wavToPcmChunksBase64(wavBase64);
    debugLog(
      `Mic test: prepared ${pcmChunksBase64.length} PCM chunks for ${getActiveProviderLabel()} live transcription`,
      "INFO"
    );
    if (pcmChunksBase64.length === 0) {
      return "";
    }

    const transcript = await providerRuntime.transcribeWithLivePipeline({
      apiKey,
      language: languageSelect.value || "auto",
      preferredModel:
        liveModelSelect.value || currentSettings.providers[provider].selectedModel,
      fallbackModels: currentSettings.providers[provider].modelCache?.models ?? [],
      pcmChunksBase64,
      settleDelayMs: 2200,
      chunkIntervalMs: 20,
    });
    debugLog(`Mic test transcript chars: ${transcript.length}`, "INFO");
    return transcript.trim();
  } catch (err) {
    console.error("Failed to transcribe mic test recording:", err);
    debugLog(`Mic test transcription failed: ${String(err)}`, "ERROR");
    return `${getActiveProviderLabel()} transcription failed`;
  }
}

async function playMicTestRecording(wavBase64: string): Promise<boolean> {
  try {
    cleanupMicTestPlayback();

    const wavBytes = base64ToBytes(wavBase64);
    const blob = new Blob([wavBytes], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    lastMicTestPlaybackUrl = url;

    const audio = new Audio(url);
    lastMicTestAudio = audio;
    await audio.play();

    const completed = await new Promise<boolean>((resolve) => {
      audio.addEventListener("ended", () => resolve(true), { once: true });
      audio.addEventListener("error", () => resolve(false), { once: true });
    });

    return completed;
  } catch (err) {
    console.error("Failed to play mic test recording:", err);
    return false;
  }
}

function cleanupMicTestPlayback() {
  if (lastMicTestAudio) {
    lastMicTestAudio.pause();
    lastMicTestAudio.src = "";
    lastMicTestAudio = null;
  }

  if (lastMicTestPlaybackUrl) {
    URL.revokeObjectURL(lastMicTestPlaybackUrl);
    lastMicTestPlaybackUrl = null;
  }
}

function updateDebugLogHint() {
  if (!isDebugLoggingEnabled()) {
    debugLogPath.textContent = "Debug logs are disabled.";
    openDebugFolderBtn.disabled = true;
    return;
  }

  debugLogPath.textContent = "Debug logs are enabled.";
  openDebugFolderBtn.disabled = false;
}

function setupMicWave() {
  const ctx = micWaveCanvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const resize = () => {
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = micWaveCanvas.clientWidth;
    const cssHeight = micWaveCanvas.clientHeight || 64;
    micWaveCanvas.width = Math.floor(cssWidth * ratio);
    micWaveCanvas.height = Math.floor(cssHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const draw = () => {
    const width = micWaveCanvas.clientWidth;
    const height = micWaveCanvas.clientHeight || 64;
    const testProgress =
      micTestActive && micTestStartedAt > 0
        ? Math.min(1, (Date.now() - micTestStartedAt) / MIC_TEST_DURATION_MS)
        : 0;

    displayedMicLevel += (targetMicLevel - displayedMicLevel) * 0.15;
    if (!micTestActive) {
      targetMicLevel = 0;
      displayedMicLevel *= 0.92;
    } else if (displayedMicLevel > 0.002) {
      micPhase += 0.12 + displayedMicLevel * 0.2;
    }

    ctx.clearRect(0, 0, width, height);

    const baseY = height / 2;
    const amplitude = micTestActive ? displayedMicLevel * 20 : 0;

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
        Math.sin(progress * 10 + micPhase) * amplitude * envelope +
        Math.sin(progress * 22 + micPhase * 1.8) * amplitude * 0.16;

      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
    ctx.shadowBlur = 0;

    if (micTestActive) {
      const progressX = Math.min(width - 1, Math.max(0, Math.floor(width * testProgress)));
      const sliderGradient = ctx.createLinearGradient(0, 0, 0, height);
      sliderGradient.addColorStop(0, "rgba(251, 191, 36, 0.95)");
      sliderGradient.addColorStop(1, "rgba(248, 113, 113, 0.9)");

      ctx.lineWidth = 2;
      ctx.strokeStyle = sliderGradient;
      ctx.beginPath();
      ctx.moveTo(progressX, 0);
      ctx.lineTo(progressX, height);
      ctx.stroke();
    }

    micWaveRaf = requestAnimationFrame(draw);
  };

  resize();
  window.addEventListener("resize", resize);
  updateMicTestButton();
  setMicSignalState(false, false);
  micWaveRaf = requestAnimationFrame(draw);
}

async function refreshMicrophoneList(preferredDeviceId: string) {
  try {
    const devices = await invoke<InputDeviceInfo[]>("list_input_devices");
    const options: InputDeviceInfo[] = [
      {
        id: "default",
        name: "System default",
        isDefault: false,
      },
      ...devices,
    ];

    microphoneSelect.innerHTML = "";
    for (const device of options) {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = device.isDefault
        ? `${device.name} (default)`
        : device.name;
      microphoneSelect.appendChild(option);
    }

    const preferredExists = options.some((d) => d.id === preferredDeviceId);
    microphoneSelect.value = preferredExists ? preferredDeviceId : "default";
  } catch (err) {
    console.error("Failed to list input devices:", err);
    microphoneSelect.innerHTML = "";
    const option = document.createElement("option");
    option.value = "default";
    option.textContent = "System default";
    microphoneSelect.appendChild(option);
    microphoneSelect.value = "default";
  }
}

function updateTypingModeHint(mode: string) {
  renderTypingModeHint(dom, mode);
}

function updateConnectionStatus(
  status: ConnectionStatus,
  message?: string
) {
  renderConnectionStatus(dom, status, message);
}

async function handleApiKeyTest() {
  const provider = getActiveProvider();
  const providerRuntime = getActiveProviderRuntime();
  const providerLabel = getActiveProviderLabel();
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    updateConnectionStatus("disconnected");
    return;
  }

  testApiKeyBtn.disabled = true;
  updateConnectionStatus("connecting");

  try {
    if (liveModelSelect.disabled || !liveModelSelect.value) {
      await refreshLiveModelList(true);
    }

    const selectedModel = liveModelSelect.value;
    if (!selectedModel) {
      throw new Error("No model selected");
    }

    debugLog(
      `Testing ${providerLabel} API key with selected model '${selectedModel}'`,
      "INFO"
    );
    await providerRuntime.validateApiKey(apiKey);
    await providerRuntime.validateModel(apiKey, selectedModel);
    await providerRuntime.probeModelForTranscription(apiKey, selectedModel);

    lastTestedApiKey = apiKey;
    currentSettings.providers[provider].lastKnownGoodModel = selectedModel;
    await saveProviderLastKnownGoodModel(provider, selectedModel);
    updateConnectionStatus("connected");
    setLiveModelHint(`Model '${selectedModel}' validated successfully.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid API key";
    updateConnectionStatus("error", message);
    debugLog(`API/model test failed: ${message}`, "ERROR");
  } finally {
    testApiKeyBtn.disabled = !apiKeyInput.value.trim();
  }
}

function showSaveStatus(message: string, isError = false) {
  if (saveStatusTimer !== null) {
    window.clearTimeout(saveStatusTimer);
  }

  saveStatus.textContent = message;
  saveStatus.style.color = isError ? "var(--error)" : "";
  saveStatus.classList.add("visible");

  saveStatusTimer = window.setTimeout(
    () => {
      saveStatus.classList.remove("visible");
      saveStatus.style.color = "";
      saveStatusTimer = null;
    },
    isError ? 3000 : 1500
  );
}

function collectSettingsFromUI(): Settings {
  const provider = getActiveProvider();
  const selectedMode = Array.from(typingModeRadios).find(
    (r) => r.checked
  )?.value;

  const silenceSeconds = Number.parseFloat(silenceTimeoutInput.value);
  const autoStopSilenceMs =
    Number.isFinite(silenceSeconds) && silenceSeconds > 0
      ? silenceSeconds * 1000
      : currentSettings.autoStopSilenceMs;

  const recordingLoudnessPercent = Number.parseFloat(recordingLoudnessInput.value);
  const recordingLoudness =
    Number.isFinite(recordingLoudnessPercent) &&
    recordingLoudnessPercent >= 25 &&
    recordingLoudnessPercent <= 300
      ? recordingLoudnessPercent
      : currentSettings.recordingLoudness;

  const nextSettings: Settings = {
    ...currentSettings,
    sttProvider: provider,
    providers: {
      gemini: { ...currentSettings.providers.gemini },
      openai: { ...currentSettings.providers.openai },
    },
    hotkey: normalizeHotkey(hotkeyInput.value),
    microphoneDeviceId: microphoneSelect.value || "default",
    recordingLoudness,
    debugLoggingEnabled: debugLoggingCheckbox.checked,
    typingMode: (selectedMode as Settings["typingMode"]) || "incremental",
    autoStopOnSilence: autoStopCheckbox.checked,
    autoStopSilenceMs,
    language: languageSelect.value,
  };

  nextSettings.providers[provider].apiKey = apiKeyInput.value.trim();
  nextSettings.providers[provider].selectedModel =
    liveModelSelect.value || currentSettings.providers[provider].selectedModel;

  return nextSettings;
}

function updateRecordingLoudnessValue() {
  const percent = Number.parseFloat(recordingLoudnessInput.value);
  if (!Number.isFinite(percent)) {
    recordingLoudnessValue.textContent = "100%";
    return;
  }
  recordingLoudnessValue.textContent = `${Math.round(percent)}%`;
}

function getRecordingInputGain() {
  const percent = Number.parseFloat(recordingLoudnessInput.value);
  if (!Number.isFinite(percent)) {
    return 1;
  }
  return Math.min(3, Math.max(0.25, percent / 100));
}

function scheduleAutosave(delayMs = AUTOSAVE_DEBOUNCE_MS) {
  if (autosaveTimer !== null) {
    window.clearTimeout(autosaveTimer);
  }

  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = null;
    void persistSettingsFromUI("Saved");
  }, delayMs);
}

async function persistSettingsFromUI(successMessage: string) {
  if (saveInFlight) {
    savePending = true;
    return;
  }

  saveInFlight = true;
  const newSettings = collectSettingsFromUI();

  try {
    await saveSettings(newSettings);
    currentSettings = newSettings;
    await configureDebugLogging(newSettings.debugLoggingEnabled);
    updateDebugLogHint();
    reloadSettings(newSettings);

    // Update status
    lastTestedApiKey = "";
    const providerApiKey = getProviderApiKeyFromSettings(newSettings, newSettings.sttProvider);
    updateConnectionStatus(providerApiKey ? "untested" : "disconnected");
    testApiKeyBtn.disabled = !providerApiKey;

    showSaveStatus(successMessage);
  } catch (err) {
    console.error("Failed to save settings:", err);
    showSaveStatus("Save failed", true);
  } finally {
    saveInFlight = false;
    if (savePending) {
      savePending = false;
      await persistSettingsFromUI("Saved");
    }
  }
}

async function handleResetToDefaults() {
  if (autosaveTimer !== null) {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }

  currentSettings = getDefaultSettings();
  populateUI(currentSettings);
  updateApiKeyTextForProvider();
  setLiveModelHint("Enter API key to fetch models.");
  updateConnectionStatus("disconnected");
  testApiKeyBtn.disabled = true;

  await persistSettingsFromUI("Defaults restored");
}
