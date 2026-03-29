import {
  byId,
  byIdOptional,
  populateSelectOptions,
} from "@goblin-systems/goblin-design-system";
import type { Settings } from "../settings";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "untested";

export interface MainDom {
  sttProviderSelect: HTMLSelectElement;
  credentialSectionTitle: HTMLElement;
  apiKeyControls: HTMLElement;
  apiKeyInputRow: HTMLElement;
  apiKeyInput: HTMLInputElement;
  openaiOauthLoginBtn: HTMLButtonElement;
  openaiOauthLogoutBtn: HTMLButtonElement;
  openaiOauthStatus: HTMLElement;
  openaiOauthControls: HTMLElement;
  openaiDeviceAuthRow: HTMLElement;
  openaiDeviceUserCode: HTMLElement;
  openaiDeviceCopyBtn: HTMLButtonElement;
  hotkeyInput: HTMLInputElement;
  liveModelSelect: HTMLSelectElement;
  refreshModelsBtn: HTMLButtonElement;
  liveModelHint: HTMLElement;
  microphoneSelect: HTMLSelectElement;
  recordingLoudnessInput: HTMLInputElement;
  recordingLoudnessValue: HTMLElement;
  refreshMicrophonesBtn: HTMLButtonElement;
  micTestBtn: HTMLButtonElement;
  continuousMicTestBtn: HTMLButtonElement;
  waveStyleBtn: HTMLButtonElement;
  waveColorBtn: HTMLButtonElement;
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
  apiKeyHelpTitle: HTMLElement;
  apiKeyHelpList: HTMLOListElement;
  apiKeyHelpHint: HTMLElement;
  closeApiKeyHelpBtn: HTMLButtonElement;
  connectionStatus: HTMLElement;
  testApiKeyBtn: HTMLButtonElement;
  typingModeRadios: NodeListOf<HTMLInputElement>;
  typingModeHint: HTMLElement;
  recordingModeRadios: NodeListOf<HTMLInputElement>;
  recordingModeHint: HTMLElement;
  transcriptCorrectionCheckbox: HTMLInputElement;
  transcriptCorrectionHint: HTMLElement;
  transcriptCorrectionControls: HTMLElement;
  correctionModelSelect: HTMLSelectElement;
  refreshCorrectionModelsBtn: HTMLButtonElement;
  correctionModelHint: HTMLElement;
  autoStopCheckbox: HTMLInputElement;
  silenceTimeoutField: HTMLElement;
  silenceTimeoutInput: HTMLInputElement;
  languageSelect: HTMLSelectElement;
  targetLanguageSelect: HTMLSelectElement;
  lineBreakModeSelect: HTMLSelectElement;
  clipboardModeSelect: HTMLSelectElement;
  listeningDingCheckbox: HTMLInputElement;
  listeningDingSoundSelect: HTMLSelectElement;
  listeningDingVolumeInput: HTMLInputElement;
  listeningDingVolumeValue: HTMLElement;
  resetDefaultsBtn: HTMLButtonElement;
  appToast: HTMLElement;
  windowMinimizeBtn: HTMLButtonElement | null;
  windowCloseBtn: HTMLButtonElement;
}

