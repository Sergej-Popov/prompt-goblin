import {
  applyIcons,
  showToast,
  cycleWaveformColorScheme,
  cycleWaveformStyle,
  getWaveformColorSchemeLabel,
  getWaveformStyleLabel,
} from "@goblin-systems/goblin-design-system";
import { initApp } from "./app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  configureDebugLogging,
  debugLog,
  isDebugLoggingEnabled,
  openDebugLogFolder,
} from "./logger";
import { getCorrectionLabel, getCorrectionRuntime } from "./correction/service";
import {
  getMainDom,
  getSelectedRecordingMode,
  populateCorrectionModelOptions as renderCorrectionModelOptions,
  populateLiveModelOptions as renderLiveModelOptions,
  populateUI as renderUI,
  setCorrectionModelHint as renderCorrectionModelHint,
  setLiveModelHint as renderLiveModelHint,
  updateConnectionStatus as renderConnectionStatus,
  updateTranscriptCorrectionUI as renderTranscriptCorrectionUI,
  updateTypingModeHint as renderTypingModeHint,
  type ConnectionStatus,
  type MainDom,
} from "./main/dom";
import {
  correctionModelMessages,
  liveModelMessages,
  refreshModelList,
} from "./main/model-loader";
import { ApiKeyController } from "./main/api-key-controller";
import { setupMainEventBindings } from "./main/event-bindings";
import {
  getWaveToolButtonState,
  MicTestController,
  type InputDeviceInfo,
} from "./main/mic-test-controller";
import {
  formatRecordingLoudnessValue,
  getRecordingInputGain,
  SettingsController,
  type SettingsFormSnapshot,
} from "./main/settings-controller";
import {
  setupGlobalInteractionGuards,
  setupWindowAndModalControls,
} from "./main/window-controls";
import {
  pollOpenAIDeviceAuth,
  refreshOpenAIOAuthSession,
  startOpenAIDeviceAuth,
} from "./openai/oauth";
import {
  getProviderAuthIdentity,
  getProviderModelCache,
  loadSettings,
  saveCorrectionProviderModelCache,
  saveProviderLastKnownGoodModel,
  saveProviderModelCache,
  type ListeningDingSound,
  type Settings,
  type SttProvider,
} from "./settings";
import { getProviderAuth, getProviderLabel, getProviderRuntime } from "./stt/service";

let currentSettings: Settings;
let dom: MainDom;
let settingsController: SettingsController;
let micTestController: MicTestController;
let apiKeyController: ApiKeyController;
let dingPreviewAudioContext: AudioContext | null = null;

type ProviderOption = "gemini" | "openai" | "openai_oauth";

function getSelectedProviderOption(): ProviderOption {
  const value = dom.sttProviderSelect.value;
  if (value === "openai_oauth") {
    return "openai_oauth";
  }
  if (value === "openai") {
    return "openai";
  }
  return "gemini";
}

function getActiveProvider(): SttProvider {
  return getSelectedProviderOption() === "gemini" ? "gemini" : "openai";
}

function getActiveProviderRuntime() {
  return getProviderRuntime(getActiveProvider());
}

function getActiveCorrectionRuntime() {
  return getCorrectionRuntime(getActiveProvider(), currentSettings.providers.openai.authMode);
}

function getActiveCorrectionLabel(): string {
  return getCorrectionLabel(getActiveProvider(), currentSettings.providers.openai.authMode);
}

async function openExternalUrl(url: string) {
  await invoke("open_external_url", { url });
}

