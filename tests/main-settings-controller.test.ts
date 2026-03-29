import { describe, expect, test } from "bun:test";
import { getDefaultSettings } from "../src/settings";
import {
  buildSettingsFromForm,
  formatRecordingLoudnessValue,
  getRecordingInputGain,
  type SettingsFormSnapshot,
} from "../src/main/settings-controller";

function createForm(overrides: Partial<SettingsFormSnapshot> = {}): SettingsFormSnapshot {
  return {
    apiKey: "  new-key  ",
    providerOption: "gemini",
    hotkey: " Ctrl + Shift + K ",
    liveModel: "live-next",
    correctionModel: "correct-next",
    microphoneDeviceId: "mic-2",
    recordingLoudnessPercent: "175",
    debugLoggingEnabled: true,
    typingMode: "all_at_once",
    recordingMode: "toggle",
    clipboardMode: "typing_only",
    transcriptCorrectionEnabled: true,
    autoStopOnSilence: false,
    silenceTimeoutSeconds: "5.5",
    language: "en",
    targetLanguage: "de",
    lineBreakMode: "ctrl_enter",
    playListeningDing: false,
    listeningDingSound: "digital",
    listeningDingVolumePercent: "35",
    holdBeforeType: false,
    holdBeforeTypeTimeoutSeconds: "0",
    privacyMode: false,
    ...overrides,
  };
}

describe("settings controller helpers", () => {
  test("buildSettingsFromForm updates active provider settings and preserves others", () => {
    const currentSettings = getDefaultSettings();
    currentSettings.sttProvider = "gemini";
    currentSettings.providers.openai.apiKey = "keep-openai";
    currentSettings.providers.gemini.selectedModel = "live-old";
    currentSettings.transcriptionCorrection.providers.gemini.selectedModel = "correct-old";

    const nextSettings = buildSettingsFromForm(currentSettings, "gemini", createForm());

    expect(nextSettings.hotkey).toBe("Ctrl+Shift+K");
    expect(nextSettings.providers.gemini.apiKey).toBe("new-key");
    expect(nextSettings.providers.gemini.selectedModel).toBe("live-next");
    expect(nextSettings.transcriptionCorrection.providers.gemini.selectedModel).toBe(
      "correct-next"
    );
    expect(nextSettings.providers.openai.apiKey).toBe("keep-openai");
    expect(nextSettings.recordingLoudness).toBe(175);
    expect(nextSettings.autoStopSilenceMs).toBe(5500);
    expect(nextSettings.lineBreakMode).toBe("ctrl_enter");
    expect(nextSettings.playListeningDing).toBe(false);
    expect(nextSettings.listeningDingSound).toBe("digital");
    expect(nextSettings.listeningDingVolume).toBe(35);
  });

  test("buildSettingsFromForm falls back to current values for invalid numeric input", () => {
    const currentSettings = getDefaultSettings();
    currentSettings.recordingLoudness = 140;
    currentSettings.autoStopSilenceMs = 3200;
    currentSettings.listeningDingVolume = 72;

    const nextSettings = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({
        recordingLoudnessPercent: "999",
        silenceTimeoutSeconds: "0",
        listeningDingVolumePercent: "200",
      })
    );

    expect(nextSettings.recordingLoudness).toBe(140);
    expect(nextSettings.autoStopSilenceMs).toBe(3200);
    expect(nextSettings.listeningDingVolume).toBe(72);
  });

  test("formatRecordingLoudnessValue and getRecordingInputGain normalize display and gain", () => {
    expect(formatRecordingLoudnessValue("149.6")).toBe("150%");
    expect(formatRecordingLoudnessValue("not-a-number")).toBe("100%");
    expect(getRecordingInputGain("250")).toBe(2.5);
    expect(getRecordingInputGain("999")).toBe(3);
    expect(getRecordingInputGain("1")).toBe(0.25);
    expect(getRecordingInputGain("bad")).toBe(1);
  });

  test("buildSettingsFromForm propagates clipboardMode from form", () => {
    const currentSettings = getDefaultSettings();
    currentSettings.clipboardMode = "typing_only";

    const nextTypingAndClipboard = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ clipboardMode: "typing_and_clipboard" })
    );
    expect(nextTypingAndClipboard.clipboardMode).toBe("typing_and_clipboard");

    const nextClipboardOnly = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ clipboardMode: "clipboard_only" })
    );
    expect(nextClipboardOnly.clipboardMode).toBe("clipboard_only");

    const nextFallback = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ clipboardMode: "typing_with_fallback" })
    );
    expect(nextFallback.clipboardMode).toBe("typing_with_fallback");

    const nextTypingOnly = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ clipboardMode: "typing_only" })
    );
    expect(nextTypingOnly.clipboardMode).toBe("typing_only");
  });

  test("getDefaultSettings includes clipboardMode defaulting to typing_only", () => {
    const defaults = getDefaultSettings();
    expect(defaults.clipboardMode).toBe("typing_only");
  });

  test("getDefaultSettings includes holdBeforeType defaulting to false and holdBeforeTypeTimeoutMs to 0", () => {
    const defaults = getDefaultSettings();
    expect(defaults.holdBeforeType).toBe(false);
    expect(defaults.holdBeforeTypeTimeoutMs).toBe(0);
  });

  test("buildSettingsFromForm handles holdBeforeType true/false", () => {
    const currentSettings = getDefaultSettings();

    const withReview = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ holdBeforeType: true, holdBeforeTypeTimeoutSeconds: "0" })
    );
    expect(withReview.holdBeforeType).toBe(true);

    const withoutReview = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ holdBeforeType: false, holdBeforeTypeTimeoutSeconds: "0" })
    );
    expect(withoutReview.holdBeforeType).toBe(false);
  });

  test("buildSettingsFromForm converts holdBeforeTypeTimeoutSeconds from seconds to ms", () => {
    const currentSettings = getDefaultSettings();

    const result = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ holdBeforeType: true, holdBeforeTypeTimeoutSeconds: "5" })
    );
    expect(result.holdBeforeTypeTimeoutMs).toBe(5000);
  });

  test("buildSettingsFromForm clamps holdBeforeTypeTimeoutMs to [0, 30000]", () => {
    const currentSettings = getDefaultSettings();

    const zeroResult = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ holdBeforeTypeTimeoutSeconds: "0" })
    );
    expect(zeroResult.holdBeforeTypeTimeoutMs).toBe(0);

    const maxResult = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ holdBeforeTypeTimeoutSeconds: "30" })
    );
    expect(maxResult.holdBeforeTypeTimeoutMs).toBe(30000);

    const overMaxResult = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ holdBeforeTypeTimeoutSeconds: "999" })
    );
    expect(overMaxResult.holdBeforeTypeTimeoutMs).toBe(30000);

    const negativeResult = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ holdBeforeTypeTimeoutSeconds: "-5" })
    );
    expect(negativeResult.holdBeforeTypeTimeoutMs).toBe(0);
  });

  test("getDefaultSettings includes privacyMode defaulting to false", () => {
    const defaults = getDefaultSettings();
    expect(defaults.privacyMode).toBe(false);
  });

  test("buildSettingsFromForm propagates privacyMode from form", () => {
    const currentSettings = getDefaultSettings();

    const withPrivacy = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ privacyMode: true })
    );
    expect(withPrivacy.privacyMode).toBe(true);

    const withoutPrivacy = buildSettingsFromForm(
      currentSettings,
      "gemini",
      createForm({ privacyMode: false })
    );
    expect(withoutPrivacy.privacyMode).toBe(false);
  });
});