export function getMainDom(doc: Document): MainDom {
  const createFallbackElement = <T extends HTMLElement>(tag: string): T => {
    const creator =
      typeof document !== "undefined" && typeof document.createElement === "function"
        ? document
        : null;
    if (creator) {
      return creator.createElement(tag) as T;
    }

    return {
      hidden: true,
      disabled: true,
      textContent: "",
      addEventListener: () => {},
    } as unknown as T;
  };

  const fallbackButton = () => createFallbackElement<HTMLButtonElement>("button");
  const fallbackDiv = () => createFallbackElement<HTMLElement>("div");

  return {
    credentialSectionTitle: byIdOptional<HTMLElement>("credential-section-title", doc) ?? fallbackDiv(),
    apiKeyControls: byIdOptional<HTMLElement>("api-key-controls", doc) ?? fallbackDiv(),
    apiKeyInputRow: byIdOptional<HTMLElement>("api-key-input-row", doc) ?? fallbackDiv(),
    apiKeyInput: byId<HTMLInputElement>("api-key-input", doc),
    openaiOauthLoginBtn: byIdOptional<HTMLButtonElement>("openai-oauth-login-btn", doc) ?? fallbackButton(),
    openaiOauthLogoutBtn: byIdOptional<HTMLButtonElement>("openai-oauth-logout-btn", doc) ?? fallbackButton(),
    openaiOauthStatus: byIdOptional<HTMLElement>("openai-oauth-status", doc) ?? fallbackDiv(),
    openaiOauthControls: byIdOptional<HTMLElement>("openai-oauth-controls", doc) ?? fallbackDiv(),
    openaiDeviceAuthRow: byIdOptional<HTMLElement>("openai-device-auth-row", doc) ?? fallbackDiv(),
    openaiDeviceUserCode: byIdOptional<HTMLElement>("openai-device-user-code", doc) ?? fallbackDiv(),
    openaiDeviceCopyBtn: byIdOptional<HTMLButtonElement>("openai-device-copy-btn", doc) ?? fallbackButton(),
    sttProviderSelect: byId<HTMLSelectElement>("stt-provider-select", doc),
    hotkeyInput: byId<HTMLInputElement>("hotkey-input", doc),
    liveModelSelect: byId<HTMLSelectElement>("live-model-select", doc),
    refreshModelsBtn: byId<HTMLButtonElement>("refresh-models-btn", doc),
    liveModelHint: byId<HTMLElement>("live-model-hint", doc),
    microphoneSelect: byId<HTMLSelectElement>("microphone-select", doc),
    recordingLoudnessInput: byId<HTMLInputElement>("recording-loudness", doc),
    recordingLoudnessValue: byId<HTMLElement>("recording-loudness-value", doc),
    refreshMicrophonesBtn: byId<HTMLButtonElement>("refresh-microphones-btn", doc),
    micTestBtn: byId<HTMLButtonElement>("mic-test-btn", doc),
    continuousMicTestBtn: byId<HTMLButtonElement>("continuous-mic-test-btn", doc),
    waveStyleBtn: byId<HTMLButtonElement>("wave-style-btn", doc),
    waveColorBtn: byId<HTMLButtonElement>("wave-color-btn", doc),
    micTestStatus: byId<HTMLElement>("mic-test-status", doc),
    micTestTranscript: byId<HTMLElement>("mic-test-transcript", doc),
    micSignalIndicator: byId<HTMLElement>("mic-signal-indicator", doc),
    micWaveCanvas: byId<HTMLCanvasElement>("mic-wave-canvas", doc),
    debugLoggingCheckbox: byId<HTMLInputElement>("debug-logging-checkbox", doc),
    openDebugFolderBtn: byId<HTMLButtonElement>("open-debug-folder-btn", doc),
    debugLogPath: byId<HTMLElement>("debug-log-path", doc),
    toggleKeyBtn: byId<HTMLButtonElement>("toggle-key-visibility", doc),
    apiKeyHelpBtn: byId<HTMLButtonElement>("api-key-help-btn", doc),
    apiKeyHelpModal: byId<HTMLElement>("api-key-help-modal", doc),
    apiKeyHelpTitle: byIdOptional<HTMLElement>("api-key-help-title", doc) ?? fallbackDiv(),
    apiKeyHelpList:
      byIdOptional<HTMLOListElement>("api-key-help-list", doc) ??
      (createFallbackElement<HTMLOListElement>("ol") as HTMLOListElement),
    apiKeyHelpHint: byIdOptional<HTMLElement>("api-key-help-hint", doc) ?? fallbackDiv(),
    closeApiKeyHelpBtn: byId<HTMLButtonElement>("close-api-key-help-btn", doc),
    connectionStatus: byId<HTMLElement>("connection-status", doc),
    testApiKeyBtn: byId<HTMLButtonElement>("test-api-key-btn", doc),
    typingModeRadios: doc.querySelectorAll(
      'input[name="typing-mode"]'
    ) as NodeListOf<HTMLInputElement>,
    typingModeHint: byId<HTMLElement>("typing-mode-hint", doc),
    recordingModeRadios: doc.querySelectorAll(
      'input[name="recording-mode"]'
    ) as NodeListOf<HTMLInputElement>,
    recordingModeHint: byId<HTMLElement>("recording-mode-hint", doc),
    transcriptCorrectionCheckbox: byId<HTMLInputElement>("transcript-correction-checkbox", doc),
    transcriptCorrectionHint: byId<HTMLElement>("transcript-correction-hint", doc),
    transcriptCorrectionControls: byId<HTMLElement>("transcript-correction-controls", doc),
    correctionModelSelect: byId<HTMLSelectElement>("correction-model-select", doc),
    refreshCorrectionModelsBtn: byId<HTMLButtonElement>("refresh-correction-models-btn", doc),
    correctionModelHint: byId<HTMLElement>("correction-model-hint", doc),
    autoStopCheckbox: byId<HTMLInputElement>("auto-stop-checkbox", doc),
    silenceTimeoutField: byId<HTMLElement>("silence-timeout-field", doc),
    silenceTimeoutInput: byId<HTMLInputElement>("silence-timeout", doc),
    languageSelect: byId<HTMLSelectElement>("language-select", doc),
    targetLanguageSelect: byId<HTMLSelectElement>("target-language-select", doc),
    lineBreakModeSelect: byId<HTMLSelectElement>("line-break-mode-select", doc),
    clipboardModeSelect: byId<HTMLSelectElement>("clipboard-mode-select", doc),
    listeningDingCheckbox: byId<HTMLInputElement>("listening-ding-checkbox", doc),
    listeningDingSoundSelect: byId<HTMLSelectElement>("listening-ding-sound-select", doc),
    listeningDingVolumeInput: byId<HTMLInputElement>("listening-ding-volume", doc),
    listeningDingVolumeValue: byId<HTMLElement>("listening-ding-volume-value", doc),
    resetDefaultsBtn: byId<HTMLButtonElement>("reset-defaults-btn", doc),
    appToast: byId<HTMLElement>("app-toast", doc),
    windowMinimizeBtn: byIdOptional<HTMLButtonElement>("window-minimize-btn", doc),
    windowCloseBtn: byId<HTMLButtonElement>("window-close-btn", doc),
  };
}