function setProviderHelpContent(providerOption: ProviderOption) {
  const setList = (items: string[]) => {
    dom.apiKeyHelpList.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        return li;
      })
    );
  };

  if (providerOption === "gemini") {
    dom.apiKeyHelpTitle.textContent = "Gemini API setup";
    setList([
      "Go to Google AI Studio (aistudio.google.com/apikey).",
      "Create an API key and paste it into the API key field.",
      "Click Test to confirm the key works.",
    ]);
    dom.apiKeyHelpHint.textContent = "Keep your API key private and never share it publicly.";
    return;
  }

  if (providerOption === "openai") {
    dom.apiKeyHelpTitle.textContent = "OpenAI API setup";
    setList([
      "Go to OpenAI platform API keys (platform.openai.com/api-keys).",
      "Create an API key and paste it into the API key field.",
      "Click Test to confirm the key works.",
    ]);
    dom.apiKeyHelpHint.textContent = "Keep your API key private and never share it publicly.";
    return;
  }

  dom.apiKeyHelpTitle.textContent = "OpenAI Codex OAuth setup (experimental)";
  setList([
    "Open ChatGPT security settings and enable device code authorization for Codex.",
    "In Prompt Goblin, click Login and complete the device flow in your browser.",
    "Use the shown device code (copy button available) and open the device page link.",
  ]);
  dom.apiKeyHelpHint.textContent =
    "OAuth uses your ChatGPT subscription access and does not require an API key.";
}

function setCurrentSettings(settings: Settings) {
  currentSettings = settings;
  apiKeyController?.resetLastTestedApiKey();
}

function updateApiKeyTextForProvider() {
  const provider = getActiveProvider();
  const selectedOption = getSelectedProviderOption();
  const keySectionTitle = dom.credentialSectionTitle;
  const useOAuth = selectedOption === "openai_oauth";

  if (selectedOption === "gemini") {
    keySectionTitle.textContent = "GEMINI API KEY";
    dom.apiKeyHelpBtn.title = "How to set up Gemini API";
    dom.apiKeyHelpBtn.setAttribute("aria-label", "How to set up Gemini API");
  } else if (selectedOption === "openai") {
    keySectionTitle.textContent = "OPENAI API KEY";
    dom.apiKeyHelpBtn.title = "How to set up OpenAI API";
    dom.apiKeyHelpBtn.setAttribute("aria-label", "How to set up OpenAI API");
  } else {
    keySectionTitle.textContent = "OPENAI OAUTH";
    dom.apiKeyHelpBtn.title = "How to set up OpenAI Codex OAuth";
    dom.apiKeyHelpBtn.setAttribute("aria-label", "How to set up OpenAI Codex OAuth");
  }
  setProviderHelpContent(selectedOption);

  dom.apiKeyInput.placeholder = `Paste your ${getProviderLabel(provider)} API key...`;

  const isOpenAI = selectedOption === "openai" || selectedOption === "openai_oauth";
  dom.openaiOauthControls.hidden = selectedOption !== "openai_oauth";
  dom.apiKeyInputRow.hidden = useOAuth;
  if (selectedOption !== "openai_oauth") {
    dom.openaiDeviceAuthRow.hidden = true;
    dom.openaiDeviceUserCode.textContent = "";
  }

  if (isOpenAI) {
    dom.apiKeyInput.disabled = useOAuth;
    dom.toggleKeyBtn.disabled = useOAuth;

    const oauthSession = currentSettings.providers.openai.oauthSession;
    if (oauthSession) {
      const expired = oauthSession.expiresAt <= Date.now();
      dom.openaiOauthStatus.textContent = expired
        ? `Expired session (${oauthSession.planType}, experimental)`
        : `Connected (${oauthSession.planType}, experimental)`;
      dom.openaiOauthLoginBtn.hidden = !expired;
      dom.openaiOauthLogoutBtn.hidden = false;
      dom.openaiOauthLogoutBtn.disabled = false;
      dom.testApiKeyBtn.disabled = useOAuth && expired;
    } else {
      dom.openaiOauthStatus.textContent = "Not connected (experimental)";
      dom.openaiOauthLoginBtn.hidden = false;
      dom.openaiOauthLogoutBtn.hidden = true;
      dom.openaiOauthLogoutBtn.disabled = true;
      dom.testApiKeyBtn.disabled = useOAuth;
    }

    if (!useOAuth) {
      dom.testApiKeyBtn.disabled = !currentSettings.providers.openai.apiKey.trim();
    }
  } else {
    dom.apiKeyInput.disabled = false;
    dom.toggleKeyBtn.disabled = false;
    dom.testApiKeyBtn.disabled = !currentSettings.providers.gemini.apiKey;
  }
}

