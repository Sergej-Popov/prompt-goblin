import { describe, expect, mock, test } from "bun:test";
import { setupMainEventBindings } from "../src/main/event-bindings";
import type { MainDom } from "../src/main/dom";

type Listener = () => void | Promise<void>;

function createEmitterElement<T extends object>(initial: T) {
  const listeners = new Map<string, Listener[]>();
  return Object.assign(initial, {
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    async emit(type: string) {
      for (const listener of listeners.get(type) ?? []) {
        await listener();
      }
    },
  });
}

function createDom(): MainDom {
  const typingModeOne = createEmitterElement({ value: "incremental" });
  const typingModeTwo = createEmitterElement({ value: "all_at_once" });
  const recordingModeToggle = createEmitterElement({ value: "toggle" });
  const recordingModePtt = createEmitterElement({ value: "push_to_talk" });

  return {
    sttProviderSelect: createEmitterElement({}) as any,
    apiKeyInput: createEmitterElement({ value: "", type: "password" }) as any,
    hotkeyInput: createEmitterElement({}) as any,
    liveModelSelect: createEmitterElement({ value: "", disabled: false }) as any,
    refreshModelsBtn: createEmitterElement({}) as any,
    liveModelHint: {} as any,
    microphoneSelect: createEmitterElement({ value: "mic-2" }) as any,
    recordingLoudnessInput: createEmitterElement({}) as any,
    recordingLoudnessValue: {} as any,
    refreshMicrophonesBtn: createEmitterElement({}) as any,
    micTestBtn: createEmitterElement({}) as any,
    continuousMicTestBtn: createEmitterElement({}) as any,
    waveStyleBtn: createEmitterElement({}) as any,
    waveColorBtn: createEmitterElement({}) as any,
    micTestStatus: {} as any,
    micTestTranscript: {} as any,
    micSignalIndicator: {} as any,
    micWaveCanvas: createEmitterElement({}) as any,
    debugLoggingCheckbox: createEmitterElement({ checked: false }) as any,
    openDebugFolderBtn: createEmitterElement({}) as any,
    debugLogPath: {} as any,
    toggleKeyBtn: {} as any,
    apiKeyHelpBtn: {} as any,
    apiKeyHelpModal: {} as any,
    closeApiKeyHelpBtn: {} as any,
    connectionStatus: {} as any,
    testApiKeyBtn: createEmitterElement({ disabled: false }) as any,
    typingModeRadios: [typingModeOne, typingModeTwo] as any,
    typingModeHint: {} as any,
    recordingModeRadios: [recordingModeToggle, recordingModePtt] as any,
    recordingModeHint: { textContent: "" } as any,
    transcriptCorrectionCheckbox: createEmitterElement({ checked: false }) as any,
    transcriptCorrectionHint: {} as any,
    transcriptCorrectionControls: {} as any,
    correctionModelSelect: createEmitterElement({}) as any,
    refreshCorrectionModelsBtn: createEmitterElement({}) as any,
    correctionModelHint: {} as any,
    autoStopCheckbox: createEmitterElement({ checked: true }) as any,
    silenceTimeoutField: { style: { display: "" } } as any,
    silenceTimeoutInput: createEmitterElement({}) as any,
    languageSelect: createEmitterElement({}) as any,
    targetLanguageSelect: createEmitterElement({}) as any,
    lineBreakModeSelect: createEmitterElement({}) as any,
    clipboardModeSelect: createEmitterElement({}) as any,
    listeningDingCheckbox: createEmitterElement({ checked: true }) as any,
    listeningDingSoundSelect: createEmitterElement({ value: "chime", disabled: false }) as any,
    listeningDingVolumeInput: createEmitterElement({ value: "60", disabled: false }) as any,
    listeningDingVolumeValue: { textContent: "60%" } as any,
    resetDefaultsBtn: createEmitterElement({}) as any,
    appToast: {} as any,
    windowMinimizeBtn: null,
    windowCloseBtn: {} as any,
  };
}

