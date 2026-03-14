import {
  fetchLiveModels,
  GeminiTranscriber,
  probeLiveModelForTranscription,
  transcribeWavBase64,
  transcribeWithLivePipeline,
  validateApiKey,
  validateLiveModel,
} from "../../gemini";
import type {
  LivePipelineOptions,
  LiveTranscriber,
  LiveTranscriberConfig,
  StatusCallback,
  SttProviderRuntime,
  TranscriptCallback,
} from "../types";

class GeminiProviderTranscriber implements LiveTranscriber {
  private readonly inner = new GeminiTranscriber();

  configure(config: LiveTranscriberConfig): void {
    this.inner.configure(
      config.apiKey,
      config.language ?? "auto",
      config.preferredModel,
      config.fallbackModels ?? []
    );
  }

  setCallbacks(onTranscript: TranscriptCallback, onStatus: StatusCallback): void {
    this.inner.setCallbacks(onTranscript, onStatus);
  }

  connect(options?: { preserveTranscript?: boolean }): Promise<void> {
    return this.inner.connect(options);
  }

  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  isConnected(): boolean {
    return this.inner.isConnected();
  }

  sendAudio(base64PcmData: string): void {
    this.inner.sendAudio(base64PcmData);
  }

  signalAudioStreamBoundary(reason?: string): boolean {
    return this.inner.signalAudioStreamBoundary(reason);
  }

  reconnectForRecovery(): Promise<void> {
    return this.inner.reconnectForRecovery();
  }

  getTranscript(): string {
    return this.inner.getTranscript();
  }

  resetTranscript(): void {
    this.inner.resetTranscript();
  }

  getActiveModel(): string {
    return this.inner.getActiveLiveModel();
  }
}

export const geminiProvider: SttProviderRuntime = {
  id: "gemini",
  label: "Gemini",
  createLiveTranscriber() {
    return new GeminiProviderTranscriber();
  },
  fetchModels(apiKey: string) {
    return fetchLiveModels(apiKey);
  },
  validateApiKey(apiKey: string) {
    return validateApiKey(apiKey);
  },
  validateModel(apiKey: string, model: string) {
    return validateLiveModel(apiKey, model);
  },
  probeModelForTranscription(apiKey: string, model: string, timeoutMs?: number) {
    return probeLiveModelForTranscription(apiKey, model, timeoutMs);
  },
  transcribeWavBase64(apiKey: string, wavBase64: string, language?: string, model?: string) {
    return transcribeWavBase64(apiKey, wavBase64, language, model);
  },
  transcribeWithLivePipeline(options: LivePipelineOptions) {
    return transcribeWithLivePipeline({
      apiKey: options.apiKey,
      language: options.language,
      preferredLiveModel: options.preferredModel,
      fallbackLiveModels: options.fallbackModels,
      pcmChunksBase64: options.pcmChunksBase64,
      settleDelayMs: options.settleDelayMs,
      chunkIntervalMs: options.chunkIntervalMs,
    });
  },
};