export function populateUI(dom: MainDom, settings: Settings) {
  dom.sttProviderSelect.value = settings.sttProvider;
  if (settings.sttProvider === "openai" && settings.providers.openai.authMode === "oauth_experimental") {
    dom.sttProviderSelect.value = "openai_oauth";
  }
  dom.apiKeyInput.value = settings.providers[settings.sttProvider].apiKey;
  const oauthSession = settings.providers.openai.oauthSession;
  dom.openaiOauthStatus.textContent = oauthSession
    ? `Connected (${oauthSession.planType}, experimental)`
    : "Not connected (experimental)";
  dom.openaiOauthControls.hidden = dom.sttProviderSelect.value !== "openai_oauth";
  dom.openaiOauthLoginBtn.hidden = !!oauthSession;
  dom.openaiOauthLogoutBtn.hidden = !oauthSession;
  dom.openaiOauthLogoutBtn.disabled = !oauthSession;
  dom.openaiDeviceAuthRow.hidden = true;
  dom.openaiDeviceUserCode.textContent = "";
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

  dom.recordingModeRadios.forEach((radio) => {
    radio.checked = radio.value === settings.recordingMode;
  });

  dom.transcriptCorrectionCheckbox.checked = settings.transcriptionCorrection.enabled;
  const correctionModels =
    settings.transcriptionCorrection.providers[settings.sttProvider].modelCache?.models ?? [];
  populateCorrectionModelOptions(
    dom,
    correctionModels,
    settings.transcriptionCorrection.providers[settings.sttProvider].selectedModel
  );
  if (correctionModels.length === 0) {
    setCorrectionModelHint(dom, "No cached correction models yet. Click Refresh to load from API.");
  }
  updateTranscriptCorrectionUI(
    dom,
    settings.typingMode,
    settings.transcriptionCorrection.enabled
  );

  dom.autoStopCheckbox.checked = settings.autoStopOnSilence;
  dom.silenceTimeoutField.style.display = settings.autoStopOnSilence ? "flex" : "none";
  dom.silenceTimeoutInput.value = String(settings.autoStopSilenceMs / 1000);
  dom.languageSelect.value = settings.language;
  dom.targetLanguageSelect.value = settings.targetLanguage;
  dom.lineBreakModeSelect.value = settings.lineBreakMode;
  dom.clipboardModeSelect.value = settings.clipboardMode;
  dom.listeningDingCheckbox.checked = settings.playListeningDing;
  dom.listeningDingSoundSelect.value = settings.listeningDingSound;
  dom.listeningDingVolumeInput.value = String(settings.listeningDingVolume);
  dom.listeningDingVolumeValue.textContent = `${Math.round(settings.listeningDingVolume)}%`;
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
  populateModelOptions(dom.liveModelSelect, models, preferredModel);
}