function updateConnectionStatus(status: ConnectionStatus, message?: string) {
  renderConnectionStatus(dom, status, message);
}

function setLiveModelHint(text: string) {
  renderLiveModelHint(dom, text);
}

function populateLiveModelOptions(models: string[], preferredModel: string) {
  renderLiveModelOptions(dom, models, preferredModel);
}

function setCorrectionModelHint(text: string) {
  renderCorrectionModelHint(dom, text);
}

function populateCorrectionModelOptions(models: string[], preferredModel: string) {
  renderCorrectionModelOptions(dom, models, preferredModel);
}

function getSelectedTypingMode(): Settings["typingMode"] {
  return (
    Array.from(dom.typingModeRadios).find((radio) => radio.checked)?.value as
      | Settings["typingMode"]
      | undefined
  ) ?? "incremental";
}

function updateTranscriptCorrectionUI() {
  renderTranscriptCorrectionUI(
    dom,
    getSelectedTypingMode(),
    dom.transcriptCorrectionCheckbox.checked
  );
}

function updateTypingModeHint() {
  renderTypingModeHint(dom, getSelectedTypingMode());
}

function updateRecordingModeHint() {
  const mode = getSelectedRecordingMode(dom);
  if (mode === "push_to_talk") {
    dom.recordingModeHint.textContent =
      "Hold the hotkey to record, release to stop and type.";
  } else {
    dom.recordingModeHint.textContent =
      "Press the hotkey once to start, press again to stop.";
  }
}

function readFormSnapshot(): SettingsFormSnapshot {
  return {
    apiKey: dom.apiKeyInput.value,
    providerOption: getSelectedProviderOption(),
    hotkey: dom.hotkeyInput.value,
    liveModel: dom.liveModelSelect.value,
    correctionModel: dom.correctionModelSelect.value,
    microphoneDeviceId: dom.microphoneSelect.value,
    recordingLoudnessPercent: dom.recordingLoudnessInput.value,
    debugLoggingEnabled: dom.debugLoggingCheckbox.checked,
    typingMode: getSelectedTypingMode(),
    recordingMode: getSelectedRecordingMode(dom),
    clipboardMode: dom.clipboardModeSelect.value as Settings["clipboardMode"],
    transcriptCorrectionEnabled: dom.transcriptCorrectionCheckbox.checked,
    autoStopOnSilence: dom.autoStopCheckbox.checked,
    silenceTimeoutSeconds: dom.silenceTimeoutInput.value,
    language: dom.languageSelect.value,
    targetLanguage: dom.targetLanguageSelect.value,
    lineBreakMode: dom.lineBreakModeSelect.value as Settings["lineBreakMode"],
    playListeningDing: dom.listeningDingCheckbox.checked,
    listeningDingSound: dom.listeningDingSoundSelect.value as Settings["listeningDingSound"],
    listeningDingVolumePercent: dom.listeningDingVolumeInput.value,
    holdBeforeType: dom.holdBeforeTypeCheckbox.checked,
    holdBeforeTypeTimeoutSeconds: dom.holdBeforeTypeTimeoutInput.value,
  };
}

