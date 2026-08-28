#!/usr/bin/env bash
# BRAVO — the one entry point that does not need Node on your PATH.
#
# This machine had no Node, so an official build lives at ~/.local/node. §10 also
# requires NODE_USE_SYSTEM_CA=1 so the server trusts this network's own CA. Both are set
# here, which is why these work when a bare `npm` does not.
#
#   ./dev.sh                 web — next dev, open it in a browser
#   ./dev.sh desktop         the real macOS window, hot reload
#   ./dev.sh package         build the .dmg (slow: full next build + electron-builder)
#   ./dev.sh <anything else> passed through to npm run
#
# Honours $PORT (default 3210 — 3000 is usually taken on this machine):
#   PORT=3400 ./dev.sh desktop
set -e

export PATH="/Users/bytedance/.local/node/bin:$PATH"
export NODE_USE_SYSTEM_CA=1
export PORT="${PORT:-3210}"
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || {
  echo "dev.sh: no node at /Users/bytedance/.local/node/bin — reinstall it, see docs/SETUP.md" >&2
  exit 1
}

case "${1:-web}" in
  web)     exec npx next dev -p "$PORT" ;;
  desktop) exec npm run dev:desktop ;;
  package) exec npm run build:desktop ;;
  *)       exec npm run "$@" ;;
esac
