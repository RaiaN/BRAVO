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

Standard npm scripts, same as the ModelArk starter kit:

```bash
npm run dev            # web
npm run dev:desktop    # the macOS window, hot reload
npm run build:desktop  # the .dmg
```

The desktop pair defaults to port **3210**, not 3000 — something else on this machine
holds 3000 permanently, and `wait-on` would poll it forever while `next` quietly moved to
3001 and the window never opened. Override with `PORT=3400 npm run dev:desktop`.

### Node is not where you'd expect

This machine had no Node at all, so an official build lives at `~/.local/node` and
`~/.zshrc` puts it on `PATH`:

```
export PATH="$HOME/.local/node/bin:$PATH"
```

Without that line `npm` is `command not found` in every project, not just this one. To
undo: delete the block from `~/.zshrc` and `rm -rf ~/.local/node`.

`./dev.sh` does the same job without touching `PATH` (`./dev.sh`, `./dev.sh desktop`,
`./dev.sh package`) — useful from a shell that has not sourced `.zshrc`, such as a
non-interactive script or a cron job.

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

See [BRAVO.md](BRAVO.md) §11 for the spec's list, and [PLAN.md](PLAN.md) for what is
actually built and what the next milestone costs.

Shipped: **M1 · Shell** — rail + thread pane + composer in the Claude layout; one project,
one thread, no agent; messages persist across reloads. Plus the macOS package
([DESKTOP.md](DESKTOP.md)).

Rail controls drawn but inert until their milestone are labelled with it (`M2`, `M4`,
`M6`) rather than hidden, so the shell teaches its own final shape.