async function handleOpenAIOAuthLogin() {
  if (getActiveProvider() !== "openai") {
    return;
  }

  dom.openaiOauthLoginBtn.disabled = true;
  dom.openaiOauthStatus.textContent = "Starting device auth...";
  dom.openaiDeviceAuthRow.hidden = true;
  dom.openaiDeviceUserCode.textContent = "";

  try {
    const start = await startOpenAIDeviceAuth();
    dom.openaiOauthStatus.textContent = "Opened browser. Complete authentication there, then return here.";
    dom.openaiDeviceAuthRow.hidden = false;
    dom.openaiDeviceUserCode.textContent = start.userCode;
    try {
      await openExternalUrl(start.verificationUrl);
    } catch {
      // ignore open failures; user still has the device code
    }

    const session = await pollOpenAIDeviceAuth(
      start.deviceAuthId,
      start.userCode,
      start.intervalSeconds
    );

    currentSettings.providers.openai.authMode = "oauth_experimental";
    currentSettings.providers.openai.oauthSession = session;
    dom.sttProviderSelect.value = "openai_oauth";
    dom.openaiDeviceAuthRow.hidden = true;
    dom.openaiDeviceUserCode.textContent = "";
    updateApiKeyTextForProvider();
    settingsController.scheduleAutosave(0);
    await refreshLiveModelList(true);
    await refreshCorrectionModelList(true);
  } catch (err) {
    const message = err instanceof Error ? err.message : "OpenAI Codex OAuth login failed";
    dom.openaiOauthStatus.textContent = `OAuth failed: ${message}`;
    debugLog(`OpenAI Codex OAuth login failed: ${message}`, "ERROR");
  } finally {
    dom.openaiOauthLoginBtn.disabled = false;
  }
}

function handleOpenAIOAuthLogout() {
  currentSettings.providers.openai.oauthSession = null;
  if (currentSettings.providers.openai.authMode === "oauth_experimental") {
    currentSettings.providers.openai.authMode = "api_key";
    dom.sttProviderSelect.value = "openai";
  }
  dom.openaiOauthStatus.textContent = "Not connected (experimental)";
  dom.openaiDeviceAuthRow.hidden = true;
  dom.openaiDeviceUserCode.textContent = "";
  dom.openaiOauthLogoutBtn.disabled = true;
  updateApiKeyTextForProvider();
  settingsController.scheduleAutosave(0);
}

async function handleOpenAIDeviceCodeCopy() {
  const code = dom.openaiDeviceUserCode.textContent?.trim() ?? "";
  if (!code) {
    return;
  }

  try {
    await navigator.clipboard.writeText(code);
    showSaveStatus("Device code copied", false, 1200);
  } catch {
    showSaveStatus("Copy failed", true, 1200);
  }
}

function updateRecordingLoudnessValue() {
  dom.recordingLoudnessValue.textContent = formatRecordingLoudnessValue(
    dom.recordingLoudnessInput.value
  );
}

function updateListeningDingVolumeValue() {
  const volume = Number.parseFloat(dom.listeningDingVolumeInput.value);
  dom.listeningDingVolumeValue.textContent = Number.isFinite(volume)
    ? `${Math.round(volume)}%`
    : "60%";
}

function getDingPreviewAudioContext(): AudioContext | null {
  if (dingPreviewAudioContext) {
    return dingPreviewAudioContext;
  }

  const AudioContextCtor =
    window.AudioContext ??
    ((window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null);

  if (!AudioContextCtor) {
    return null;
  }

  dingPreviewAudioContext = new AudioContextCtor();
  return dingPreviewAudioContext;
}

function playDingTone(
  audioCtx: AudioContext,
  options: {
    wave: OscillatorType;
    at: number;
    duration: number;
    startHz: number;
    endHz: number;
    peakGain: number;
  }
) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = options.wave;
  osc.frequency.setValueAtTime(options.startHz, options.at);
  osc.frequency.exponentialRampToValueAtTime(options.endHz, options.at + options.duration);

  gain.gain.setValueAtTime(0.0001, options.at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.00011, options.peakGain), options.at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, options.at + options.duration);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(options.at);
  osc.stop(options.at + options.duration);
}

