import {
  isWaveformColorScheme,
  isWaveformStyle,
  type WaveformColorScheme,
  type WaveformStyle,
} from "@goblin-systems/goblin-design-system";
import { load, Store } from "@tauri-apps/plugin-store";
import { DEFAULT_TEXT_COMMANDS, type TextCommand } from "./text-commands";

export type SttProvider = "gemini" | "openai";
export type LineBreakMode = "enter" | "shift_enter" | "ctrl_enter";
export type ListeningDingSound = "chime" | "soft" | "digital";
export type OpenAIAuthMode = "api_key" | "oauth_experimental";

export interface ProviderModelCache {
  apiKeyFingerprint: string;
  fetchedAt: number;
  models: string[];
}

export interface GeminiProviderSettings {
  apiKey: string;
  selectedModel: string;
  lastKnownGoodModel: string;
  modelCache: ProviderModelCache | null;
}

export interface OpenAIProviderSettings {
  authMode: OpenAIAuthMode;
  apiKey: string;
  oauthSession: OpenAIOAuthSession | null;
  selectedModel: string;
  lastKnownGoodModel: string;
  modelCache: ProviderModelCache | null;
}

export interface OpenAIOAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  planType: string;
}

export type ProviderAuth =
  | { type: "api_key"; token: string }
  | {
      type: "oauth";
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      accountId: string;
      planType: string;
    };

export interface CorrectionProviderSettings {
  selectedModel: string;
  lastKnownGoodModel: string;
  modelCache: ProviderModelCache | null;
}

export interface TranscriptionCorrectionSettings {
  enabled: boolean;
  providers: {
    gemini: CorrectionProviderSettings;
    openai: CorrectionProviderSettings;
  };
}

export interface Settings {
  sttProvider: SttProvider;
  providers: {
    gemini: GeminiProviderSettings;
    openai: OpenAIProviderSettings;
  };
  transcriptionCorrection: TranscriptionCorrectionSettings;
  hotkey: string;
  microphoneDeviceId: string;
  recordingLoudness: number;
  waveformStyle: WaveformStyle;
  waveformColorScheme: WaveformColorScheme;
  waveformEasterEggUnlocked: boolean;
  debugLoggingEnabled: boolean;
  typingMode: "all_at_once" | "incremental";
  recordingMode: "toggle" | "push_to_talk";
  clipboardMode: "typing_only" | "typing_with_fallback" | "typing_and_clipboard" | "clipboard_only";
  autoStopOnSilence: boolean;
  autoStopSilenceMs: number;
  language: string;
  targetLanguage: string;
  lineBreakMode: LineBreakMode;
  playListeningDing: boolean;
  listeningDingSound: ListeningDingSound;
  listeningDingVolume: number;
  textCommandsEnabled: boolean;
  customTextCommands: TextCommand[];
}

const DEFAULTS: Settings = {
  sttProvider: "gemini",
  providers: {
    gemini: {
      apiKey: "",
      selectedModel: "",
      lastKnownGoodModel: "",
      modelCache: null,
    },
    openai: {
      authMode: "api_key",
      apiKey: "",
      oauthSession: null,
      selectedModel: "",
      lastKnownGoodModel: "",
      modelCache: null,
    },
  },
  transcriptionCorrection: {
    enabled: false,
    providers: {
      gemini: {
        selectedModel: "",
        lastKnownGoodModel: "",
        modelCache: null,
      },
      openai: {
        selectedModel: "",
        lastKnownGoodModel: "",
        modelCache: null,
      },
    },
  },
  hotkey: "Alt+G",
  microphoneDeviceId: "default",
  recordingLoudness: 100,
  waveformStyle: "classic",
  waveformColorScheme: "aurora",
  waveformEasterEggUnlocked: false,
  debugLoggingEnabled: false,
  typingMode: "incremental",
  recordingMode: "toggle",
  clipboardMode: "typing_only",
  autoStopOnSilence: true,
  autoStopSilenceMs: 4000,
  language: "auto",
  targetLanguage: "",
  lineBreakMode: "enter",
  playListeningDing: true,
  listeningDingSound: "chime",
  listeningDingVolume: 60,
  textCommandsEnabled: true,
  customTextCommands: [],
};

function isListeningDingSound(value: unknown): value is ListeningDingSound {
  return value === "chime" || value === "soft" || value === "digital";
}

export function getDefaultSettings(): Settings {
  return {
    ...DEFAULTS,
    providers: {
      gemini: { ...DEFAULTS.providers.gemini },
      openai: { ...DEFAULTS.providers.openai },
    },
    transcriptionCorrection: {
      enabled: DEFAULTS.transcriptionCorrection.enabled,
      providers: {
        gemini: { ...DEFAULTS.transcriptionCorrection.providers.gemini },
        openai: { ...DEFAULTS.transcriptionCorrection.providers.openai },
      },
    },
  };
}

