#!/usr/bin/env bash
set -euo pipefail

export npm_config_node_gyp="${npm_config_node_gyp:-$(npm config get prefix)/bin/node-gyp}"

bun install
bun run build:desktop
bun run dist:desktop:linux
