#!/usr/bin/env bash
# BRAVO dev server.
#
# Node lives under ~/.local/node (this machine had none on PATH), and §10 requires
# NODE_USE_SYSTEM_CA=1 so the dev server trusts the network's own CA.
#
# No hardcoded --port: next dev honours $PORT, so the harness can place it anywhere.
set -e
export PATH="/Users/bytedance/.local/node/bin:$PATH"
export NODE_USE_SYSTEM_CA=1
cd "$(dirname "$0")"
exec npx next dev "$@"