const LEGACY_DEFAULT_HOTKEY = "Alt+Super+G";

let store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await load("settings.json", { autoSave: true, defaults: {} });
  }
  return store;
}

function toProviderModelCache(value: unknown): ProviderModelCache | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybe = value as {
    apiKeyFingerprint?: unknown;
    fetchedAt?: unknown;
    models?: unknown;
  };

  if (
    typeof maybe.apiKeyFingerprint !== "string" ||
    typeof maybe.fetchedAt !== "number" ||
    !Array.isArray(maybe.models)
  ) {
    return null;
  }

  return {
    apiKeyFingerprint: maybe.apiKeyFingerprint,
    fetchedAt: maybe.fetchedAt,
    models: maybe.models.filter((m): m is string => typeof m === "string"),
  };
}

function hydrateSelectedModelFromCache(settings: Settings, provider: SttProvider) {
  const providerSettings = settings.providers[provider];
  if (!providerSettings.selectedModel && providerSettings.modelCache?.models.length) {
    providerSettings.selectedModel = providerSettings.modelCache.models[0];
  }
}

function hydrateCorrectionSelectedModelFromCache(settings: Settings, provider: SttProvider) {
  const providerSettings = settings.transcriptionCorrection.providers[provider];
  if (!providerSettings.selectedModel && providerSettings.modelCache?.models.length) {
    providerSettings.selectedModel = providerSettings.modelCache.models[0];
  }
}

function toTextCommands(value: unknown): TextCommand[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const maybe = entry as { phrase?: unknown; replacement?: unknown };
      if (typeof maybe.phrase !== "string" || typeof maybe.replacement !== "string") {
        return null;
      }

      const phrase = maybe.phrase.trim();
      if (!phrase) {
        return null;
      }

      return {
        phrase,
        replacement: maybe.replacement,
      };
    })
    .filter((entry): entry is TextCommand => entry !== null);
}

