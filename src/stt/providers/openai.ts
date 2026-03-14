import { debugLog, isDebugLoggingEnabled } from "../../logger";
import type {
  LivePipelineOptions,
  LiveTranscriber,
  LiveTranscriberConfig,
  StatusCallback,
  SttProviderRuntime,
  TranscriptCallback,
} from "../types";
import { base64ToBytes, bytesToBase64, concatBytes, pcm16ToWavBytes } from "../utils";

const OPENAI_API_BASE = "https://api.openai.com/v1";

function normalizeModelName(model: string): string {
  return model.trim();
}

function toAuthHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

function extractApiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "Unknown API error";
  }

  const maybeError = (payload as { error?: { message?: string } }).error;
  if (maybeError?.message) {
    return maybeError.message;
  }

  return "Unknown API error";
}

function getLanguageHint(language: string): string | undefined {
  if (!language || language === "auto") {
    return undefined;
  }
  return language;
}

async function postTranscription(apiKey: string, wavBytes: Uint8Array, model: string, language: string) {
  const normalizedModel = normalizeModelName(model);
  if (!normalizedModel) {
    throw new Error("No model selected");
  }

  const form = new FormData();
  form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "audio.wav");
  form.append("model", normalizedModel);

  const languageHint = getLanguageHint(language);
  if (languageHint) {
    form.append("language", languageHint);
  }

  const response = await fetch(`${OPENAI_API_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: toAuthHeaders(apiKey),
    body: form,
  });

  const payload = (await response.json().catch(() => null)) as
    | { text?: string; error?: { message?: string } }
    | null;

  if (!response.ok) {
    throw new Error(
      `OpenAI transcription failed: ${extractApiErrorMessage(payload)} (HTTP ${response.status})`
    );
  }

  return typeof payload?.text === "string" ? payload.text : "";
}

function createSilentWavBase64(durationMs = 180, sampleRate = 16000): string {
  const sampleCount = Math.max(1, Math.floor((durationMs / 1000) * sampleRate));
  const pcm = new Uint8Array(sampleCount * 2);
  const wav = pcm16ToWavBytes(pcm, sampleRate);
  return bytesToBase64(wav);
}

function mergeTranscriptSegment(current: string, segment: string): string {
  const left = current.trim();
  const right = segment.trim();

  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  if (left.endsWith(right)) {
    return left;
  }

  const maxOverlap = Math.min(left.length, right.length, 120);
  for (let overlap = maxOverlap; overlap >= 8; overlap -= 1) {
    const leftSuffix = left.slice(-overlap).toLowerCase();
    const rightPrefix = right.slice(0, overlap).toLowerCase();
    if (leftSuffix === rightPrefix) {
      const remainder = right.slice(overlap).trimStart();
      return remainder ? `${left} ${remainder}` : left;
    }
  }

  return `${left} ${right}`;
}

class OpenAILiveTranscriber implements LiveTranscriber {
  private apiKey = "";
  private language = "auto";
  private preferredModel = "";
  private activeModel = "";
  private onTranscript: TranscriptCallback | null = null;
  private onStatus: StatusCallback | null = null;
  private transcript = "";
  private connected = false;
  private pendingAudioChunks: string[] = [];
  private unflushedAudioChunks: Uint8Array[] = [];
  private overlapTailChunks: Uint8Array[] = [];
  private inFlight = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastTranscribeAt = 0;

  private static readonly FLUSH_INTERVAL_MS = 1500;
  private static readonly MAX_PENDING_AUDIO_CHUNKS = 1200;
  private static readonly OVERLAP_CHUNK_COUNT = 12;
  private static readonly MIN_CHUNKS_BEFORE_FLUSH = 8;

  configure(config: LiveTranscriberConfig): void {
    this.apiKey = config.apiKey;
    this.language = config.language ?? "auto";
    this.preferredModel = normalizeModelName(config.preferredModel ?? "");
    this.activeModel = this.preferredModel;
    debugLog(
      `OpenAI configured (language='${this.language}', preferredModel='${this.preferredModel}', apiKeyPresent=${Boolean(this.apiKey)})`,
      "INFO"
    );
  }

  setCallbacks(onTranscript: TranscriptCallback, onStatus: StatusCallback): void {
    this.onTranscript = onTranscript;
    this.onStatus = onStatus;
  }

  async connect(options: { preserveTranscript?: boolean } = {}): Promise<void> {
    if (!this.apiKey) {
      this.onStatus?.("error", "API key not configured");
      return;
    }

    if (!this.activeModel) {
      this.onStatus?.("error", "No model selected. Pick a model from the model dropdown first.");
      return;
    }

    this.onStatus?.("connecting");
    if (!options.preserveTranscript) {
      this.transcript = "";
      this.clearSessionBuffers();
    }

    this.connected = true;
    this.startFlushLoop();
    this.flushPendingAudioChunks();
    this.onStatus?.("connected");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.stopFlushLoop();
    await this.flushTranscription(true, true).catch((err) => {
      debugLog(`OpenAI final flush failed: ${String(err)}`, "ERROR");
    });
    this.clearSessionBuffers();
    this.onStatus?.("disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  sendAudio(base64PcmData: string): void {
    if (!this.connected) {
      this.queuePendingAudioChunk(base64PcmData);
      return;
    }

    this.appendAudioChunk(base64PcmData);
  }

  signalAudioStreamBoundary(reason = "periodic"): boolean {
    if (!this.connected) {
      return false;
    }

    void this.flushTranscription(false, true).catch((err) => {
      debugLog(`OpenAI boundary flush failed (${reason}): ${String(err)}`, "ERROR");
    });

    return true;
  }

  async reconnectForRecovery(): Promise<void> {
    await this.disconnect();
    await this.connect({ preserveTranscript: true });
  }

  getTranscript(): string {
    return this.transcript;
  }

  resetTranscript(): void {
    this.transcript = "";
  }

  getActiveModel(): string {
    return this.activeModel;
  }

  private startFlushLoop() {
    this.stopFlushLoop();
    this.lastTranscribeAt = Date.now();
    this.flushTimer = setInterval(() => {
      if (!this.connected) {
        return;
      }
      if (Date.now() - this.lastTranscribeAt < OpenAILiveTranscriber.FLUSH_INTERVAL_MS) {
        return;
      }
      void this.flushTranscription(false, false);
    }, OpenAILiveTranscriber.FLUSH_INTERVAL_MS);
  }

  private stopFlushLoop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private queuePendingAudioChunk(base64PcmData: string) {
    this.pendingAudioChunks.push(base64PcmData);
    if (this.pendingAudioChunks.length > OpenAILiveTranscriber.MAX_PENDING_AUDIO_CHUNKS) {
      this.pendingAudioChunks.shift();
    }
  }

  private flushPendingAudioChunks() {
    if (this.pendingAudioChunks.length === 0) {
      return;
    }

    const queued = this.pendingAudioChunks;
    this.pendingAudioChunks = [];
    for (const chunk of queued) {
      this.appendAudioChunk(chunk);
    }
  }

  private appendAudioChunk(base64PcmData: string) {
    this.unflushedAudioChunks.push(base64ToBytes(base64PcmData));
  }

  private clearSessionBuffers() {
    this.pendingAudioChunks = [];
    this.unflushedAudioChunks = [];
    this.overlapTailChunks = [];
  }

  private async flushTranscription(isFinal: boolean, force: boolean): Promise<void> {
    if (this.inFlight) {
      return;
    }

    if (this.unflushedAudioChunks.length === 0) {
      if (isFinal) {
        this.onTranscript?.(this.transcript, true);
      }
      return;
    }

    if (!force && this.unflushedAudioChunks.length < OpenAILiveTranscriber.MIN_CHUNKS_BEFORE_FLUSH) {
      return;
    }

    this.inFlight = true;
    try {
      const chunkBatch = [...this.overlapTailChunks, ...this.unflushedAudioChunks];
      const pcmBytes = concatBytes(chunkBatch);
      const wavBytes = pcm16ToWavBytes(pcmBytes, 16000);
      const segmentTranscript = (
        await postTranscription(this.apiKey, wavBytes, this.activeModel, this.language)
      ).trim();

      this.overlapTailChunks = chunkBatch.slice(
        Math.max(0, chunkBatch.length - OpenAILiveTranscriber.OVERLAP_CHUNK_COUNT)
      );
      this.unflushedAudioChunks = [];

      if (!segmentTranscript) {
        if (isFinal) {
          this.onTranscript?.(this.transcript, true);
        }
        return;
      }

      const merged = mergeTranscriptSegment(this.transcript, segmentTranscript);
      if (merged !== this.transcript) {
        this.transcript = merged;
        this.onTranscript?.(this.transcript, false);
        if (isDebugLoggingEnabled()) {
          debugLog(
            `OpenAI transcript updated (segment=${segmentTranscript.length}, total=${this.transcript.length})`,
            "INFO"
          );
        }
      }

      if (isFinal) {
        this.onTranscript?.(this.transcript, true);
      }
    } catch (err) {
      this.onStatus?.("error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      this.lastTranscribeAt = Date.now();
      this.inFlight = false;
    }
  }
}

async function fetchOpenAIModels(apiKey: string): Promise<string[]> {
  if (!apiKey) {
    throw new Error("API key not configured");
  }

  const response = await fetch(`${OPENAI_API_BASE}/models`, {
    method: "GET",
    headers: toAuthHeaders(apiKey),
  });

  const payload = (await response.json().catch(() => null)) as
    | { data?: Array<{ id?: string }>; error?: { message?: string } }
    | null;

  if (!response.ok) {
    throw new Error(`Failed to list OpenAI models: ${extractApiErrorMessage(payload)} (HTTP ${response.status})`);
  }

  const discovered = new Set<string>();
  for (const model of payload?.data ?? []) {
    const id = typeof model.id === "string" ? model.id : "";
    const lower = id.toLowerCase();
    if (lower.includes("transcribe") || lower.includes("whisper")) {
      discovered.add(id);
    }
  }

  if (discovered.size === 0) {
    return [];
  }

  return Array.from(discovered).sort((a, b) => a.localeCompare(b));
}

async function validateOpenAIModel(apiKey: string, model: string): Promise<void> {
  const models = await fetchOpenAIModels(apiKey);
  const normalized = normalizeModelName(model);
  if (!normalized) {
    throw new Error("No transcription model selected");
  }

  if (!models.includes(normalized)) {
    throw new Error(`Model '${normalized}' is not available for this API key`);
  }
}

async function probeOpenAIModel(apiKey: string, model: string): Promise<void> {
  const silenceWav = createSilentWavBase64();
  await postTranscription(apiKey, base64ToBytes(silenceWav), model, "auto");
}

async function transcribeOpenAIWavBase64(
  apiKey: string,
  wavBase64: string,
  language = "auto",
  model = ""
): Promise<string> {
  if (!apiKey) {
    throw new Error("API key not configured");
  }

  if (!wavBase64.trim()) {
    return "";
  }

  const wavBytes = base64ToBytes(wavBase64);
  const text = await postTranscription(apiKey, wavBytes, model, language);
  return text.trim();
}

async function transcribeOpenAIWithLivePipeline(options: LivePipelineOptions): Promise<string> {
  const transcriber = new OpenAILiveTranscriber();
  let latest = "";
  let statusMessage = "";
  let connected = false;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  transcriber.configure({
    apiKey: options.apiKey,
    language: options.language,
    preferredModel: options.preferredModel,
    fallbackModels: options.fallbackModels,
  });

  transcriber.setCallbacks(
    (text) => {
      latest = text;
    },
    (status, message) => {
      if (status === "connected") {
        connected = true;
      }
      if (status === "error") {
        statusMessage = message ?? "Live transcription failed";
      }
    }
  );

  try {
    await transcriber.connect();
    if (!connected) {
      await sleep(120);
    }

    for (const chunk of options.pcmChunksBase64) {
      transcriber.sendAudio(chunk);
      await sleep(options.chunkIntervalMs ?? 20);
    }

    await sleep(options.settleDelayMs ?? 1800);
    transcriber.signalAudioStreamBoundary("pipeline-settle");
    await sleep(250);

    if (statusMessage) {
      throw new Error(statusMessage);
    }

    return (latest || transcriber.getTranscript()).trim();
  } finally {
    await transcriber.disconnect();
  }
}

export const openaiProvider: SttProviderRuntime = {
  id: "openai",
  label: "OpenAI",
  createLiveTranscriber() {
    return new OpenAILiveTranscriber();
  },
  fetchModels(apiKey: string) {
    return fetchOpenAIModels(apiKey);
  },
  validateApiKey(apiKey: string) {
    return fetchOpenAIModels(apiKey).then(() => undefined);
  },
  validateModel(apiKey: string, model: string) {
    return validateOpenAIModel(apiKey, model);
  },
  probeModelForTranscription(apiKey: string, model: string) {
    return probeOpenAIModel(apiKey, model);
  },
  transcribeWavBase64(apiKey: string, wavBase64: string, language?: string, model?: string) {
    return transcribeOpenAIWavBase64(apiKey, wavBase64, language ?? "auto", model ?? "");
  },
  transcribeWithLivePipeline(options: LivePipelineOptions) {
    return transcribeOpenAIWithLivePipeline(options);
  },
};
