import { load, Store } from "@tauri-apps/plugin-store";

export interface Settings {
  geminiApiKey: string;
  hotkey: string;
  typingMode: "all_at_once" | "incremental";
  autoStopOnSilence: boolean;
  autoStopSilenceMs: number;
  language: string;
}

const DEFAULTS: Settings = {
  geminiApiKey: "",
  hotkey: "Alt+Super+G",
  typingMode: "all_at_once",
  autoStopOnSilence: false,
  autoStopSilenceMs: 2000,
  language: "auto",
};

let store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await load("settings.json", { autoSave: true, defaults: {} });
  }
  return store;
}

export async function loadSettings(): Promise<Settings> {
  const s = await getStore();
  const settings: Settings = { ...DEFAULTS };

  const apiKey = await s.get<string>("geminiApiKey");
  if (apiKey !== undefined && apiKey !== null) settings.geminiApiKey = apiKey;

  const hotkey = await s.get<string>("hotkey");
  if (hotkey !== undefined && hotkey !== null) settings.hotkey = hotkey;

  const typingMode = await s.get<string>("typingMode");
  if (typingMode === "all_at_once" || typingMode === "incremental") {
    settings.typingMode = typingMode;
  }

  const autoStop = await s.get<boolean>("autoStopOnSilence");
  if (autoStop !== undefined && autoStop !== null)
    settings.autoStopOnSilence = autoStop;

  const silenceMs = await s.get<number>("autoStopSilenceMs");
  if (silenceMs !== undefined && silenceMs !== null)
    settings.autoStopSilenceMs = silenceMs;

  const language = await s.get<string>("language");
  if (language !== undefined && language !== null) settings.language = language;

  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const s = await getStore();
  await s.set("geminiApiKey", settings.geminiApiKey);
  await s.set("hotkey", settings.hotkey);
  await s.set("typingMode", settings.typingMode);
  await s.set("autoStopOnSilence", settings.autoStopOnSilence);
  await s.set("autoStopSilenceMs", settings.autoStopSilenceMs);
  await s.set("language", settings.language);
  await s.save();
}
