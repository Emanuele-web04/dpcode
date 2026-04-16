# DP Code

DP Code is a minimal web GUI for coding agents (currently Codex and Claude, more coming soon).

This project started as a clone of [T3Code](https://github.com/pingdotgg/t3code), and has since been customized into its own product with different branding, packaging, release wiring, and product-level behavior.

## How to use

> [!WARNING]
> You need to have [Codex CLI](https://github.com/openai/codex) installed and authorized for DP Code to work.

You can also just install the desktop app. It's cooler.

Install the [desktop app from the Releases page](https://github.com/Emanuele-web04/dpcode/releases)

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

## Linux AppImage Builds

Linux AppImage packaging is supported from the workspace root:

```bash
bun run dist:desktop:linux
```

If `bun install` fails while rebuilding native dependencies such as `node-pty`, make sure Bun is using the `node-gyp` from the same Node toolchain as your active `node` and `npm` binaries:

```bash
sudo apt update
sudo apt install -y build-essential python3 make g++ pkg-config libx11-dev libxkbfile-dev
npm install -g node-gyp
npm_config_node_gyp="$(npm config get prefix)/bin/node-gyp" bun install
bun run dist:desktop:linux
```

The desktop app auto-detects common Codex CLI installs on Linux, including NVM-managed installs, so packaged builds do not need a separate wrapper script just to launch Codex.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
