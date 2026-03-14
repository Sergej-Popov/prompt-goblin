import type { Settings, SttProvider } from "../settings";
import type {
  LivePipelineOptions,
  LiveTranscriber,
  SttProviderRuntime,
} from "./types";
import { geminiProvider } from "./providers/gemini";
import { openaiProvider } from "./providers/openai";

const PROVIDERS: Record<SttProvider, SttProviderRuntime> = {
  gemini: geminiProvider,
  openai: openaiProvider,
};

export function getProviderRuntime(provider: SttProvider): SttProviderRuntime {
  return PROVIDERS[provider];
}

export function getProviderLabel(provider: SttProvider): string {
  return PROVIDERS[provider].label;
}

export function listProviderOptions(): Array<{ id: SttProvider; label: string }> {
  return (Object.keys(PROVIDERS) as SttProvider[]).map((id) => ({
    id,
    label: PROVIDERS[id].label,
  }));
}

export function createLiveTranscriber(provider: SttProvider): LiveTranscriber {
  return PROVIDERS[provider].createLiveTranscriber();
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

export function getProviderFallbackModels(
  settings: Settings,
  provider = settings.sttProvider
): string[] {
  return settings.providers[provider].modelCache?.models ?? [];
}

export function getProviderCache(
  settings: Settings,
  provider = settings.sttProvider
) {
  return settings.providers[provider].modelCache;
}

export function setProviderCache(
  settings: Settings,
  provider: SttProvider,
  cache: Settings["providers"][SttProvider]["modelCache"]
) {
  settings.providers[provider].modelCache = cache;
}

export function setProviderSelectedModel(
  settings: Settings,
  provider: SttProvider,
  model: string
) {
  settings.providers[provider].selectedModel = model;
}

export function setProviderLastKnownGoodModel(
  settings: Settings,
  provider: SttProvider,
  model: string
) {
  settings.providers[provider].lastKnownGoodModel = model;
}

export function selectPreferredModel(
  _provider: SttProvider,
  models: string[],
  selectedModel: string,
  lastKnownGoodModel: string
): string {
  const preferred = selectedModel || lastKnownGoodModel;
  return models.includes(preferred) ? preferred : models[0] || "";
}

export async function transcribeWithProviderLivePipeline(
  provider: SttProvider,
  options: LivePipelineOptions
): Promise<string> {
  return PROVIDERS[provider].transcribeWithLivePipeline(options);
}
