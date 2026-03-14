import { describe, expect, test } from "bun:test";
import { isModelCacheFresh, selectPreferredModel } from "../src/main/model-cache";

describe("model cache helpers", () => {
  test("isModelCacheFresh returns false when cache is missing", () => {
    expect(isModelCacheFresh(null, "abc", 1_000_000)).toBe(false);
  });

  test("isModelCacheFresh checks fingerprint and ttl", () => {
    const cache = {
      apiKeyFingerprint: "fp-1",
      fetchedAt: 1_000,
      models: ["gemini-live-1"],
    };

    expect(isModelCacheFresh(cache, "fp-1", 2_000, 10_000)).toBe(true);
    expect(isModelCacheFresh(cache, "fp-2", 2_000, 10_000)).toBe(false);
    expect(isModelCacheFresh(cache, "fp-1", 20_000, 10_000)).toBe(false);
  });

  test("selectPreferredModel prefers selected model first", () => {
    const models = ["a", "b", "c"];
    expect(selectPreferredModel(models, "b", "c")).toBe("b");
  });

  test("selectPreferredModel falls back to last known good model", () => {
    const models = ["a", "b", "c"];
    expect(selectPreferredModel(models, "", "c")).toBe("c");
  });

  test("selectPreferredModel falls back to first model", () => {
    const models = ["a", "b", "c"];
    expect(selectPreferredModel(models, "x", "y")).toBe("a");
  });
});
