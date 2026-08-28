# BRAVO — running it

The transport kit's own [README](README.md) documents the model layer. This file covers only the
app around it.

## Node

This machine had no Node on `PATH`, so an official build lives outside the repo:

```
~/.local/node        # Node 24.20.0 LTS (darwin-arm64, from nodejs.org)
```

Nothing else on the system was touched — no Homebrew formula, no shell profile edit. To
remove it: `rm -rf ~/.local/node`.

## Running it

Node is NOT on your shell `PATH` — a bare `npm run ...` will say `command not found`.
`./dev.sh` is the entry point that needs nothing set up: it puts `~/.local/node/bin` on
`PATH`, sets `NODE_USE_SYSTEM_CA=1` (§10 — the server must trust this network's own CA)
and defaults `$PORT` to 3210, since 3000 is usually taken on this machine.

```bash
./dev.sh              # web — next dev, open the printed URL
./dev.sh desktop      # the real macOS window, hot reload
./dev.sh package      # build the .dmg (slow — see docs/DESKTOP.md)
```

Override the port with `PORT=3400 ./dev.sh desktop`. Anything else is passed through to
`npm run`, so `./dev.sh lint` works too.

### Or put Node on your PATH permanently

Then plain `npm run dev:desktop` works in any shell:

```bash
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.zshrc && exec zsh
```

## Build

```bash
./dev.sh build
```

`utils/film/server/stitch.js` warns that `ffmpeg-static` is unresolved. That is by
design: the kit imports it lazily and the `film/stitch` route returns a clear
"install it once" error. No tool in §6 stitches, so it stays uninstalled until one does.

## Environment

`.env.local` holds the Ark credentials and the seven model-slot ids. It is gitignored.
`GET /api/film/config` reports which slots resolve — it returns ids and booleans only,
never key material.

## Milestones

See [BRAVO.md](BRAVO.md) §11. Shipped so far:

- **M1 · Shell** — rail + thread pane + composer in the Claude layout. One project, one
  thread, no agent. Messages persist across reloads.

Rail controls drawn but inert until their milestone are labelled with it (`M2`, `M4`,
`M6`) rather than hidden, so the shell teaches its own final shape.