function previewListeningDing() {
  if (!dom.listeningDingCheckbox.checked) {
    return;
  }

  const audioCtx = getDingPreviewAudioContext();
  if (!audioCtx) {
    return;
  }

  const sound = dom.listeningDingSoundSelect.value as ListeningDingSound;
  const volumePercent = Number.parseFloat(dom.listeningDingVolumeInput.value);
  const volume = Number.isFinite(volumePercent)
    ? Math.min(1, Math.max(0, volumePercent / 100))
    : 0.6;

  if (volume <= 0) {
    return;
  }

  const start = () => {
    const now = audioCtx.currentTime;

    if (sound === "digital") {
      playDingTone(audioCtx, {
        wave: "square",
        at: now,
        duration: 0.06,
        startHz: 880,
        endHz: 988,
        peakGain: 0.09 * volume,
      });
      playDingTone(audioCtx, {
        wave: "square",
        at: now + 0.075,
        duration: 0.07,
        startHz: 1174,
        endHz: 1318,
        peakGain: 0.11 * volume,
      });
      return;
    }

    if (sound === "soft") {
      playDingTone(audioCtx, {
        wave: "triangle",
        at: now,
        duration: 0.14,
        startHz: 740,
        endHz: 880,
        peakGain: 0.12 * volume,
      });
      return;
    }

    playDingTone(audioCtx, {
      wave: "sine",
      at: now,
      duration: 0.12,
      startHz: 1046,
      endHz: 1318,
      peakGain: 0.16 * volume,
    });
  };

  if (audioCtx.state === "suspended") {
    audioCtx.resume().then(start).catch(() => {
      // best-effort preview
    });
    return;
  }

  start();
}

function updateWaveToolButtons() {
  const state = getWaveToolButtonState(
    currentSettings.waveformEasterEggUnlocked,
    currentSettings.waveformStyle,
    currentSettings.waveformColorScheme,
    getWaveformStyleLabel,
    getWaveformColorSchemeLabel
  );
  dom.waveStyleBtn.hidden = state.waveStyleHidden;
  dom.waveColorBtn.hidden = state.waveColorHidden;
  dom.waveStyleBtn.title = state.waveStyleTitle;
  dom.waveStyleBtn.setAttribute("aria-label", state.waveStyleTitle);
  dom.waveColorBtn.title = state.waveColorTitle;
  dom.waveColorBtn.setAttribute("aria-label", state.waveColorTitle);
}

function populateUI(settings: Settings) {
  renderUI(dom, settings);
  updateRecordingLoudnessValue();
  updateListeningDingVolumeValue();
  updateTypingModeHint();
  updateRecordingModeHint();
  updateWaveToolButtons();
  updateTranscriptCorrectionUI();
}

function updateDebugLogHint() {
  if (!isDebugLoggingEnabled()) {
    dom.debugLogPath.textContent = "Debug logs are disabled.";
    dom.openDebugFolderBtn.disabled = true;
    return;
  }

  dom.debugLogPath.textContent = "Debug logs are enabled.";
  dom.openDebugFolderBtn.disabled = false;
}

function showSaveStatus(message: string, isError = false, durationMs?: number) {
  showToast(message, isError ? "error" : "success", durationMs ?? (isError ? 3000 : 1500));
}