export async function loadSettings(): Promise<Settings> {
  const s = await getStore();
  const settings: Settings = getDefaultSettings();

  const sttProvider = await s.get<string>("sttProvider");
  if (sttProvider === "gemini" || sttProvider === "openai") {
    settings.sttProvider = sttProvider;
  }

  const providers = await s.get<Settings["providers"]>("providers");
  if (providers && typeof providers === "object") {
    if (providers.gemini && typeof providers.gemini === "object") {
      const gemini = providers.gemini as Partial<GeminiProviderSettings>;
      if (typeof gemini.apiKey === "string") settings.providers.gemini.apiKey = gemini.apiKey;
      if (typeof gemini.selectedModel === "string") {
        settings.providers.gemini.selectedModel = gemini.selectedModel;
      }
      if (typeof gemini.lastKnownGoodModel === "string") {
        settings.providers.gemini.lastKnownGoodModel = gemini.lastKnownGoodModel;
      }
      settings.providers.gemini.modelCache = toProviderModelCache(gemini.modelCache);
    }

    if (providers.openai && typeof providers.openai === "object") {
      const openai = providers.openai as Partial<OpenAIProviderSettings>;
      if (openai.authMode === "api_key" || openai.authMode === "oauth_experimental") {
        settings.providers.openai.authMode = openai.authMode;
      }
      if (typeof openai.apiKey === "string") settings.providers.openai.apiKey = openai.apiKey;
      if (openai.oauthSession && typeof openai.oauthSession === "object") {
        const session = openai.oauthSession as Partial<OpenAIOAuthSession>;
        if (
          typeof session.accessToken === "string" &&
          typeof session.refreshToken === "string" &&
          typeof session.expiresAt === "number" &&
          typeof session.accountId === "string" &&
          typeof session.planType === "string"
        ) {
          settings.providers.openai.oauthSession = {
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            expiresAt: session.expiresAt,
            accountId: session.accountId,
            planType: session.planType,
          };
        }
      }
      if (typeof openai.selectedModel === "string") {
        settings.providers.openai.selectedModel = openai.selectedModel;
      }
      if (typeof openai.lastKnownGoodModel === "string") {
        settings.providers.openai.lastKnownGoodModel = openai.lastKnownGoodModel;
      }
      settings.providers.openai.modelCache = toProviderModelCache(openai.modelCache);
    }
  }

  const transcriptionCorrection = await s.get<Settings["transcriptionCorrection"]>(
    "transcriptionCorrection"
  );
  if (transcriptionCorrection && typeof transcriptionCorrection === "object") {
    if (typeof transcriptionCorrection.enabled === "boolean") {
      settings.transcriptionCorrection.enabled = transcriptionCorrection.enabled;
    }

    const providers = transcriptionCorrection.providers;
    if (providers && typeof providers === "object") {
      for (const provider of ["gemini", "openai"] as const) {
        const providerSettings = providers[provider];
        if (!providerSettings || typeof providerSettings !== "object") {
          continue;
        }

        if (typeof providerSettings.selectedModel === "string") {
          settings.transcriptionCorrection.providers[provider].selectedModel =
            providerSettings.selectedModel;
        }
        if (typeof providerSettings.lastKnownGoodModel === "string") {
          settings.transcriptionCorrection.providers[provider].lastKnownGoodModel =
            providerSettings.lastKnownGoodModel;
        }
        settings.transcriptionCorrection.providers[provider].modelCache =
          toProviderModelCache(providerSettings.modelCache);
      }
    }
  }

  // Legacy migration for pre-provider settings
  const legacyApiKey = await s.get<string>("geminiApiKey");
  if (legacyApiKey !== undefined && legacyApiKey !== null && !settings.providers.gemini.apiKey) {
    settings.providers.gemini.apiKey = legacyApiKey;
  }

  const hotkey = await s.get<string>("hotkey");
  if (hotkey !== undefined && hotkey !== null) settings.hotkey = hotkey;

  const recordingMode = await s.get<string>("recordingMode");
  if (recordingMode === "toggle" || recordingMode === "push_to_talk") {
    settings.recordingMode = recordingMode;
  }

  const clipboardMode = await s.get<string>("clipboardMode");
  if (
    clipboardMode === "typing_only" ||
    clipboardMode === "typing_with_fallback" ||
    clipboardMode === "typing_and_clipboard" ||
    clipboardMode === "clipboard_only"
  ) {
    settings.clipboardMode = clipboardMode;
  }

  const microphoneDeviceId = await s.get<string>("microphoneDeviceId");
  if (microphoneDeviceId !== undefined && microphoneDeviceId !== null) {
    settings.microphoneDeviceId = microphoneDeviceId;
  }

  const debugLoggingEnabled = await s.get<boolean>("debugLoggingEnabled");
  if (debugLoggingEnabled !== undefined && debugLoggingEnabled !== null) {
    settings.debugLoggingEnabled = debugLoggingEnabled;
  }

  const waveformStyle = await s.get<string>("waveformStyle");
  if (isWaveformStyle(waveformStyle)) {
    settings.waveformStyle = waveformStyle;
  }

  const waveformColorScheme = await s.get<string>("waveformColorScheme");
  if (isWaveformColorScheme(waveformColorScheme)) {
    settings.waveformColorScheme = waveformColorScheme;
  }

  const waveformEasterEggUnlocked = await s.get<boolean>("waveformEasterEggUnlocked");
  if (
    waveformEasterEggUnlocked !== undefined &&
    waveformEasterEggUnlocked !== null
  ) {
    settings.waveformEasterEggUnlocked = waveformEasterEggUnlocked;
  }

  const recordingLoudness = await s.get<number>("recordingLoudness");
  if (
    recordingLoudness !== undefined &&
    recordingLoudness !== null &&
    Number.isFinite(recordingLoudness) &&
    recordingLoudness >= 25 &&
    recordingLoudness <= 300
  ) {
    settings.recordingLoudness = recordingLoudness;
  }

  const legacySelectedLiveModel = await s.get<string>("selectedLiveModel");
  if (
    legacySelectedLiveModel !== undefined &&
    legacySelectedLiveModel !== null &&
    !settings.providers.gemini.selectedModel
  ) {
    settings.providers.gemini.selectedModel = legacySelectedLiveModel;
  }

  const legacyLastKnownGoodLiveModel = await s.get<string>("lastKnownGoodLiveModel");
  if (
    legacyLastKnownGoodLiveModel !== undefined &&
    legacyLastKnownGoodLiveModel !== null &&
    !settings.providers.gemini.lastKnownGoodModel
  ) {
    settings.providers.gemini.lastKnownGoodModel = legacyLastKnownGoodLiveModel;
  }

  const legacyModelCache = await s.get<ProviderModelCache>("modelCache");
  if (!settings.providers.gemini.modelCache) {
    settings.providers.gemini.modelCache = toProviderModelCache(legacyModelCache);
  }

  hydrateSelectedModelFromCache(settings, "gemini");
  hydrateSelectedModelFromCache(settings, "openai");
  hydrateCorrectionSelectedModelFromCache(settings, "gemini");
  hydrateCorrectionSelectedModelFromCache(settings, "openai");

  if (settings.hotkey === LEGACY_DEFAULT_HOTKEY) {
    settings.hotkey = DEFAULTS.hotkey;
    await s.set("hotkey", settings.hotkey);
    await s.save();
  }

  const typingMode = await s.get<string>("typingMode");
  if (typingMode === "all_at_once" || typingMode === "incremental") {
    settings.typingMode = typingMode;
  }

  const autoStop = await s.get<boolean>("autoStopOnSilence");
  if (autoStop !== undefined && autoStop !== null)
    settings.autoStopOnSilence = autoStop;

  const silenceMs = await s.get<number>("autoStopSilenceMs");
  if (silenceMs !== undefined && silenceMs !== null)
    settings.autoStopSilenceMs = silenceMs;

  const language = await s.get<string>("language");
  if (language !== undefined && language !== null) settings.language = language;

  const targetLanguage = await s.get<string>("targetLanguage");
  if (targetLanguage !== undefined && targetLanguage !== null) {
    settings.targetLanguage = targetLanguage;
  }

  const lineBreakMode = await s.get<string>("lineBreakMode");
  if (
    lineBreakMode === "enter" ||
    lineBreakMode === "shift_enter" ||
    lineBreakMode === "ctrl_enter"
  ) {
    settings.lineBreakMode = lineBreakMode;
  }

  const playListeningDing = await s.get<boolean>("playListeningDing");
  if (playListeningDing !== undefined && playListeningDing !== null) {
    settings.playListeningDing = playListeningDing;
  }

  const listeningDingSound = await s.get<string>("listeningDingSound");
  if (isListeningDingSound(listeningDingSound)) {
    settings.listeningDingSound = listeningDingSound;
  }

  const listeningDingVolume = await s.get<number>("listeningDingVolume");
  if (
    listeningDingVolume !== undefined &&
    listeningDingVolume !== null &&
    Number.isFinite(listeningDingVolume) &&
    listeningDingVolume >= 0 &&
    listeningDingVolume <= 100
  ) {
    settings.listeningDingVolume = listeningDingVolume;
  }

  const textCommandsEnabled = await s.get<boolean>("textCommandsEnabled");
  if (textCommandsEnabled !== undefined && textCommandsEnabled !== null) {
    settings.textCommandsEnabled = textCommandsEnabled;
  }

  const customTextCommands = await s.get<TextCommand[]>("customTextCommands");
  settings.customTextCommands = toTextCommands(customTextCommands);

  const legacyTextCommands = await s.get<TextCommand[]>("textCommands");
  if (settings.customTextCommands.length === 0) {
    settings.customTextCommands = toTextCommands(legacyTextCommands).filter((command) => {
      const normalizedPhrase = command.phrase.trim().toLowerCase();
      return !DEFAULT_TEXT_COMMANDS.some(
        (defaultCommand) => defaultCommand.phrase.toLowerCase() === normalizedPhrase
      );
    });
  }

  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const s = await getStore();
  await s.set("sttProvider", settings.sttProvider);
  await s.set("providers", settings.providers);
  await s.set("transcriptionCorrection", settings.transcriptionCorrection);

  // Backward-compatible writes for legacy keys
  await s.set("geminiApiKey", settings.providers.gemini.apiKey);
  await s.set("hotkey", settings.hotkey);
  await s.set("microphoneDeviceId", settings.microphoneDeviceId);
  await s.set("recordingLoudness", settings.recordingLoudness);
  await s.set("waveformStyle", settings.waveformStyle);
  await s.set("waveformColorScheme", settings.waveformColorScheme);
  await s.set("waveformEasterEggUnlocked", settings.waveformEasterEggUnlocked);
  await s.set("selectedLiveModel", settings.providers.gemini.selectedModel);
  await s.set("lastKnownGoodLiveModel", settings.providers.gemini.lastKnownGoodModel);
  await s.set("modelCache", settings.providers.gemini.modelCache);
  await s.set("debugLoggingEnabled", settings.debugLoggingEnabled);
  await s.set("typingMode", settings.typingMode);
  await s.set("recordingMode", settings.recordingMode);
  await s.set("clipboardMode", settings.clipboardMode);
  await s.set("autoStopOnSilence", settings.autoStopOnSilence);
  await s.set("autoStopSilenceMs", settings.autoStopSilenceMs);
  await s.set("language", settings.language);
  await s.set("targetLanguage", settings.targetLanguage);
  await s.set("lineBreakMode", settings.lineBreakMode);
  await s.set("playListeningDing", settings.playListeningDing);
  await s.set("listeningDingSound", settings.listeningDingSound);
  await s.set("listeningDingVolume", settings.listeningDingVolume);
  await s.set("textCommandsEnabled", settings.textCommandsEnabled);
  await s.set("customTextCommands", settings.customTextCommands);
  await s.set("textCommands", [...DEFAULT_TEXT_COMMANDS, ...settings.customTextCommands]);
  await s.save();
}

