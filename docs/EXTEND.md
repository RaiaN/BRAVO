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

Extension requests carry the previous take as `asset://<assetId>` (`reference_video`), a prompt beginning `Extend @Video 1 by N seconds.`, `ratio: adaptive`, the shot's `duration`, and `output_format: mov`. Every take is downloaded once, saved to the journal, and registered as an asset through `/api/film/upload` typed `video/quicktime` (the kit's media store does not know `.mov`, so the preserve route would skip registration). If the Assets API refuses it, the fault is journaled and the next shot extends from the take's url. A failed render retries three times with a pause; a shot that never renders is skipped and the chain continues from the last good take.

## Environment

`.env.local` with the ModelArk key, the model slots (`MODELARK_MODEL_REASONER`, `MODELARK_MODEL_SEEDANCE_25`, `MODELARK_MODEL_SEEDREAM_PRO`) and the media-store credentials (`MODELARK_TOS_*`, `MODELARK_ASSET_*`). The dev server must be started after any new API route is added; a server that predates a route answers it with an HTML 404, which the journal reports as `E-ROUTE-404`.
