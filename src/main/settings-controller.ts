import { reloadSettings } from "../app";
import {
  getDefaultSettings,
  getProviderApiKey,
  saveSettings,
  type LineBreakMode,
  type ListeningDingSound,
  type Settings,
  type SttProvider,
} from "../settings";
import type { ConnectionStatus } from "./dom";
import { normalizeHotkey } from "./utils";

export const AUTOSAVE_DEBOUNCE_MS = 450;

export interface SettingsFormSnapshot {
  apiKey: string;
  providerOption: "gemini" | "openai" | "openai_oauth";
  hotkey: string;
  liveModel: string;
  correctionModel: string;
  microphoneDeviceId: string;
  recordingLoudnessPercent: string;
  debugLoggingEnabled: boolean;
  typingMode: Settings["typingMode"];
  recordingMode: Settings["recordingMode"];
  clipboardMode: Settings["clipboardMode"];
  transcriptCorrectionEnabled: boolean;
  autoStopOnSilence: boolean;
  silenceTimeoutSeconds: string;
  language: string;
  targetLanguage: string;
  lineBreakMode: LineBreakMode;
  playListeningDing: boolean;
  listeningDingSound: ListeningDingSound;
  listeningDingVolumePercent: string;
  holdBeforeType: boolean;
  holdBeforeTypeTimeoutSeconds: string;
}

export interface AutosaveStatus {
  message: string;
  durationMs?: number;
}

export interface SettingsControllerOptions {
  getCurrentSettings: () => Settings;
  setCurrentSettings: (settings: Settings) => void;
  getActiveProvider: () => SttProvider;
  readForm: () => SettingsFormSnapshot;
  applySettingsToUI: (settings: Settings) => void;
  updateApiKeyTextForProvider: () => void;
  setLiveModelHint: (text: string) => void;
  setCorrectionModelHint: (text: string) => void;
  updateConnectionStatus: (status: ConnectionStatus) => void;
  setTestApiKeyEnabled: (enabled: boolean) => void;
  configureDebugLogging: (enabled: boolean) => Promise<void>;
  updateDebugLogHint: () => void;
  showSaveStatus: (message: string, isError?: boolean, durationMs?: number) => void;
  saveSettingsImpl?: (settings: Settings) => Promise<void>;
  reloadSettingsImpl?: (settings: Settings) => void;
  getDefaultSettingsImpl?: () => Settings;
  setTimeoutFn?: typeof window.setTimeout;
  clearTimeoutFn?: typeof window.clearTimeout;
}

export function formatRecordingLoudnessValue(value: string): string {
  const percent = Number.parseFloat(value);
  return Number.isFinite(percent) ? `${Math.round(percent)}%` : "100%";
}

export function getRecordingInputGain(value: string): number {
  const percent = Number.parseFloat(value);
  if (!Number.isFinite(percent)) {
    return 1;
  }
  return Math.min(3, Math.max(0.25, percent / 100));
}

export function buildSettingsFromForm(
  currentSettings: Settings,
  activeProvider: SttProvider,
  form: SettingsFormSnapshot
): Settings {
  const silenceSeconds = Number.parseFloat(form.silenceTimeoutSeconds);
  const autoStopSilenceMs =
    Number.isFinite(silenceSeconds) && silenceSeconds > 0
      ? silenceSeconds * 1000
      : currentSettings.autoStopSilenceMs;

  const recordingLoudnessPercent = Number.parseFloat(form.recordingLoudnessPercent);
  const recordingLoudness =
    Number.isFinite(recordingLoudnessPercent) &&
    recordingLoudnessPercent >= 25 &&
    recordingLoudnessPercent <= 300
      ? recordingLoudnessPercent
      : currentSettings.recordingLoudness;

  const listeningDingVolumePercent = Number.parseFloat(form.listeningDingVolumePercent);
  const listeningDingVolume =
    Number.isFinite(listeningDingVolumePercent) &&
    listeningDingVolumePercent >= 0 &&
    listeningDingVolumePercent <= 100
      ? listeningDingVolumePercent
      : currentSettings.listeningDingVolume;

  const holdBeforeTypeTimeoutRaw = parseInt(form.holdBeforeTypeTimeoutSeconds, 10);
  const holdBeforeTypeTimeoutMs = Number.isFinite(holdBeforeTypeTimeoutRaw)
    ? Math.min(30000, Math.max(0, holdBeforeTypeTimeoutRaw * 1000))
    : currentSettings.holdBeforeTypeTimeoutMs;

  const nextSettings: Settings = {
    ...currentSettings,
    sttProvider: activeProvider,
    providers: {
      gemini: { ...currentSettings.providers.gemini },
      openai: { ...currentSettings.providers.openai },
    },
    transcriptionCorrection: {
      enabled: form.transcriptCorrectionEnabled,
      providers: {
        gemini: { ...currentSettings.transcriptionCorrection.providers.gemini },
        openai: { ...currentSettings.transcriptionCorrection.providers.openai },
      },
    },
    hotkey: normalizeHotkey(form.hotkey),
    microphoneDeviceId: form.microphoneDeviceId || "default",
    recordingLoudness,
    waveformStyle: currentSettings.waveformStyle,
    waveformColorScheme: currentSettings.waveformColorScheme,
    waveformEasterEggUnlocked: currentSettings.waveformEasterEggUnlocked,
    debugLoggingEnabled: form.debugLoggingEnabled,
    typingMode: form.typingMode,
    recordingMode: form.recordingMode,
    clipboardMode: form.clipboardMode,
    autoStopOnSilence: form.autoStopOnSilence,
    autoStopSilenceMs,
    language: form.language,
    targetLanguage: form.targetLanguage,
    lineBreakMode: form.lineBreakMode,
    playListeningDing: form.playListeningDing,
    listeningDingSound: form.listeningDingSound,
    listeningDingVolume,
    holdBeforeType: form.holdBeforeType,
    holdBeforeTypeTimeoutMs,
  };

  nextSettings.providers[activeProvider].apiKey = form.apiKey.trim();
  if (form.providerOption === "openai_oauth") {
    nextSettings.providers.openai.authMode = "oauth_experimental";
  } else if (form.providerOption === "openai") {
    nextSettings.providers.openai.authMode = "api_key";
  }
  nextSettings.providers[activeProvider].selectedModel =
    form.liveModel || currentSettings.providers[activeProvider].selectedModel;
  nextSettings.transcriptionCorrection.providers[activeProvider].selectedModel =
    form.correctionModel || currentSettings.transcriptionCorrection.providers[activeProvider].selectedModel;

  return nextSettings;
}

