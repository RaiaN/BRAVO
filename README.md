# BRAVO

An AI film studio with a chat interface. A film is an ordered list of shots; each shot has
a thread, and each thread has an agent that composes prompts, renders stills and takes, and
reports back.

There is no canvas. Nothing is dragged, positioned or connected. The rail is the film, in
order.

<!-- A screenshot belongs here. -->

## What it does

Open a thread and say what you want. The first message routes it to an agent, and from
then on that thread is that agent's:

| | |
|---|---|
| **Shot** | make one shot good — compose its prompt, render takes |
| **Edit** | operate on an existing take — a Seedance 2.5 editing task, or a fresh one |
| **Storyboard** | draw the film as a storyboard image |
| **Bible** | build a reference plate so every shot draws the same wolf |

Prompts are written under the model vendor's own prompt spec, sent verbatim. Anything that
costs money shows you the exact prompt and the exact ordered references first, and sends
nothing until you approve it.

## Running it

Needs Node 20+ and a ModelArk account.

```bash
npm install
cp .env.example .env.local     # fill in the model ids and keys
npm run dev
```

Then open the printed URL. `NODE_USE_SYSTEM_CA=1` is set by the scripts, which matters on a
network that intercepts TLS.

### As a macOS app

```bash
npm run dev:desktop      # the real window, hot reload
npm run build:desktop    # a .dmg in dist/mac
```

Electron boots Next in-process and serves it on localhost — the API routes are the whole
model layer, so a static export would have nothing behind it. A packaged app reads
`.env.local` from `~/Library/Application Support/BRAVO/`, never from inside the bundle.

### Tests

```bash
npm test               # deterministic gates — no model, no network, no money
npm run test:agents    # runs each agent against the real reasoner (needs a dev server)
```

No agent lands without a folder under `tests/agents/` exercising it on at least five
inputs. Gated tools stay stubbed unless you pass `--spend`.

## Layout

```
pages/index.js     the shell
components/        rail, thread pane, messages, results
agents/            the harness — one file per responsibility, one module per agent
state/             the data model and persistence
utils/film/        the ModelArk transport kit, unchanged
.agents/skills/    prompt specs, one folder each
```

## Docs

- [Architecture](docs/ARCHITECTURE.md) — the boundaries, and which file to touch
- [Setup](docs/SETUP.md) — running it, and the traps
- [Desktop](docs/DESKTOP.md) — how the macOS app is built
- [Testing](docs/TESTING.md) — the agent test contract
- [Status](docs/STATUS.md) — what works, what does not
- [Transport kit](docs/transport-kit.md) — the model layer

## Skills

A skill is a prompt spec bound to model slots and sent verbatim in the system prompt of
every call that model makes. A slot with nothing bound **refuses to compose** — there is no
fallback and no house style. The Skills screen shows every spec with its token weight, its
bindings and where it came from.

`skills-lock.json` records each one's source and hash, so a vendor document is never
mistaken for something written locally.

## Status

The four things above work end to end against real models. Not built: audio, forking a
shot, the multi-agent fleet view, and staleness propagation from a changed plate into the
shots that cite it. See [docs/STATUS.md](docs/STATUS.md).
