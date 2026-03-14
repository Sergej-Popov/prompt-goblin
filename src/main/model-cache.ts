import type { ProviderModelCache } from "../settings";

export const MODEL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export function isModelCacheFresh(
  cache: ProviderModelCache | null,
  apiKeyFingerprint: string,
  now = Date.now(),
  ttlMs = MODEL_CACHE_TTL_MS
): boolean {
  return !!(
    cache &&
    cache.apiKeyFingerprint === apiKeyFingerprint &&
    now - cache.fetchedAt < ttlMs &&
    cache.models.length > 0
  );
}

export function selectPreferredModel(
  models: string[],
  selectedLiveModel: string,
  lastKnownGoodLiveModel: string
): string {
  const preferred = selectedLiveModel || lastKnownGoodLiveModel;
  return models.includes(preferred) ? preferred : models[0] || "";
}
