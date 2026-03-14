import { loadSettings, saveSettings, type Settings } from "./settings";
import { initApp, reloadSettings } from "./app";

// ── DOM Elements ────────────────────────────────────────────

let apiKeyInput: HTMLInputElement;
let toggleKeyBtn: HTMLButtonElement;
let connectionStatus: HTMLElement;
let typingModeRadios: NodeListOf<HTMLInputElement>;
let typingModeHint: HTMLElement;
let autoStopCheckbox: HTMLInputElement;
let silenceTimeoutField: HTMLElement;
let silenceTimeoutInput: HTMLInputElement;
let languageSelect: HTMLSelectElement;
let saveBtn: HTMLButtonElement;
let saveStatus: HTMLElement;

let currentSettings: Settings;

window.addEventListener("DOMContentLoaded", async () => {
  // Grab DOM references
  apiKeyInput = document.getElementById("api-key-input") as HTMLInputElement;
  toggleKeyBtn = document.getElementById(
    "toggle-key-visibility"
  ) as HTMLButtonElement;
  connectionStatus = document.getElementById(
    "connection-status"
  ) as HTMLElement;
  typingModeRadios = document.querySelectorAll(
    'input[name="typing-mode"]'
  ) as NodeListOf<HTMLInputElement>;
  typingModeHint = document.getElementById(
    "typing-mode-hint"
  ) as HTMLElement;
  autoStopCheckbox = document.getElementById(
    "auto-stop-checkbox"
  ) as HTMLInputElement;
  silenceTimeoutField = document.getElementById(
    "silence-timeout-field"
  ) as HTMLElement;
  silenceTimeoutInput = document.getElementById(
    "silence-timeout"
  ) as HTMLInputElement;
  languageSelect = document.getElementById(
    "language-select"
  ) as HTMLSelectElement;
  saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
  saveStatus = document.getElementById("save-status") as HTMLElement;

  // Load settings
  currentSettings = await loadSettings();
  populateUI(currentSettings);

  // Set up event listeners
  setupEventListeners();

  // Initialize the app (hotkey, audio listener, etc.)
  await initApp();

  // Update status based on API key
  updateConnectionStatus(currentSettings.geminiApiKey ? "connected" : "disconnected");

  // Listen for status updates from the app
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ status: string; message?: string }>(
    "gemini-status",
    (event) => {
      updateConnectionStatus(
        event.payload.status as "connected" | "disconnected" | "error",
        event.payload.message
      );
    }
  );
});

function populateUI(settings: Settings) {
  apiKeyInput.value = settings.geminiApiKey;

  // Typing mode
  typingModeRadios.forEach((radio) => {
    radio.checked = radio.value === settings.typingMode;
  });
  updateTypingModeHint(settings.typingMode);

  // Auto-stop
  autoStopCheckbox.checked = settings.autoStopOnSilence;
  silenceTimeoutField.style.display = settings.autoStopOnSilence
    ? "flex"
    : "none";
  silenceTimeoutInput.value = String(settings.autoStopSilenceMs / 1000);

  // Language
  languageSelect.value = settings.language;
}

function setupEventListeners() {
  // Toggle API key visibility
  toggleKeyBtn.addEventListener("click", () => {
    const isPassword = apiKeyInput.type === "password";
    apiKeyInput.type = isPassword ? "text" : "password";
  });

  // Typing mode change
  typingModeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      updateTypingModeHint(radio.value);
    });
  });

  // Auto-stop toggle
  autoStopCheckbox.addEventListener("change", () => {
    silenceTimeoutField.style.display = autoStopCheckbox.checked
      ? "flex"
      : "none";
  });

  // Save button
  saveBtn.addEventListener("click", async () => {
    await handleSave();
  });
}

function updateTypingModeHint(mode: string) {
  if (mode === "all_at_once") {
    typingModeHint.textContent = "Text is typed after you stop recording.";
  } else {
    typingModeHint.textContent =
      "Text appears as you speak. May cause issues in some apps.";
  }
}

function updateConnectionStatus(
  status: "connecting" | "connected" | "disconnected" | "error",
  message?: string
) {
  const statusText = connectionStatus.querySelector(
    ".status-text"
  ) as HTMLElement;

  connectionStatus.className = "status-indicator";

  switch (status) {
    case "connected":
      connectionStatus.classList.add("connected");
      statusText.textContent = "Ready";
      break;
    case "connecting":
      connectionStatus.classList.add("disconnected");
      statusText.textContent = "Connecting...";
      break;
    case "error":
      connectionStatus.classList.add("error");
      statusText.textContent = message || "Error";
      break;
    default:
      connectionStatus.classList.add("disconnected");
      statusText.textContent = currentSettings.geminiApiKey
        ? "Ready"
        : "Not configured";
  }
}

async function handleSave() {
  const selectedMode = Array.from(typingModeRadios).find(
    (r) => r.checked
  )?.value;

  const newSettings: Settings = {
    geminiApiKey: apiKeyInput.value.trim(),
    hotkey: currentSettings.hotkey, // Not editable in UI for now
    typingMode: (selectedMode as Settings["typingMode"]) || "all_at_once",
    autoStopOnSilence: autoStopCheckbox.checked,
    autoStopSilenceMs: parseFloat(silenceTimeoutInput.value) * 1000,
    language: languageSelect.value,
  };

  try {
    await saveSettings(newSettings);
    currentSettings = newSettings;
    reloadSettings(newSettings);

    // Update status
    updateConnectionStatus(
      newSettings.geminiApiKey ? "connected" : "disconnected"
    );

    // Show save confirmation
    saveStatus.textContent = "Settings saved";
    saveStatus.classList.add("visible");
    setTimeout(() => {
      saveStatus.classList.remove("visible");
    }, 2000);
  } catch (err) {
    console.error("Failed to save settings:", err);
    saveStatus.textContent = "Failed to save";
    saveStatus.style.color = "var(--error)";
    saveStatus.classList.add("visible");
    setTimeout(() => {
      saveStatus.classList.remove("visible");
      saveStatus.style.color = "";
    }, 3000);
  }
}
