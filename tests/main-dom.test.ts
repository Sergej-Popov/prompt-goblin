import { describe, expect, test } from "bun:test";
import {
  getMainDom,
  populateLiveModelOptions,
  updateConnectionStatus,
  updateTranscriptCorrectionUI,
} from "../src/main/dom";

function createClassList() {
  const values = new Set<string>();
  return {
    add: (...tokens: string[]) => tokens.forEach((token) => values.add(token)),
    remove: (...tokens: string[]) => tokens.forEach((token) => values.delete(token)),
    toggle: (token: string, force?: boolean) => {
      if (force === undefined) {
        if (values.has(token)) {
          values.delete(token);
          return false;
        }
        values.add(token);
        return true;
      }
      if (force) {
        values.add(token);
      } else {
        values.delete(token);
      }
      return force;
    },
    contains: (token: string) => values.has(token),
    toString: () => Array.from(values).join(" "),
  };
}

function createSelectElement() {
  return {
    innerHTML: "",
    value: "",
    disabled: false,
    options: [] as Array<{ value: string; textContent: string }>,
    appendChild(option: { value: string; textContent: string }) {
      this.options.push(option);
    },
  };
}

function createElement() {
  const classList = createClassList();
  const attributes = new Map<string, string>();
  return {
    textContent: "",
    hidden: false,
    checked: false,
    disabled: false,
    value: "",
    innerHTML: "",
    style: { display: "" },
    classList,
    className: "",
    appendChild() {},
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    querySelector() {
      return null;
    },
  };
}

function createDocumentStub() {
  const elements = new Map<string, any>();
  const ids = [
    "api-key-input",
    "stt-provider-select",
    "hotkey-input",
    "live-model-select",
    "refresh-models-btn",
    "live-model-hint",
    "microphone-select",
    "recording-loudness",
    "recording-loudness-value",
    "refresh-microphones-btn",
    "mic-test-btn",
    "continuous-mic-test-btn",
    "wave-style-btn",
    "wave-color-btn",
    "mic-test-status",
    "mic-test-transcript",
    "mic-signal-indicator",
    "mic-wave-canvas",
    "debug-logging-checkbox",
    "open-debug-folder-btn",
    "debug-log-path",
    "toggle-key-visibility",
    "api-key-help-btn",
    "api-key-help-modal",
    "close-api-key-help-btn",
    "connection-status",
    "test-api-key-btn",
    "typing-mode-hint",
    "transcript-correction-checkbox",
    "transcript-correction-hint",
    "transcript-correction-controls",
    "correction-model-select",
    "refresh-correction-models-btn",
    "correction-model-hint",
    "auto-stop-checkbox",
    "silence-timeout-field",
    "silence-timeout",
    "language-select",
    "target-language-select",
    "line-break-mode-select",
    "clipboard-mode-select",
    "listening-ding-checkbox",
    "listening-ding-sound-select",
    "listening-ding-volume",
    "listening-ding-volume-value",
    "hold-before-type-checkbox",
    "hold-before-type-timeout",
    "hold-before-type-timeout-field",
    "reset-defaults-btn",
    "app-toast",
    "window-minimize-btn",
    "window-close-btn",
    "recording-mode-hint",
  ];

  for (const id of ids) {
    elements.set(
      id,
      id.includes("select") ? createSelectElement() : createElement()
    );
  }

  const connectionStatus = createElement();
  const statusText = createElement();
  connectionStatus.querySelector = () => statusText;
  elements.set("connection-status", connectionStatus);

  const typingModeRadios = [{ checked: false, value: "incremental" }, { checked: false, value: "all_at_once" }];
  const recordingModeRadios = [{ checked: false, value: "toggle" }, { checked: false, value: "push_to_talk" }];

  return {
    doc: {
      getElementById(id: string) {
        return elements.get(id) ?? null;
      },
      querySelectorAll(selector: string) {
        if (selector === 'input[name="typing-mode"]') {
          return typingModeRadios;
        }
        if (selector === 'input[name="recording-mode"]') {
          return recordingModeRadios;
        }
        return [];
      },
    } as unknown as Document,
    elements,
    typingModeRadios,
    recordingModeRadios,
    statusText,
  };
}

describe("main dom", () => {
  test("populateLiveModelOptions selects preferred model and enables select", () => {
    const { doc } = createDocumentStub();
    const originalDocument = globalThis.document;
    (globalThis as any).document = {
      createElement: () => ({ value: "", textContent: "" }),
    };

    try {
      const dom = getMainDom(doc);
      populateLiveModelOptions(dom, ["model-a", "model-b"], "model-b");

      expect(dom.liveModelSelect.disabled).toBe(false);
      expect(dom.liveModelSelect.value).toBe("model-b");
      expect(dom.liveModelSelect.options.length).toBe(2);
    } finally {
      (globalThis as any).document = originalDocument;
    }
  });

  test("updateTranscriptCorrectionUI reflects availability and enabled state", () => {
    const { doc } = createDocumentStub();
    const dom = getMainDom(doc);
    dom.correctionModelSelect.options = [{ value: "c1", textContent: "c1" }] as any;

    updateTranscriptCorrectionUI(dom, "incremental", true);
    expect(dom.transcriptCorrectionCheckbox.disabled).toBe(true);
    expect(dom.refreshCorrectionModelsBtn.disabled).toBe(true);
    expect(dom.transcriptCorrectionHint.textContent).toContain("only in Type all at once mode");

    updateTranscriptCorrectionUI(dom, "all_at_once", false);
    expect(dom.transcriptCorrectionCheckbox.disabled).toBe(false);
    expect(dom.refreshCorrectionModelsBtn.disabled).toBe(true);
    expect(dom.transcriptCorrectionHint.textContent).toContain("Beta feature");

    updateTranscriptCorrectionUI(dom, "all_at_once", true);
    expect(dom.correctionModelSelect.disabled).toBe(false);
    expect(dom.refreshCorrectionModelsBtn.disabled).toBe(false);
    expect(dom.transcriptCorrectionHint.textContent).toContain("Cleans up the final transcript");
  });

  test("updateConnectionStatus maps status to text and class names", () => {
    const { doc, statusText } = createDocumentStub();
    const dom = getMainDom(doc);

    updateConnectionStatus(dom, "connecting");
    expect(dom.connectionStatus.className).toBe("status-indicator");
    expect(dom.connectionStatus.classList.contains("disconnected")).toBe(true);
    expect(statusText.textContent).toBe("Testing...");

    updateConnectionStatus(dom, "connected");
    expect(dom.connectionStatus.classList.contains("connected")).toBe(true);
    expect(statusText.textContent).toBe("Ready");

    updateConnectionStatus(dom, "error", "Bad key");
    expect(dom.connectionStatus.classList.contains("error")).toBe(true);
    expect(statusText.textContent).toBe("Bad key");
  });
});