export function setCorrectionModelHint(dom: MainDom, text: string) {
  dom.correctionModelHint.textContent = text;
}

export function populateCorrectionModelOptions(
  dom: MainDom,
  models: string[],
  preferredModel: string
) {
  populateModelOptions(dom.correctionModelSelect, models, preferredModel);
}

function populateModelOptions(
  select: HTMLSelectElement,
  models: string[],
  preferredModel: string
) {
  if (models.length === 0) {
    populateSelectOptions(select, [], "");
    return;
  }

  const selected = models.includes(preferredModel) ? preferredModel : models[0];
  populateSelectOptions(select, models, selected);
}

export function updateTypingModeHint(dom: MainDom, mode: string) {
  if (mode === "all_at_once") {
    dom.typingModeHint.textContent = "Text is typed after you stop recording.";
  } else {
    dom.typingModeHint.textContent =
      "Text appears as you speak. May cause issues in some apps.";
  }
}

export function updateTranscriptCorrectionUI(
  dom: MainDom,
  typingMode: Settings["typingMode"],
  enabled: boolean
) {
  const available = typingMode === "all_at_once";
  const controlsEnabled = available && enabled;

  dom.transcriptCorrectionCheckbox.disabled = !available;
  dom.correctionModelSelect.disabled = !controlsEnabled || dom.correctionModelSelect.options.length === 0;
  dom.refreshCorrectionModelsBtn.disabled = !controlsEnabled;
  dom.transcriptCorrectionControls.classList.toggle("is-disabled", !controlsEnabled);

  if (!available) {
    dom.transcriptCorrectionHint.textContent =
      "AI transcript correction is available only in Type all at once mode.";
  } else if (!enabled) {
    dom.transcriptCorrectionHint.textContent =
      "Beta feature. Enable it to clean up the final transcript before typing.";
  } else {
    dom.transcriptCorrectionHint.textContent =
      "Cleans up the final transcript with a language model before typing. Spoken command words are preserved.";
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

export function getSelectedRecordingMode(dom: MainDom): "toggle" | "push_to_talk" {
  for (const radio of dom.recordingModeRadios) {
    if (radio.checked && (radio.value === "toggle" || radio.value === "push_to_talk")) {
      return radio.value;
    }
  }
  return "toggle";
}