describe("event bindings", () => {
  test("wires key UI events to controller methods", async () => {
    const dom = createDom();
    const apiKeyController = {
      handleProviderChange: mock(async () => {}),
      handleApiKeyTest: mock(async () => {}),
      handleLiveModelChange: mock(() => {}),
      handleCorrectionModelChange: mock(() => {}),
      handleApiKeyInput: mock(() => {}),
    } as any;
    const micTestController = { toggle: mock(async () => {}) } as any;
    const settingsController = { scheduleAutosave: mock(() => {}) } as any;
    const refreshLiveModelList = mock(async () => {});
    const refreshCorrectionModelList = mock(async () => {});
    const refreshMicrophoneList = mock(async () => {});
    const handleResetDefaults = mock(async () => {});
    const handleOpenDebugFolder = mock(async () => {});

    setupMainEventBindings({
      dom,
      apiKeyController,
      micTestController,
      settingsController,
      updateTypingModeHint: mock(() => {}),
      updateRecordingModeHint: mock(() => {}),
      updateTranscriptCorrectionUI: mock(() => {}),
      updateRecordingLoudnessValue: mock(() => {}),
      updateListeningDingVolumeValue: mock(() => {}),
      previewListeningDing: mock(() => {}),
      updateWaveToolButtons: mock(() => {}),
      refreshLiveModelList,
      refreshCorrectionModelList,
      refreshMicrophoneList,
      handleOpenAIOAuthLogin: mock(async () => {}),
      handleOpenAIOAuthLogout: mock(() => {}),
      handleResetDefaults,
      handleOpenDebugFolder,
      cycleWaveformStyle: mock(() => {}),
      cycleWaveformColorScheme: mock(() => {}),
      unlockWaveformEasterEgg: mock(() => true),
      restartMicTestIfNeeded: mock(async () => {}),
    });

    await (dom.sttProviderSelect as any).emit("change");
    await (dom.testApiKeyBtn as any).emit("click");
    await (dom.liveModelSelect as any).emit("change");
    await (dom.correctionModelSelect as any).emit("change");
    await (dom.apiKeyInput as any).emit("input");
    await (dom.refreshModelsBtn as any).emit("click");
    await (dom.refreshCorrectionModelsBtn as any).emit("click");
    await (dom.refreshMicrophonesBtn as any).emit("click");
    await (dom.openDebugFolderBtn as any).emit("click");
    await (dom.resetDefaultsBtn as any).emit("click");

    expect(apiKeyController.handleProviderChange).toHaveBeenCalled();
    expect(apiKeyController.handleApiKeyTest).toHaveBeenCalled();
    expect(apiKeyController.handleLiveModelChange).toHaveBeenCalled();
    expect(apiKeyController.handleCorrectionModelChange).toHaveBeenCalled();
    expect(apiKeyController.handleApiKeyInput).toHaveBeenCalled();
    expect(refreshLiveModelList).toHaveBeenCalledWith(true);
    expect(refreshCorrectionModelList).toHaveBeenCalledWith(true);
    expect(refreshMicrophoneList).toHaveBeenCalledWith("mic-2");
    expect(handleOpenDebugFolder).toHaveBeenCalled();
    expect(handleResetDefaults).toHaveBeenCalled();
  });

  test("typing mode and waveform events schedule autosave and update UI", async () => {
    const dom = createDom();
    const settingsController = { scheduleAutosave: mock(() => {}) } as any;
    const updateTypingModeHint = mock(() => {});
    const updateTranscriptCorrectionUI = mock(() => {});
    const updateRecordingLoudnessValue = mock(() => {});
    const updateListeningDingVolumeValue = mock(() => {});
    const previewListeningDing = mock(() => {});
    const updateWaveToolButtons = mock(() => {});
    const cycleWaveformStyle = mock(() => {});
    const cycleWaveformColorScheme = mock(() => {});
    const unlockWaveformEasterEgg = mock(() => true);
    const restartMicTestIfNeeded = mock(async () => {});

    setupMainEventBindings({
      dom,
      apiKeyController: {
        handleProviderChange: async () => {},
        handleApiKeyTest: async () => {},
        handleLiveModelChange: () => {},
        handleCorrectionModelChange: () => {},
        handleApiKeyInput: () => {},
      } as any,
      micTestController: { toggle: async () => {} } as any,
      settingsController,
      updateTypingModeHint,
      updateRecordingModeHint: mock(() => {}),
      updateTranscriptCorrectionUI,
      updateRecordingLoudnessValue,
      updateListeningDingVolumeValue,
      previewListeningDing,
      updateWaveToolButtons,
      refreshLiveModelList: async () => {},
      refreshCorrectionModelList: async () => {},
      refreshMicrophoneList: async () => {},
      handleOpenAIOAuthLogin: async () => {},
      handleOpenAIOAuthLogout: () => {},
      handleResetDefaults: async () => {},
      handleOpenDebugFolder: async () => {},
      cycleWaveformStyle,
      cycleWaveformColorScheme,
      unlockWaveformEasterEgg,
      restartMicTestIfNeeded,
    });

    await (dom.typingModeRadios[0] as any).emit("change");
    await (dom.transcriptCorrectionCheckbox as any).emit("change");
    await (dom.autoStopCheckbox as any).emit("change");
    await (dom.recordingLoudnessInput as any).emit("input");
    await (dom.micWaveCanvas as any).emit("click");
    await (dom.waveStyleBtn as any).emit("click");
    await (dom.waveColorBtn as any).emit("click");
    await (dom.microphoneSelect as any).emit("change");
    await (dom.debugLoggingCheckbox as any).emit("change");
    await (dom.listeningDingCheckbox as any).emit("change");
    await (dom.listeningDingSoundSelect as any).emit("change");
    await (dom.listeningDingVolumeInput as any).emit("input");
    await (dom.clipboardModeSelect as any).emit("change");

    expect(updateTypingModeHint).toHaveBeenCalled();
    expect(updateTranscriptCorrectionUI).toHaveBeenCalled();
    expect(updateRecordingLoudnessValue).toHaveBeenCalled();
    expect(updateListeningDingVolumeValue).toHaveBeenCalled();
    expect(previewListeningDing).toHaveBeenCalled();
    expect(unlockWaveformEasterEgg).toHaveBeenCalled();
    expect(cycleWaveformStyle).toHaveBeenCalledTimes(2);
    expect(cycleWaveformColorScheme).toHaveBeenCalledTimes(1);
    expect(updateWaveToolButtons).toHaveBeenCalledTimes(3);
    expect(restartMicTestIfNeeded).toHaveBeenCalled();
    expect((dom.silenceTimeoutField as any).style.display).toBe("flex");
    expect(settingsController.scheduleAutosave).toHaveBeenCalled();
    expect(settingsController.scheduleAutosave).toHaveBeenCalledWith(0);
  });
});