export async function saveProviderModelCache(
  provider: SttProvider,
  cache: ProviderModelCache | null
): Promise<void> {
  const s = await getStore();
  const providers = (await s.get<Settings["providers"]>("providers")) ?? getDefaultSettings().providers;
  if (provider === "openai") {
    providers.openai = {
      ...providers.openai,
      modelCache: cache,
    };
  } else {
    providers.gemini = {
      ...providers.gemini,
      modelCache: cache,
    };
  }
  await s.set("providers", providers);
  if (provider === "gemini") {
    await s.set("modelCache", cache);
  }
  await s.save();
}

export async function saveProviderLastKnownGoodModel(
  provider: SttProvider,
  model: string
): Promise<void> {
  const s = await getStore();
  const providers = (await s.get<Settings["providers"]>("providers")) ?? getDefaultSettings().providers;
  if (provider === "openai") {
    providers.openai = {
      ...providers.openai,
      lastKnownGoodModel: model,
    };
  } else {
    providers.gemini = {
      ...providers.gemini,
      lastKnownGoodModel: model,
    };
  }
  await s.set("providers", providers);
  if (provider === "gemini") {
    await s.set("lastKnownGoodLiveModel", model);
  }
  await s.save();
}

export async function saveCorrectionProviderModelCache(
  provider: SttProvider,
  cache: ProviderModelCache | null
): Promise<void> {
  const s = await getStore();
  const transcriptionCorrection =
    (await s.get<Settings["transcriptionCorrection"]>("transcriptionCorrection")) ??
    getDefaultSettings().transcriptionCorrection;
  transcriptionCorrection.providers[provider] = {
    ...transcriptionCorrection.providers[provider],
    modelCache: cache,
  };
  await s.set("transcriptionCorrection", transcriptionCorrection);
  await s.save();
}

