# DP Code

DP Code is a minimal web GUI for coding agents like Codex, Claude Code, and Gemini CLI.

This project started as a clone of [T3Code](https://github.com/pingdotgg/t3code), and has since been customized into its own product with different branding, packaging, release wiring, and product-level behavior.

## How to use

> [!WARNING]
> You need to have the provider CLI you want to use installed and authenticated before DP Code can start a session.

- [Codex CLI](https://github.com/openai/codex) is required for Codex sessions.
- Claude Code is required for Claude sessions.
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) is required for Gemini sessions.

Gemini setup notes:

- Install `gemini` so it is on your PATH, or set a custom Gemini binary path in Settings.
- Authenticate by opening `gemini` and choosing Sign in with Google, or configure `GEMINI_API_KEY` / Vertex AI as documented in the [official Gemini CLI authentication guide](https://www.geminicli.com/docs/get-started/authentication/).
- DP Code starts Gemini through ACP mode (`gemini --acp`) and may inject a temporary `GEMINI_CLI_SYSTEM_SETTINGS_PATH` file to map DP Code's Gemini thinking controls onto documented Gemini model aliases.

See [`.docs/gemini-prerequisites.md`](./.docs/gemini-prerequisites.md) and [`.docs/codex-prerequisites.md`](./.docs/codex-prerequisites.md) for provider-specific setup notes.

You can also just install the desktop app. It's cooler.

Install the [desktop app from the Releases page](https://github.com/Emanuele-web04/dpcode/releases)

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
