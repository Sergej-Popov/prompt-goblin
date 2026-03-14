import type { Settings } from "../settings";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "untested";

export interface MainDom {
  sttProviderSelect: HTMLSelectElement;
  apiKeyInput: HTMLInputElement;
  hotkeyInput: HTMLInputElement;
  liveModelSelect: HTMLSelectElement;
  refreshModelsBtn: HTMLButtonElement;
  liveModelHint: HTMLElement;
  microphoneSelect: HTMLSelectElement;
  recordingLoudnessInput: HTMLInputElement;
  recordingLoudnessValue: HTMLElement;
  refreshMicrophonesBtn: HTMLButtonElement;
  micTestBtn: HTMLButtonElement;
  micTestStatus: HTMLElement;
  micTestTranscript: HTMLElement;
  micSignalIndicator: HTMLElement;
  micWaveCanvas: HTMLCanvasElement;
  debugLoggingCheckbox: HTMLInputElement;
  openDebugFolderBtn: HTMLButtonElement;
  debugLogPath: HTMLElement;
  toggleKeyBtn: HTMLButtonElement;
  apiKeyHelpBtn: HTMLButtonElement;
  apiKeyHelpModal: HTMLElement;
  closeApiKeyHelpBtn: HTMLButtonElement;
  connectionStatus: HTMLElement;
  testApiKeyBtn: HTMLButtonElement;
  typingModeRadios: NodeListOf<HTMLInputElement>;
  typingModeHint: HTMLElement;
  autoStopCheckbox: HTMLInputElement;
  silenceTimeoutField: HTMLElement;
  silenceTimeoutInput: HTMLInputElement;
  languageSelect: HTMLSelectElement;
  resetDefaultsBtn: HTMLButtonElement;
  saveStatus: HTMLElement;
  windowMinimizeBtn: HTMLButtonElement | null;
  windowCloseBtn: HTMLButtonElement;
}

function byId<T extends HTMLElement>(doc: Document, id: string): T {
  const element = doc.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }
  return element as T;
}

function byIdOptional<T extends HTMLElement>(doc: Document, id: string): T | null {
  const element = doc.getElementById(id);
  return element ? (element as T) : null;
}

export function getMainDom(doc: Document): MainDom {
  return {
    apiKeyInput: byId<HTMLInputElement>(doc, "api-key-input"),
    sttProviderSelect: byId<HTMLSelectElement>(doc, "stt-provider-select"),
    hotkeyInput: byId<HTMLInputElement>(doc, "hotkey-input"),
    liveModelSelect: byId<HTMLSelectElement>(doc, "live-model-select"),
    refreshModelsBtn: byId<HTMLButtonElement>(doc, "refresh-models-btn"),
    liveModelHint: byId<HTMLElement>(doc, "live-model-hint"),
    microphoneSelect: byId<HTMLSelectElement>(doc, "microphone-select"),
    recordingLoudnessInput: byId<HTMLInputElement>(doc, "recording-loudness"),
    recordingLoudnessValue: byId<HTMLElement>(doc, "recording-loudness-value"),
    refreshMicrophonesBtn: byId<HTMLButtonElement>(doc, "refresh-microphones-btn"),
    micTestBtn: byId<HTMLButtonElement>(doc, "mic-test-btn"),
    micTestStatus: byId<HTMLElement>(doc, "mic-test-status"),
    micTestTranscript: byId<HTMLElement>(doc, "mic-test-transcript"),
    micSignalIndicator: byId<HTMLElement>(doc, "mic-signal-indicator"),
    micWaveCanvas: byId<HTMLCanvasElement>(doc, "mic-wave-canvas"),
    debugLoggingCheckbox: byId<HTMLInputElement>(doc, "debug-logging-checkbox"),
    openDebugFolderBtn: byId<HTMLButtonElement>(doc, "open-debug-folder-btn"),
    debugLogPath: byId<HTMLElement>(doc, "debug-log-path"),
    toggleKeyBtn: byId<HTMLButtonElement>(doc, "toggle-key-visibility"),
    apiKeyHelpBtn: byId<HTMLButtonElement>(doc, "api-key-help-btn"),
    apiKeyHelpModal: byId<HTMLElement>(doc, "api-key-help-modal"),
    closeApiKeyHelpBtn: byId<HTMLButtonElement>(doc, "close-api-key-help-btn"),
    connectionStatus: byId<HTMLElement>(doc, "connection-status"),
    testApiKeyBtn: byId<HTMLButtonElement>(doc, "test-api-key-btn"),
    typingModeRadios: doc.querySelectorAll(
      'input[name="typing-mode"]'
    ) as NodeListOf<HTMLInputElement>,
    typingModeHint: byId<HTMLElement>(doc, "typing-mode-hint"),
    autoStopCheckbox: byId<HTMLInputElement>(doc, "auto-stop-checkbox"),
    silenceTimeoutField: byId<HTMLElement>(doc, "silence-timeout-field"),
    silenceTimeoutInput: byId<HTMLInputElement>(doc, "silence-timeout"),
    languageSelect: byId<HTMLSelectElement>(doc, "language-select"),
    resetDefaultsBtn: byId<HTMLButtonElement>(doc, "reset-defaults-btn"),
    saveStatus: byId<HTMLElement>(doc, "save-status"),
    windowMinimizeBtn: byIdOptional<HTMLButtonElement>(doc, "window-minimize-btn"),
    windowCloseBtn: byId<HTMLButtonElement>(doc, "window-close-btn"),
  };
}

