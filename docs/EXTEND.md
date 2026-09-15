# BRAVO Extend

One story in, a film out. Type one or two sentences, pick a length, click. The runner plans 4–6 shots of 20–30 seconds, renders the first from its prompt, and renders every next shot as an extension of the previous take — the previous clip is the reference video and the prompt begins `Extend @Video 1 by N seconds.` — then stitches the takes into the film. No one is asked anything after the click.

## Run

```
npm run dev
```

Open `http://127.0.0.1:3004/`. BRAVO always uses port 3004. Paste the story, set the seconds (120 by default), click **Make the film**. The page shows the plan, then each shot's take as it lands, then the film.

From a terminal instead:

```
npm run extend -- --idea "<the story>" --seconds 120 --server http://127.0.0.1:3004
```

## What lands on disk

`runs/<runId>/`: `journal.ndjson` (every plan, reasoner request/result, QC stage, inspection, receipt, Persona decision and fault, in order), `steps/` (one file per journal entry), `media/` (every take as `.mov` and the film as `slice.mp4`), `report.md` (all five receipts per shot and Persona's comparisons and selection). Failed runs retain all completed evidence in the journal.

## The files

| file | role |
|---|---|
| `pages/index.js` | the page |
| `pages/api/extend.js` | starts a pass as a detached process; serves progress and media from the run directory |
| `agents/run-extend.mjs` | the runner: journal, look, client, the chain, a one-screen report |
| `agents/chain.js` | plan → render candidates → Persona take selection → film QC → extend → stitch |
| `agents/film-qc.js` | five independent parallel inspection/receipt branches, validation, retries and Persona receipt selection |
| `agents/config.js`, `agents/settings-store.js` | editable agent defaults, template validation, atomic settings persistence and change journal |
| `components/AgentSidebar.js`, `pages/api/agents.js` | collapsible right sidebar and settings API |
| `agents/journal.js` | the journal |
| `looks/default.json` | the look (style line, constraints, format, audio on or off) |
| `utils/`, `pages/api/film/*`, `pages/api/seed*.js` | the transport kit: Seedance, Seedream, the reasoner, the media store |
| `tools/hook.mjs` | the extensionless-import hook the kit needs under Node |

## Provider contract

Extension requests carry the previous take as `asset://<assetId>` (`reference_video`), a prompt beginning `Extend @Video 1 by N seconds.`, `ratio: adaptive`, the shot's `duration`, and `output_format: mov`. Every take is downloaded, saved to the journal, and registered as an asset through `/api/film/upload` typed `video/quicktime`. If the Assets API refuses registration, the fault is journaled and the next shot extends from the take's URL.

Each shot has five render candidates. After planning, parallel reasoner calls rewrite each shot into five variants; each shot's variants render concurrently. As each candidate lands, it is saved/registered and reviewed by Persona in parallel. Persona chooses from its reviews after all candidates settle, even if only one candidate succeeded. Render/review failures are logged; the existing shot retry policy allows three attempts, skipping a shot with no usable take.

## Film QC and receipts

Persona is one director/screenwriter agent. Seed 2.0 Pro is the reasoning engine shared by Persona and the five independent QC agents, resolved through `MODELARK_MODEL_REASONER` with high reasoning requested. Account-scoped endpoint IDs remain configurable; configure this slot to your Seed 2.0 Pro endpoint. For an opaque endpoint ID, set `MODELARK_REASONER_PROTOCOL=responses`.

After each Persona take choice, exactly five branches start concurrently: director, cinematographer, film editor, VFX supervisor and sound supervisor. Every agent is responsible for the entire take, with its discipline as an emphasis. Each branch watches the same selected video, records a structured inspection, and uses only that inspection and the common film brief to produce its own improvement receipt. Branches never see sibling results.

Inspections carry strengths, limitations, quality scores and timecoded findings. Receipts carry priorities, linked findings, concrete changes by department, brief justifications, risks, acceptance checks, preservation notes and a revised shot prompt. Intentional silence is respected when audio is off. Unavailable audio or previous footage must be identified as a limitation.

Once all five valid receipts exist, the same Persona system prompt is used to review the selected video and compare all five receipts. Persona selects one exact receipt ID, gives a reason, and records the strengths and tradeoffs of every proposal. The chain then continues from the selected take. The selected receipt is a proposed improvement plan: this stage does not apply edits or render the revised prompt.

Each failed QC stage gets up to three attempts; only that stage retries. Invalid JSON and schema errors are logged before retrying. A permanently failed branch or Persona selection fails the run after the other branches settle. It never silently chooses from fewer than five receipts or triggers another video render. Reasoner requests time out after six minutes.

All agent prompts are editable in the **Agents** sidebar on the right, collapsed by default. Persona, each of the five QC agents, the shot planner and the take-variation helper have their own collapsible sections. Each QC agent exposes its name, expertise, system instructions, inspection prompt and receipt prompt. Draft edits survive collapsing the sidebar and page reloads. Save applies to subsequent runs; a running pass keeps its configuration snapshot.

`GET /api/agents` returns the current configuration, defaults, field descriptions and revision. `PUT /api/agents` validates the five fixed QC identities, nonempty fields and allowed placeholders, checks the revision to prevent stale overwrites, and atomically saves `looks/agents.json`. Each save is journaled before writing, with full before/after configurations and revisions, then its outcome. Rejected saves are also recorded in `runs/agent-settings/journal.ndjson`. Restore-default buttons edit the draft until saved.

Until `looks/agents.json` exists, existing `looks/persona.json` customizations are loaded along with defaults for the other agents. `/api/persona` remains compatible and writes through the same settings store and journal. Each run records the complete configuration in `intake` and `agents.config`, before any model work.

Every reasoner request is journaled before dispatch with agent/stage identity, prompts, selected model, media reference and requested reasoning effort. Results include assistant output, elapsed time and provider ID/model/usage metadata when available; failures retain provider error details and HTTP status. The Responses transport also records whether the thinking parameter required a fallback. Every video polling response is recorded as `render.poll`; renders, registrations, stitching and measurement have request/result pairs. Logs store observations and concise decision summaries, not private internal deliberation. QC entries also include shot, take, agent, stage and attempt identities. Additional journal kinds: `qc.started`, `qc.stage`, `qc.response`, `qc.inspection`, `qc.receipt`, `persona.receipt-choice`, `qc.complete`, `qc.failed`. Serialized, synced journal writes preserve ordering across parallel agents.

The page exposes live agent progress, expandable inspections and receipts, Persona's final choice and comparisons, and a **Download run journal** link available during and after a run.

## Verification

Run `node --import ./tools/hook.mjs --test tests/*.test.mjs` for mock-provider checks of branch independence/concurrency, retry isolation, failure handling, selection validation, settings persistence and conflicts, custom prompts, durable logging and chain/API integration. Run `npm run build` for production compilation. On this workstation, use `/Users/bytedance/.local/node/bin/node` and `./dev.sh build`.

## Environment

`.env.local` with the ModelArk key, the model slots (`MODELARK_MODEL_REASONER`, `MODELARK_MODEL_SEEDANCE_25`, `MODELARK_MODEL_SEEDREAM_PRO`) and the media-store credentials (`MODELARK_TOS_*`, `MODELARK_ASSET_*`). The dev server must be started after any new API route is added; a server that predates a route answers it with an HTML 404, which the journal reports as `E-ROUTE-404`.
