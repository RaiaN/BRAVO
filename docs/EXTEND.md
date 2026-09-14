# BRAVO Extend

One story in, a film out. Type one or two sentences, pick a length, click. The runner plans 4–6 shots of 20–30 seconds, renders the first from its prompt, and renders every next shot as an extension of the previous take — the previous clip is the reference video and the prompt begins `Extend @Video 1 by N seconds.` — then stitches the takes into the film. No one is asked anything after the click.

## Run

```
npm run dev
```

Open `http://127.0.0.1:3000/` (or the port you chose). Paste the story, set the seconds (120 by default), click **Make the film**. The page shows the plan, then each shot's take as it lands, then the film.

From a terminal instead:

```
npm run extend -- --idea "<the story>" --seconds 120 --server http://127.0.0.1:3000
```

## What lands on disk

`runs/<runId>/`: `journal.ndjson` (every plan, request, result, fault, in order), `steps/` (one file per journal entry), `media/` (every take as `.mov` and the film as `slice.mp4`), `report.md`.

## The files

| file | role |
|---|---|
| `pages/index.js` | the page |
| `pages/api/extend.js` | starts a pass as a detached process; serves progress and media from the run directory |
| `agents/run-extend.mjs` | the runner: journal, look, client, the chain, a one-screen report |
| `agents/chain.js` | plan → render → extend → stitch |
| `agents/journal.js` | the journal |
| `looks/default.json` | the look (style line, constraints, format, audio on or off) |
| `utils/`, `pages/api/film/*`, `pages/api/seed*.js` | the transport kit: Seedance, Seedream, the reasoner, the media store — untouched |
| `tools/hook.mjs` | the extensionless-import hook the kit needs under Node |

## Provider contract

Extension requests carry the previous take as `asset://<assetId>` (`reference_video`), a prompt beginning `Extend @Video 1 by N seconds.`, `ratio: adaptive`, the shot's `duration`, and `output_format: mov`. Every take is downloaded once, saved to the journal, and registered as an asset through `/api/film/upload` typed `video/quicktime` (the kit's media store does not know `.mov`, so the preserve route would skip registration). If the Assets API refuses it, the fault is journaled and the next shot extends from the take's url. Each shot is rendered as five candidates, not one: right after the plan, one reasoner call per shot (all shots at once) rewrites the shot's description into five distinct variants (same people, place, action and continuity; different wording, camera, light and small beats; nothing that resembles protected material), and all five render concurrently. The moment a candidate finishes rendering, two things start for it at once: its bytes are saved and registered as an asset, and Persona, a director/screenwriter agent on the reasoner, watches it (video in, `{score, notes}` out). Nothing waits for a sibling. Once every candidate has settled, one last call has Persona choose from its own reviews, and the chain continues from that take. A candidate that fails (a provider refusal, a timeout) is a journaled `fault` on that variant and the others carry on; only when none of the five renders does the shot retry (new variants, up to three attempts with a pause), and a shot that never renders is skipped. Persona's three prompts (who it is, how it reviews one take, how it chooses) live in `looks/persona.json`, editable from the page's right-hand panel through `/api/persona` (GET reads, PUT validates placeholders and writes); the runner refuses to start on a broken file and journals the configuration it used in `intake`. Journal kinds: `variate`, `persona.review`, `persona.choice`. The page shows every candidate with Persona's score and notes and marks the pick.

## Environment

`.env.local` with the ModelArk key, the model slots (`MODELARK_MODEL_REASONER`, `MODELARK_MODEL_SEEDANCE_25`, `MODELARK_MODEL_SEEDREAM_PRO`) and the media-store credentials (`MODELARK_TOS_*`, `MODELARK_ASSET_*`). The dev server must be started after any new API route is added; a server that predates a route answers it with an HTML 404, which the journal reports as `E-ROUTE-404`.