export async function saveCorrectionProviderLastKnownGoodModel(
  provider: SttProvider,
  model: string
): Promise<void> {
  const s = await getStore();
  const transcriptionCorrection =
    (await s.get<Settings["transcriptionCorrection"]>("transcriptionCorrection")) ??
    getDefaultSettings().transcriptionCorrection;
  transcriptionCorrection.providers[provider] = {
    ...transcriptionCorrection.providers[provider],
    lastKnownGoodModel: model,
  };
  await s.set("transcriptionCorrection", transcriptionCorrection);
  await s.save();
}

export function getProviderAuth(settings: Settings, provider = settings.sttProvider): ProviderAuth | null {
  if (provider === "openai") {
    const openai = settings.providers.openai;
    if (openai.authMode === "oauth_experimental" && openai.oauthSession) {
      return {
        type: "oauth",
        accessToken: openai.oauthSession.accessToken,
        refreshToken: openai.oauthSession.refreshToken,
        expiresAt: openai.oauthSession.expiresAt,
        accountId: openai.oauthSession.accountId,
        planType: openai.oauthSession.planType,
      };
    }
  }

  const token = settings.providers[provider].apiKey.trim();
  if (!token) {
    return null;
  }

  return {
    type: "api_key",
    token,
  };
}

export function getProviderAuthIdentity(settings: Settings, provider = settings.sttProvider): string {
  const auth = getProviderAuth(settings, provider);
  if (!auth) {
    return "";
  }

  if (auth.type === "oauth") {
    return `oauth:${auth.accountId}:${auth.refreshToken}`;
  }

  return auth.token;
}

export function getProviderApiKey(settings: Settings, provider = settings.sttProvider): string {
  const auth = getProviderAuth(settings, provider);
  if (!auth) {
    return "";
  }
  return auth.type === "oauth" ? auth.accessToken : auth.token;
}

export function getProviderSelectedModel(
  settings: Settings,
  provider = settings.sttProvider
): string {
  return settings.providers[provider].selectedModel;
}

export function getProviderLastKnownGoodModel(
  settings: Settings,
  provider = settings.sttProvider
): string {
  return settings.providers[provider].lastKnownGoodModel;
}

export function getProviderModelCache(
  settings: Settings,
  provider = settings.sttProvider
): ProviderModelCache | null {
  return settings.providers[provider].modelCache;
}
