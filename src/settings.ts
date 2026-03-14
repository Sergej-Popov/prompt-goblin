import { load, Store } from "@tauri-apps/plugin-store";

export type SttProvider = "gemini" | "openai";

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
  apiKey: string;
  selectedModel: string;
  lastKnownGoodModel: string;
  modelCache: ProviderModelCache | null;
}

export interface Settings {
  sttProvider: SttProvider;
  providers: {
    gemini: GeminiProviderSettings;
    openai: OpenAIProviderSettings;
  };
  hotkey: string;
  microphoneDeviceId: string;
  recordingLoudness: number;
  debugLoggingEnabled: boolean;
  typingMode: "all_at_once" | "incremental";
  autoStopOnSilence: boolean;
  autoStopSilenceMs: number;
  language: string;
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
      apiKey: "",
      selectedModel: "",
      lastKnownGoodModel: "",
      modelCache: null,
    },
  },
  hotkey: "Alt+G",
  microphoneDeviceId: "default",
  recordingLoudness: 100,
  debugLoggingEnabled: false,
  typingMode: "incremental",
  autoStopOnSilence: true,
  autoStopSilenceMs: 4000,
  language: "auto",
};

export function getDefaultSettings(): Settings {
  return {
    ...DEFAULTS,
    providers: {
      gemini: { ...DEFAULTS.providers.gemini },
      openai: { ...DEFAULTS.providers.openai },
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
      if (typeof openai.apiKey === "string") settings.providers.openai.apiKey = openai.apiKey;
      if (typeof openai.selectedModel === "string") {
        settings.providers.openai.selectedModel = openai.selectedModel;
      }
      if (typeof openai.lastKnownGoodModel === "string") {
        settings.providers.openai.lastKnownGoodModel = openai.lastKnownGoodModel;
      }
      settings.providers.openai.modelCache = toProviderModelCache(openai.modelCache);
    }
  }

  // Legacy migration for pre-provider settings
  const legacyApiKey = await s.get<string>("geminiApiKey");
  if (legacyApiKey !== undefined && legacyApiKey !== null && !settings.providers.gemini.apiKey) {
    settings.providers.gemini.apiKey = legacyApiKey;
  }

  const hotkey = await s.get<string>("hotkey");
  if (hotkey !== undefined && hotkey !== null) settings.hotkey = hotkey;

  const microphoneDeviceId = await s.get<string>("microphoneDeviceId");
  if (microphoneDeviceId !== undefined && microphoneDeviceId !== null) {
    settings.microphoneDeviceId = microphoneDeviceId;
  }

  const debugLoggingEnabled = await s.get<boolean>("debugLoggingEnabled");
  if (debugLoggingEnabled !== undefined && debugLoggingEnabled !== null) {
    settings.debugLoggingEnabled = debugLoggingEnabled;
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

  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const s = await getStore();
  await s.set("sttProvider", settings.sttProvider);
  await s.set("providers", settings.providers);

  // Backward-compatible writes for legacy keys
  await s.set("geminiApiKey", settings.providers.gemini.apiKey);
  await s.set("hotkey", settings.hotkey);
  await s.set("microphoneDeviceId", settings.microphoneDeviceId);
  await s.set("recordingLoudness", settings.recordingLoudness);
  await s.set("selectedLiveModel", settings.providers.gemini.selectedModel);
  await s.set("lastKnownGoodLiveModel", settings.providers.gemini.lastKnownGoodModel);
  await s.set("modelCache", settings.providers.gemini.modelCache);
  await s.set("debugLoggingEnabled", settings.debugLoggingEnabled);
  await s.set("typingMode", settings.typingMode);
  await s.set("autoStopOnSilence", settings.autoStopOnSilence);
  await s.set("autoStopSilenceMs", settings.autoStopSilenceMs);
  await s.set("language", settings.language);
  await s.save();
}

export async function saveProviderModelCache(
  provider: SttProvider,
  cache: ProviderModelCache | null
): Promise<void> {
  const s = await getStore();
  const providers = (await s.get<Settings["providers"]>("providers")) ?? getDefaultSettings().providers;
  providers[provider] = {
    ...providers[provider],
    modelCache: cache,
  };
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
  providers[provider] = {
    ...providers[provider],
    lastKnownGoodModel: model,
  };
  await s.set("providers", providers);
  if (provider === "gemini") {
    await s.set("lastKnownGoodLiveModel", model);
  }
  await s.save();
}

export function getProviderApiKey(settings: Settings, provider = settings.sttProvider): string {
  return settings.providers[provider].apiKey;
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
