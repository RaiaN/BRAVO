# BRAVO — model transport kit

Everything needed to talk to ModelArk (Seedance video, Seedream image, Seed reasoner,
Seed audio) and nothing else. No UI, no agents, no film logic. Lift this into the new
repo as-is and build BRAVO on top of it.

## What is here

**Endpoints** (`pages/api/`) — the server routes the browser calls. They hold the API key
server-side, stage `data:` payloads to TOS, and proxy media.

| Route | Purpose |
|---|---|
| `seed.js` | the reasoner (Seed 2.0 Pro) — every LLM call |
| `seedream.js` | image generation |
| `seedance.js` / `seedance-status.js` | video generation, async: start then poll |
| `film/audio.js` / `film/extract-audio.js` | speech and audio extraction |
| `film/upload.js` / `film/media.js` / `film/asset.js` / `film/preserve.js` | media in, media out, portrait-library registration |
| `film/imagine.js` / `film/frames.js` / `film/last-frame.js` | image edit, frame extraction |
| `film/stitch.js` | concatenate takes |
| `film/proxy-image.js` / `film/resign.js` | CORS proxy, re-sign expiring urls |
| `film/config.js` | which model slots are configured (no secrets) |
| `film/skills.js` | serves `.agents/skills/*/SKILL.md` |

**Transport** (`utils/film/core/`)

- `client.js` — `createBrowserClient(apiKey)` → `reason` · `generateImage` · `startVideo` ·
  `pollVideo` · `generateSpeech`. One choke point; everything goes through it.
- `operations.js` — `animate` (the video call: refs, first frame, audio/video refs,
  duration, resolution) and friends.
- `retry.js`, `parallel.js` — transient-error retry, bounded concurrency.

**Model layer** (`utils/film/suiteConfig.js`) — slots, env vars, and the capability
traits every consumer keys off: `maxSeconds`, `res`, `refCap`, `keyframes`, `refPrefix`.
Behaviour reads traits, never model names.

**Skills** (`utils/film/skills.js` + `.agents/skills/`) — vendor prompt specs bound to
model slots and sent verbatim. `sd25-pe` for Seedance 2.5, `sd20-pe` for the 2.0 family.
`requireSkillLine(modelKey)` throws when a slot is unbound: no silent fallback.

**Prompt templates** (`utils/film/promptTemplates.js`) — the machinery only.
`DEFAULT_TEMPLATES` is empty; BRAVO authors its own.

## Setup

Copy `.env.example` to `.env.local` and fill the model ids and credentials.

The dev server needs the system CA on a MITM'd network:

```bash
NODE_USE_SYSTEM_CA=1 npx next dev
```

## Contracts worth knowing

- **Video is async.** `startVideo` returns a task id; poll `seedance-status`.
- **Editing tasks lock ratio and duration** — do not send them, or the call fails with
  `InvalidParameter.TaskTypeConstraint`. Resolution IS still honoured.
- **`duration: 'auto'`** omits the field entirely.
- **Photoreal people as raw urls get screened.** Register them as portrait-library assets
  (`film/preserve.js`) and send `image_asset_id`.
- **Reference order is the citation numbering.** The Nth image is image N.
