import type { MainDom } from "./dom";
import type { ApiKeyController } from "./api-key-controller";
import type { MicTestController } from "./mic-test-controller";
import type { SettingsController } from "./settings-controller";

type AsyncVoid = () => Promise<void>;

export interface EventBindingOptions {
  dom: MainDom;
  apiKeyController: ApiKeyController;
  micTestController: MicTestController;
  settingsController: SettingsController;
  updateTypingModeHint: () => void;
  updateRecordingModeHint: () => void;
  updateTranscriptCorrectionUI: () => void;
  updateRecordingLoudnessValue: () => void;
  updateListeningDingVolumeValue: () => void;
  previewListeningDing: () => void;
  updateWaveToolButtons: () => void;
  refreshLiveModelList: (forceApiRefresh: boolean) => Promise<void>;
  refreshCorrectionModelList: (forceApiRefresh: boolean) => Promise<void>;
  refreshMicrophoneList: (preferredDeviceId: string) => Promise<void>;
  handleOpenAIOAuthLogin: AsyncVoid;
  handleOpenAIOAuthLogout: () => void;
  handleOpenAIDeviceCodeCopy?: () => Promise<void>;
  handleResetDefaults: AsyncVoid;
  handleOpenDebugFolder: AsyncVoid;
  cycleWaveformStyle: () => void;
  cycleWaveformColorScheme: () => void;
  unlockWaveformEasterEgg: () => boolean;
  restartMicTestIfNeeded: AsyncVoid;
}

export function setupMainEventBindings(options: EventBindingOptions) {
  const {
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
    handleResetDefaults,
    handleOpenDebugFolder,
    cycleWaveformStyle,
    cycleWaveformColorScheme,
    unlockWaveformEasterEgg,
    restartMicTestIfNeeded,
  } = options;

  dom.sttProviderSelect.addEventListener("change", async () => {
    await apiKeyController.handleProviderChange();
  });

  dom.typingModeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      updateTypingModeHint();
      updateTranscriptCorrectionUI();
      settingsController.scheduleAutosave(0);
    });
  });

  dom.recordingModeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      updateRecordingModeHint();
      settingsController.scheduleAutosave(0);
    });
  });

  dom.transcriptCorrectionCheckbox.addEventListener("change", () => {
    updateTranscriptCorrectionUI();
    settingsController.scheduleAutosave(0);
  });

  dom.autoStopCheckbox.addEventListener("change", () => {
    dom.silenceTimeoutField.style.display = dom.autoStopCheckbox.checked ? "flex" : "none";
    settingsController.scheduleAutosave(0);
  });

  const applyListeningDingControlState = () => {
    const enabled = dom.listeningDingCheckbox.checked;
    dom.listeningDingSoundSelect.disabled = !enabled;
    dom.listeningDingVolumeInput.disabled = !enabled;
  };

  applyListeningDingControlState();

  dom.resetDefaultsBtn.addEventListener("click", async () => {
    await handleResetDefaults();
  });

  dom.testApiKeyBtn.addEventListener("click", async () => {
    await apiKeyController.handleApiKeyTest();
  });

  dom.refreshModelsBtn.addEventListener("click", async () => {
    await refreshLiveModelList(true);
  });

  dom.refreshCorrectionModelsBtn.addEventListener("click", async () => {
    await refreshCorrectionModelList(true);
  });

  dom.liveModelSelect.addEventListener("change", () => {
    apiKeyController.handleLiveModelChange();
  });

  dom.correctionModelSelect.addEventListener("change", () => {
    apiKeyController.handleCorrectionModelChange();
  });

  dom.apiKeyInput.addEventListener("input", () => {
    apiKeyController.handleApiKeyInput();
  });

  dom.openaiOauthLoginBtn?.addEventListener("click", async () => {
    await handleOpenAIOAuthLogin();
  });

  dom.openaiOauthLogoutBtn?.addEventListener("click", () => {
    handleOpenAIOAuthLogout();
  });

  dom.openaiDeviceCopyBtn?.addEventListener("click", async () => {
    await handleOpenAIDeviceCodeCopy?.();
  });

  dom.hotkeyInput.addEventListener("input", () => settingsController.scheduleAutosave());
  dom.silenceTimeoutInput.addEventListener("input", () => settingsController.scheduleAutosave());
  dom.languageSelect.addEventListener("change", () => settingsController.scheduleAutosave(0));
  dom.targetLanguageSelect.addEventListener("change", () => settingsController.scheduleAutosave(0));
  dom.lineBreakModeSelect.addEventListener("change", () => settingsController.scheduleAutosave(0));
  dom.clipboardModeSelect.addEventListener("change", () => settingsController.scheduleAutosave(0));
  dom.listeningDingCheckbox.addEventListener("change", () => {
    applyListeningDingControlState();
    if (dom.listeningDingCheckbox.checked) {
      previewListeningDing();
    }
    settingsController.scheduleAutosave(0);
  });
  dom.listeningDingSoundSelect.addEventListener("change", () => {
    previewListeningDing();
    settingsController.scheduleAutosave(0);
  });
  dom.listeningDingVolumeInput.addEventListener("input", () => {
    updateListeningDingVolumeValue();
    previewListeningDing();
    settingsController.scheduleAutosave();
  });

  dom.refreshMicrophonesBtn.addEventListener("click", async () => {
    await refreshMicrophoneList(dom.microphoneSelect.value || "default");
  });

  dom.recordingLoudnessInput.addEventListener("input", () => {
    updateRecordingLoudnessValue();
    settingsController.scheduleAutosave();
  });

  dom.micTestBtn.addEventListener("click", async () => {
    await micTestController.toggle("timed");
  });

  dom.continuousMicTestBtn.addEventListener("click", async () => {
    await micTestController.toggle("continuous");
  });

  dom.micWaveCanvas.addEventListener("click", () => {
    unlockWaveformEasterEgg();
    cycleWaveformStyle();
    updateWaveToolButtons();
    settingsController.scheduleAutosave(0);
  });

  dom.waveStyleBtn.addEventListener("click", () => {
    cycleWaveformStyle();
    updateWaveToolButtons();
    settingsController.scheduleAutosave(0);
  });

  dom.waveColorBtn.addEventListener("click", () => {
    cycleWaveformColorScheme();
    updateWaveToolButtons();
    settingsController.scheduleAutosave(0);
  });

  dom.microphoneSelect.addEventListener("change", async () => {
    await restartMicTestIfNeeded();
    settingsController.scheduleAutosave(0);
  });

  dom.debugLoggingCheckbox.addEventListener("change", () => {
    settingsController.scheduleAutosave(0);
  });

  dom.openDebugFolderBtn.addEventListener("click", async () => {
    await handleOpenDebugFolder();
  });
}
