import { describe, expect, test } from "bun:test";
import { getProviderRuntime, selectPreferredModel } from "../src/stt/service";

describe("STT service provider registry", () => {
  test("exposes gemini and openai providers", () => {
    expect(getProviderRuntime("gemini").label).toBe("Gemini");
    expect(getProviderRuntime("openai").label).toBe("OpenAI");
  });

  test("selectPreferredModel falls back to provider default", () => {
    const selected = selectPreferredModel("openai", ["x", "y"], "", "");
    expect(selected).toBe("x");
  });
});
