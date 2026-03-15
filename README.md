# Prompt Goblin

<table>
  <tr style="border:0">
    <td width="120" valign="top" style="border:0">
      <img src="public/settings-goblin-transparent.png" alt="Prompt Goblin icon" width="120" />
    </td>
    <td valign="top" style="border:0">
      Voice-to-text desktop app with pluggable providers (Gemini + OpenAI), built with Tauri + Rust & TypeScript.<br /><br />
      <em>Goblin note: screaming, yapping, and dramatic rambling all count as valid "speaking" in this establishment.</em>
    </td>
  </tr>
</table>

## Disclaimer

This project was created with an AI coding agent.
Development was done using OpenCode with a mixture of models, predominantly GPT-5.3 Codex, GPT-5.4 Codex and Claude Opus 4.6.

## Features

- Global hotkey recording with live voice transcription (`Alt+G` by default)
- Pluggable STT providers with Gemini and OpenAI support
- Provider/model selection with per-provider API keys
- Cached model lists with refresh, fallback selection, and last-known-good tracking
- Auto-stop on silence with configurable timeout
- Typing modes: incremental streaming or all-at-once on stop
- Mic test tools: quick 5-second test, continuous live test, transcript preview, and playback

## STT Models

Gemini 2.5 Flash Native Audio Preview 12-2025 is currently the model that performs best.

## Prerequisites

- [Bun](https://bun.sh/)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- Windows build tools for Rust (`MSVC`) and WebView2 runtime on Windows

## Development

Install dependencies:

```bash
bun install
```

Run the app in development mode:

```bash
bun run tauri dev
```

## Build

Build the frontend assets:

```bash
bun run build
```

Build the desktop app bundle:

```bash
bun run tauri build
```

## Output

Build artifacts are generated under:

`src-tauri/target/release/bundle/`

Release packaging currently targets Windows, macOS, and Linux desktop bundles.

## Contribution Guide

Contributions are accepted in the form of GitHub issues that define specifications for bug fixes and improvements.

Please provide a balanced level of detail: enough context and requirements to make implementation clear, but not so much that the specification becomes bloated.

This process ensures implementation is done by a trusted AI agent run by the repository maintainer, and is required for security reasons.

Direct pull requests are not accepted. Start with an issue first.

## Platform Testing Status

Windows is the primary tested platform at the moment.
MacOS and Ubuntu builds are not yet tested.

If you test on MacOS or Ubuntu, please submit an issue with reproduction steps, environment details, logs, and screenshots etc.

<img src="media/overlay.png" alt="Prompt Goblin Overlay" width="400" />

<img src="media/app.png" alt="Prompt Goblin Interace" width="400" />