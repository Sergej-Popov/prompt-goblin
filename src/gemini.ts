import { GoogleGenAI, Modality, Session, LiveServerMessage } from "@google/genai";

export type TranscriptCallback = (
  text: string,
  isFinal: boolean
) => void;

export type StatusCallback = (
  status: "connecting" | "connected" | "disconnected" | "error",
  message?: string
) => void;

export class GeminiTranscriber {
  private ai: GoogleGenAI | null = null;
  private session: Session | null = null;
  private apiKey: string = "";
  private language: string = "auto";
  private onTranscript: TranscriptCallback | null = null;
  private onStatus: StatusCallback | null = null;
  private currentTranscript: string = "";

  configure(apiKey: string, language: string = "auto") {
    this.apiKey = apiKey;
    this.language = language;
    this.ai = new GoogleGenAI({ apiKey });
  }

  setCallbacks(onTranscript: TranscriptCallback, onStatus: StatusCallback) {
    this.onTranscript = onTranscript;
    this.onStatus = onStatus;
  }

  async connect(): Promise<void> {
    if (!this.ai || !this.apiKey) {
      this.onStatus?.("error", "API key not configured");
      return;
    }

    this.onStatus?.("connecting");
    this.currentTranscript = "";

    try {
      const languageInstruction =
        this.language === "auto"
          ? "Detect the language automatically."
          : `The user is speaking in ${this.language}.`;

      this.session = await this.ai.live.connect({
        model: "gemini-live-2.5-flash-preview",
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {},
          systemInstruction: `You are a speech transcription assistant. Your ONLY job is to output the exact transcription of the user's speech. ${languageInstruction} Do not add any commentary, responses, greetings, or formatting. Output ONLY the transcribed words. If the user pauses, do not fill in words. If you cannot understand something, skip it. Never respond conversationally.`,
        },
        callbacks: {
          onopen: () => {
            this.onStatus?.("connected");
          },
          onmessage: (message: LiveServerMessage) => {
            this.handleMessage(message);
          },
          onerror: (event: Event) => {
            const errorEvent = event as ErrorEvent;
            console.error("Gemini Live error:", errorEvent);
            this.onStatus?.(
              "error",
              errorEvent.message || "Connection error"
            );
          },
          onclose: () => {
            this.onStatus?.("disconnected");
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Failed to connect to Gemini Live:", message);
      this.onStatus?.("error", message);
    }
  }

  private handleMessage(message: LiveServerMessage) {
    // Handle input audio transcription results
    if (message.serverContent?.inputTranscription?.text) {
      const text = message.serverContent.inputTranscription.text;
      this.currentTranscript += text;
      this.onTranscript?.(this.currentTranscript, false);
    }

    // Handle model text output (backup transcription path)
    if (message.text) {
      this.currentTranscript += message.text;
      this.onTranscript?.(this.currentTranscript, false);
    }

    // Handle turn complete
    if (message.serverContent?.turnComplete) {
      this.onTranscript?.(this.currentTranscript, true);
    }
  }

  sendAudio(base64PcmData: string) {
    if (!this.session) return;

    try {
      this.session.sendRealtimeInput({
        media: {
          data: base64PcmData,
          mimeType: "audio/pcm;rate=16000",
        },
      });
    } catch (err) {
      console.error("Failed to send audio:", err);
    }
  }

  getTranscript(): string {
    return this.currentTranscript;
  }

  resetTranscript() {
    this.currentTranscript = "";
  }

  async disconnect(): Promise<void> {
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // Ignore close errors
      }
      this.session = null;
    }
    this.onStatus?.("disconnected");
  }

  isConnected(): boolean {
    return this.session !== null;
  }
}

// Singleton instance
export const transcriber = new GeminiTranscriber();