export class SettingsController {
  private autosaveTimer: number | null = null;
  private saveInFlight = false;
  private savePending = false;
  private nextAutosaveStatus: AutosaveStatus | null = null;
  private readonly saveSettingsImpl;
  private readonly reloadSettingsImpl;
  private readonly getDefaultSettingsImpl;
  private readonly setTimeoutFn;
  private readonly clearTimeoutFn;

  constructor(private readonly options: SettingsControllerOptions) {
    this.saveSettingsImpl = options.saveSettingsImpl ?? saveSettings;
    this.reloadSettingsImpl = options.reloadSettingsImpl ?? reloadSettings;
    this.getDefaultSettingsImpl = options.getDefaultSettingsImpl ?? getDefaultSettings;
    this.setTimeoutFn = options.setTimeoutFn ?? window.setTimeout.bind(window);
    this.clearTimeoutFn = options.clearTimeoutFn ?? window.clearTimeout.bind(window);
  }

  setNextAutosaveStatus(status: AutosaveStatus | null) {
    this.nextAutosaveStatus = status;
  }

  scheduleAutosave(delayMs = AUTOSAVE_DEBOUNCE_MS) {
    if (this.autosaveTimer !== null) {
      this.clearTimeoutFn(this.autosaveTimer);
    }

    this.autosaveTimer = this.setTimeoutFn(() => {
      this.autosaveTimer = null;
      const status = this.nextAutosaveStatus;
      this.nextAutosaveStatus = null;
      void this.persistFromUI(status?.message ?? "Saved", status?.durationMs);
    }, delayMs);
  }

  cancelAutosave() {
    if (this.autosaveTimer !== null) {
      this.clearTimeoutFn(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  async persistFromUI(successMessage: string, successDurationMs?: number) {
    if (this.saveInFlight) {
      this.savePending = true;
      return;
    }

    this.saveInFlight = true;
    const newSettings = buildSettingsFromForm(
      this.options.getCurrentSettings(),
      this.options.getActiveProvider(),
      this.options.readForm()
    );

    try {
      await this.saveSettingsImpl(newSettings);
      this.options.setCurrentSettings(newSettings);
      await this.options.configureDebugLogging(newSettings.debugLoggingEnabled);
      this.options.updateDebugLogHint();
      this.reloadSettingsImpl(newSettings);

      const providerApiKey = getProviderApiKey(newSettings, newSettings.sttProvider);
      this.options.updateConnectionStatus(providerApiKey ? "untested" : "disconnected");
      this.options.setTestApiKeyEnabled(Boolean(providerApiKey));
      this.options.showSaveStatus(successMessage, false, successDurationMs);
    } catch (err) {
      console.error("Failed to save settings:", err);
      this.options.showSaveStatus("Save failed", true);
    } finally {
      this.saveInFlight = false;
      if (this.savePending) {
        this.savePending = false;
        await this.persistFromUI("Saved");
      }
    }
  }

  async resetToDefaults() {
    this.cancelAutosave();

    const defaults = this.getDefaultSettingsImpl();
    this.options.setCurrentSettings(defaults);
    this.options.applySettingsToUI(defaults);
    this.options.updateApiKeyTextForProvider();
    this.options.setLiveModelHint("Enter API key to fetch models.");
    this.options.setCorrectionModelHint("Enter API key to fetch correction models.");
    this.options.updateConnectionStatus("disconnected");
    this.options.setTestApiKeyEnabled(false);

    await this.persistFromUI("Defaults restored");
  }
}