export function populateUI(dom: MainDom, settings: Settings) {
  dom.sttProviderSelect.value = settings.sttProvider;
  dom.apiKeyInput.value = settings.providers[settings.sttProvider].apiKey;
  dom.hotkeyInput.value = settings.hotkey;
  dom.debugLoggingCheckbox.checked = settings.debugLoggingEnabled;

  const cachedModels = settings.providers[settings.sttProvider].modelCache?.models ?? [];
  populateLiveModelOptions(dom, cachedModels, settings.providers[settings.sttProvider].selectedModel);
  if (cachedModels.length === 0) {
    setLiveModelHint(dom, "No cached models yet. Click Refresh to load from API.");
  }

  dom.typingModeRadios.forEach((radio) => {
    radio.checked = radio.value === settings.typingMode;
  });
  updateTypingModeHint(dom, settings.typingMode);

  dom.autoStopCheckbox.checked = settings.autoStopOnSilence;
  dom.silenceTimeoutField.style.display = settings.autoStopOnSilence ? "flex" : "none";
  dom.silenceTimeoutInput.value = String(settings.autoStopSilenceMs / 1000);
  dom.languageSelect.value = settings.language;
  dom.recordingLoudnessInput.value = String(settings.recordingLoudness);
  dom.recordingLoudnessValue.textContent = `${Math.round(settings.recordingLoudness)}%`;
}

export function setLiveModelHint(dom: MainDom, text: string) {
  dom.liveModelHint.textContent = text;
}

export function populateLiveModelOptions(
  dom: MainDom,
  models: string[],
  preferredModel: string
) {
  dom.liveModelSelect.innerHTML = "";

  if (models.length === 0) {
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "No models available";
    dom.liveModelSelect.appendChild(emptyOption);
    dom.liveModelSelect.value = "";
    dom.liveModelSelect.disabled = true;
    return;
  }

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    dom.liveModelSelect.appendChild(option);
  }

  dom.liveModelSelect.disabled = false;
  const selected = models.includes(preferredModel) ? preferredModel : models[0];
  dom.liveModelSelect.value = selected;
}

export function updateTypingModeHint(dom: MainDom, mode: string) {
  if (mode === "all_at_once") {
    dom.typingModeHint.textContent = "Text is typed after you stop recording.";
  } else {
    dom.typingModeHint.textContent =
      "Text appears as you speak. May cause issues in some apps.";
  }
}

export function updateConnectionStatus(
  dom: MainDom,
  status: ConnectionStatus,
  message?: string
) {
  const statusText = dom.connectionStatus.querySelector(".status-text") as HTMLElement;

  dom.connectionStatus.className = "status-indicator";

  switch (status) {
    case "connected":
      dom.connectionStatus.classList.add("connected");
      statusText.textContent = "Ready";
      break;
    case "connecting":
      dom.connectionStatus.classList.add("disconnected");
      statusText.textContent = "Testing...";
      break;
    case "untested":
      dom.connectionStatus.classList.add("untested");
      statusText.textContent = "Not tested";
      break;
    case "error":
      dom.connectionStatus.classList.add("error");
      statusText.textContent = message || "Error";
      break;
    default:
      dom.connectionStatus.classList.add("disconnected");
      statusText.textContent = "Not configured";
  }
}