async function ensureOpenAIOAuthSessionFresh(): Promise<void> {
  const openai = currentSettings.providers.openai;
  if (openai.authMode !== "oauth_experimental" || !openai.oauthSession) {
    return;
  }

  if (openai.oauthSession.expiresAt > Date.now() + 60_000) {
    return;
  }

  try {
    openai.oauthSession = await refreshOpenAIOAuthSession(openai.oauthSession);
    settingsController.scheduleAutosave(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth refresh failed";
    debugLog(`OpenAI Codex OAuth refresh failed: ${message}`, "WARN");
  }
}

async function refreshLiveModelList(forceApiRefresh: boolean) {
  await ensureOpenAIOAuthSessionFresh();
  const provider = getActiveProvider();
  const providerOption = getSelectedProviderOption();
  const auth = getProviderAuth(currentSettings, provider);
  const messages =
    providerOption === "openai_oauth"
      ? { ...liveModelMessages, emptyApiKey: "Login with OpenAI Codex OAuth to fetch models." }
      : liveModelMessages;
  await refreshModelList({
    provider,
    providerLabel: getProviderLabel(provider),
    auth,
    authIdentity: getProviderAuthIdentity(currentSettings, provider),
    forceApiRefresh,
    fetchModels: (providerAuth) => getActiveProviderRuntime().fetchModels(providerAuth),
    getCache: () => getProviderModelCache(currentSettings, provider),
    getSelectedModel: () => currentSettings.providers[provider].selectedModel,
    getLastKnownGoodModel: () => currentSettings.providers[provider].lastKnownGoodModel,
    setSelectedModel: (model) => {
      currentSettings.providers[provider].selectedModel = model;
      dom.liveModelSelect.value = model;
    },
    saveCache: async (nextProvider, cache) => {
      currentSettings.providers[nextProvider].modelCache = cache;
      await saveProviderModelCache(nextProvider, cache);
    },
    populateOptions: populateLiveModelOptions,
    setHint: setLiveModelHint,
    setRefreshDisabled: (disabled) => {
      dom.refreshModelsBtn.disabled = disabled;
    },
    log: debugLog,
    messages,
  });
}

async function refreshCorrectionModelList(forceApiRefresh: boolean) {
  await ensureOpenAIOAuthSessionFresh();
  const provider = getActiveProvider();
  const providerOption = getSelectedProviderOption();
  const auth = getProviderAuth(currentSettings, provider);
  const messages =
    providerOption === "openai_oauth"
      ? {
          ...correctionModelMessages,
          emptyApiKey: "Login with OpenAI Codex OAuth to fetch correction models.",
        }
      : correctionModelMessages;
  await refreshModelList({
    provider,
    providerLabel: getActiveCorrectionLabel(),
    auth,
    authIdentity: getProviderAuthIdentity(currentSettings, provider),
    forceApiRefresh,
    fetchModels: (providerAuth) => getActiveCorrectionRuntime().fetchModels(providerAuth),
    getCache: () => currentSettings.transcriptionCorrection.providers[provider].modelCache,
    getSelectedModel: () => currentSettings.transcriptionCorrection.providers[provider].selectedModel,
    getLastKnownGoodModel: () =>
      currentSettings.transcriptionCorrection.providers[provider].lastKnownGoodModel,
    setSelectedModel: (model) => {
      currentSettings.transcriptionCorrection.providers[provider].selectedModel = model;
      dom.correctionModelSelect.value = model;
    },
    saveCache: async (nextProvider, cache) => {
      currentSettings.transcriptionCorrection.providers[nextProvider].modelCache = cache;
      await saveCorrectionProviderModelCache(nextProvider, cache);
    },
    populateOptions: populateCorrectionModelOptions,
    setHint: setCorrectionModelHint,
    setRefreshDisabled: (disabled) => {
      dom.refreshCorrectionModelsBtn.disabled = disabled;
    },
    onAfterUpdate: updateTranscriptCorrectionUI,
    log: debugLog,
    messages,
  });
}

async function refreshMicrophoneList(preferredDeviceId: string) {
  try {
    const devices = await invoke<InputDeviceInfo[]>("list_input_devices");
    micTestController.populateMicrophoneOptions(devices, preferredDeviceId);
  } catch (err) {
    console.error("Failed to list input devices:", err);
    micTestController.populateDefaultMicrophoneOption();
  }
}

async function openDebugFolder() {
  try {
    await openDebugLogFolder();
  } catch (err) {
    console.error("Failed to open debug logs folder:", err);
    debugLog(`Failed to open debug logs folder: ${String(err)}`, "ERROR");
    dom.debugLogPath.textContent = "Could not open debug logs folder.";
  }
}

function unlockWaveformEasterEgg(): boolean {
  const firstUnlock = !currentSettings.waveformEasterEggUnlocked;
  if (firstUnlock) {
    currentSettings.waveformEasterEggUnlocked = true;
    settingsController.setNextAutosaveStatus({
      message: "Goblin: Well look at that -- clever little snooper!",
      durationMs: 2600,
    });
  }
  return firstUnlock;
}

function cycleCurrentWaveformStyle() {
  currentSettings.waveformStyle = cycleWaveformStyle(currentSettings.waveformStyle);
}

function cycleCurrentWaveformColorScheme() {
  currentSettings.waveformColorScheme = cycleWaveformColorScheme(
    currentSettings.waveformColorScheme
  );
}

async function restartMicTestIfNeeded() {
  if (!micTestController.isActive()) {
    return;
  }

  const activeMode = micTestController.getMode();
  if (activeMode) {
    await micTestController.restartWithMode(activeMode);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  applyIcons();
  dom = getMainDom(document);
  micTestController = new MicTestController({
    dom,
    getCurrentSettings: () => currentSettings,
    getActiveProvider,
    getRecordingInputGain: () => getRecordingInputGain(dom.recordingLoudnessInput.value),
    debugLog,
  });
  settingsController = new SettingsController({
    getCurrentSettings: () => currentSettings,
    setCurrentSettings,
    getActiveProvider,
    readForm: readFormSnapshot,
    applySettingsToUI: populateUI,
    updateApiKeyTextForProvider,
    setLiveModelHint,
    setCorrectionModelHint,
    updateConnectionStatus: (status) => updateConnectionStatus(status),
    setTestApiKeyEnabled: (enabled) => {
      dom.testApiKeyBtn.disabled = !enabled;
    },
    configureDebugLogging,
    updateDebugLogHint,
    showSaveStatus,
  });
  apiKeyController = new ApiKeyController({
    dom,
    getCurrentSettings: () => currentSettings,
    getActiveProvider,
    getActiveProviderRuntime,
    refreshLiveModelList,
    refreshCorrectionModelList,
    updateApiKeyTextForProvider,
    updateConnectionStatus,
    updateTranscriptCorrectionUI,
    setLiveModelHint,
    setCorrectionModelHint,
    populateLiveModelOptions,
    populateCorrectionModelOptions,
    scheduleAutosave: (delayMs) => settingsController.scheduleAutosave(delayMs),
    debugLog,
    saveLastKnownGoodModel: saveProviderLastKnownGoodModel,
  });

  setCurrentSettings(await loadSettings());
  populateUI(currentSettings);
  updateApiKeyTextForProvider();
  await refreshLiveModelList(false);
  await refreshCorrectionModelList(false);
  await refreshMicrophoneList(currentSettings.microphoneDeviceId);
  await configureDebugLogging(currentSettings.debugLoggingEnabled);
  updateDebugLogHint();
  micTestController.setupWave();
  setupGlobalInteractionGuards();
  setupWindowAndModalControls({
    dom,
    onBeforeUnload: () => {
      settingsController.cancelAutosave();
      micTestController.cleanup();
      invoke("stop_mic_monitoring").catch(() => {
        // ignore cleanup failures
      });
    },
  });
  setupMainEventBindings({
    dom,
    apiKeyController,
    micTestController,
    settingsController,
    updateTypingModeHint,
    updateRecordingModeHint,
    updateTranscriptCorrectionUI,
    updateRecordingLoudnessValue,
    updateListeningDingVolumeValue,
    previewListeningDing,
    updateWaveToolButtons,
    refreshLiveModelList,
    refreshCorrectionModelList,
    refreshMicrophoneList,
    handleOpenAIOAuthLogin,
    handleOpenAIOAuthLogout,
    handleOpenAIDeviceCodeCopy,
    handleResetDefaults: async () => settingsController.resetToDefaults(),
    handleOpenDebugFolder: openDebugFolder,
    cycleWaveformStyle: cycleCurrentWaveformStyle,
    cycleWaveformColorScheme: cycleCurrentWaveformColorScheme,
    unlockWaveformEasterEgg,
    restartMicTestIfNeeded,
  });
  await initApp();

  apiKeyController.syncConnectionStatusFromSettings();

  await listen<{ status: ConnectionStatus; message?: string }>("stt-status", (event) => {
    updateConnectionStatus(event.payload.status, event.payload.message);
  });

  await listen<{ rms: number }>("mic-level", (event) => {
    micTestController.handleMicLevel(event.payload.rms);
  });

  await listen<{ monitoring: boolean }>("mic-monitoring-status", (event) => {
    micTestController.handleMonitoringStatus(event.payload.monitoring);
  });
});
