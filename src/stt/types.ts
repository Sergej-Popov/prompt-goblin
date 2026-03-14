import type { SttProvider } from "../settings";

export type TranscriptCallback = (text: string, isFinal: boolean) => void;

export type StatusCallback = (
  status: "connecting" | "connected" | "disconnected" | "error",
  message?: string
) => void;

export interface LiveTranscriberConfig {
  apiKey: string;
  language?: string;
  preferredModel?: string;
  fallbackModels?: string[];
}

export interface LivePipelineOptions {
  apiKey: string;
  language?: string;
  preferredModel?: string;
  fallbackModels?: string[];
  pcmChunksBase64: string[];
  settleDelayMs?: number;
  chunkIntervalMs?: number;
}

export interface LiveTranscriber {
  configure(config: LiveTranscriberConfig): void;
  setCallbacks(onTranscript: TranscriptCallback, onStatus: StatusCallback): void;
  connect(options?: { preserveTranscript?: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  sendAudio(base64PcmData: string): void;
  signalAudioStreamBoundary(reason?: string): boolean;
  reconnectForRecovery(): Promise<void>;
  getTranscript(): string;
  resetTranscript(): void;
  getActiveModel(): string;
}

export interface SttProviderRuntime {
  readonly id: SttProvider;
  readonly label: string;
  createLiveTranscriber(): LiveTranscriber;
  fetchModels(apiKey: string): Promise<string[]>;
  validateApiKey(apiKey: string): Promise<void>;
  validateModel(apiKey: string, model: string): Promise<void>;
  probeModelForTranscription(apiKey: string, model: string, timeoutMs?: number): Promise<void>;
  transcribeWavBase64(
    apiKey: string,
    wavBase64: string,
    language?: string,
    model?: string
  ): Promise<string>;
  transcribeWithLivePipeline(options: LivePipelineOptions): Promise<string>;
}
