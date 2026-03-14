import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openaiProvider } from "../src/stt/providers/openai";

const originalFetch = globalThis.fetch;

describe("openai provider", () => {
  beforeEach(() => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "gpt-4o-mini-transcribe" },
              { id: "gpt-4o-transcribe" },
              { id: "gpt-4o-mini" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.endsWith("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "hello goblin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: { message: "not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetchModels filters to transcription-capable models", async () => {
    const models = await openaiProvider.fetchModels("test-key");
    expect(models).toEqual(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);
  });

  test("transcribeWavBase64 returns transcript text", async () => {
    const transcript = await openaiProvider.transcribeWavBase64(
      "test-key",
      "AAAA",
      "en",
      "gpt-4o-mini-transcribe"
    );
    expect(transcript).toBe("hello goblin");
  });

  test("live pipeline returns text", async () => {
    const transcript = await openaiProvider.transcribeWithLivePipeline({
      apiKey: "test-key",
      preferredModel: "gpt-4o-mini-transcribe",
      pcmChunksBase64: ["AAAA"],
      settleDelayMs: 0,
      chunkIntervalMs: 0,
    });

    expect(transcript).toBe("hello goblin");
  });
});
