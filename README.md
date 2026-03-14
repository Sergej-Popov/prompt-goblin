# Prompt Goblin

Voice-to-text desktop app with pluggable providers (Gemini + OpenAI), built with Tauri + Vanilla TypeScript.
> Goblin note: screaming, yapping, and dramatic rambling all count as valid "speaking" in this establishment.

## Disclaimer

This project was created with an AI coding agent.
Development was done using OpenCode with a mixture of models, predominantly GPT-5.3 Codex and Claude Opus 4.6.

## STT Models

Gemini 2.5 Flash Native Audio Preview 12-2025 is currently the model that performs bests.

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

On Windows, the installer is generated at:

`src-tauri/target/release/bundle/nsis/`

## Contribution Guide

Contributions are accepted in the form of GitHub issues that define specifications for bug fixes and improvements.

Please provide a balanced level of detail: enough context and requirements to make implementation clear, but not so much that the specification becomes bloated.

This process ensures implementation is done by a trusted AI agent run by the repository maintainer, and is required for security reasons.

Direct pull requests are not accepted. Start with an issue first.

## Platform Testing Status

Windows is the primary tested platform at the moment.
MacOS and Ubuntu builds are not yet tested.

If you test on MacOS or Ubuntu, please submit an issue with reproduction steps, environment details, logs, and screenshots etc.
