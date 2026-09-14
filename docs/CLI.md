# The CLI — `bravo`

`cli/bravo.js` is the Pipeline V2 runtime described in [PIPELINE.md](PIPELINE.md): an idea, a style file, a target duration and a policy file in; a film slice and a pass journal out, with no person in the loop after intake. It runs against a BRAVO dev server through the relative-fetch shim in `tests/lib/client.js` — every `/api/...` route the agents call is answered by that server, which holds the keys and the media store.

```
npm run bravo -- film --idea <text|file> --style <style.json> --seconds N --policy <policy.json> --prices <prices.json> [--mode edit|staged] [--server <url>]
npm run bravo -- extend --idea "<the story>" [--seconds 120] [--style looks/default.json] [--policy policy/default.json] [--prices policy/prices.json] [--server <url>]
npm run bravo -- resume <runId> [--server <url>]
npm run bravo -- judge <runId> [--server <url>]
npm run bravo -- note <runId> --text "<the creator's words>" --severity blocker|note|taste [--shot <id>] [--timecode <seconds>] [--rule <id>]
npm run bravo -- report <runId>
npm run bravo -- kb fold --policy <policy.json> | kb query <term> | kb rebuild --policy <policy.json>
npm run bravo -- replay <runId> --dry
```

The `bravo` script runs Node with `--env-file-if-exists=.env.local` (the same slots and TOS keys the server reads) and the extensionless-import hook. `--server` names the dev server; `BRAVO_TEST_URL` is read when the flag is absent; with neither the command refuses (`E-ARGS-SERVER`). Every flag is explicit: an unknown flag, a flag given twice or a flag without a value refuses with the usage text (`E-ARGS`), a missing required flag by name (`E-ARGS-MISSING-<FLAG>`), a non-integer `--seconds` (`E-ARGS-SECONDS`), and a run id that is not a plain token (`E-ARGS-RUNID`). Exit codes: `0` a complete pass or a finished command, `1` a refused, failed or halted pass, `2` an argument error (every `E-ARGS*` code).

Directories are bound to the working directory: `runs/<runId>/` for passes, `knowledge/` for the derived index, `rules/` for the rulebooks and `rules/rubrics/` for the rubric books, `skills/` for the prompt specs a dry replay serves.

`--mode edit` (the default) runs the edit loop from PIPELINE.md: every shot renders as one take, is measured and QC'd, and a failing take is judged and edited or regenerated within its attempt budget. `--mode staged` runs the staged path (plates, keyframe candidates, chain-parallel schedule).

The same pass has a web page: `/extend` on the dev server (also linked from the rail) takes the story and the seconds, starts `bravo extend` as a detached process with a named run id, shows the plan and every shot's attempts, QC verdicts, judge decisions and faults live from the journal, and plays `media/slice.mp4` when it lands.

`extend` is the one-prompt entry: it takes the story and a target length and renders a chain of 20–30 second shots, each generated as an extension of the previous take's video asset; its optional flags have declared defaults (120 seconds, `looks/default.json`, `policy/default.json`, `policy/prices.json`) that the journal records as defaults.

## Inputs

**The idea** — `--idea` takes text, or the path of a file whose contents are the idea; which one was used is journaled as `ideaSource`.

**The style file** — the shape in PIPELINE.md, every key required, unknown keys refused:

```json
{ "id": "", "look": { "style": "", "grade": "" }, "constraints": [], "audio": true, "format": { "resolution": "", "ratio": "" }, "world": "",
  "references": [{ "name": "", "role": "character|location|look", "image": "https://..." }],
  "doctrine": [], "precedentTags": [], "seed": null }
```

A reference with an `image` (an http(s) or app-relative url) is checked into the run's media store at intake as `media/reference-<name>.<ext>` and becomes a bible entry with that plate; the brief entry of the same name is resolved to that bible id instead of `new`. A reference without an image is a fixed name the ideation must use, and the breakdown composes a plate for it.

**The policy file** — validated by `loadPolicyValues` from `agents/director/policy.js`; `policy/default.json` is the shipped one. Its hash rides on the intake record, the approval record and the report.

**The price file** — POL-000 requires a dated price file at intake, and every reservation is priced from it:

```json
{ "date": "YYYY-MM-DD", "usd": { "still": 0.05, "videoSecond": 0.1, "judgeCall": 0.01, "reasonCall": 0.02 } }
```

`usd` per still, per second of video, per judge call and per reasoning call. The approval's `estimate.usd` is `stills.max × still + videoSeconds.max × videoSecond + judgeCalls.max × judgeCall` from the approval arithmetic, and it is what `budget.maxUsd` is checked against when that ceiling is a number.

**Environment** — the server's `/api/film/config` supplies the model slots (the CLI applies them exactly as the browser does); the intake refuses by name any slot the pass uses that is unset: the reasoner, `seedance25` (the director's video slot) and the default image slot. `MODELARK_MODEL_AUDIO_JUDGE` names the audio-capable judge slot and is required when `style.audio` is true. The media store is required through `MODELARK_TOS_BUCKET`, `MODELARK_TOS_REGION`, `MODELARK_ASSET_ACCESS_KEY` and `MODELARK_ASSET_SECRET_KEY`. The server must hold a server key (`hasServerKey` in its config).

## What `film` does

1. **Open the journal** at `runs/<runId>/` before anything else, so even a refusal is on record. `runId` is `run_<UTC stamp>_<random>`.
2. **Intake** — the only refusal the pipeline knows. In order, each refused by name and journaled as `intake.refused` with its code: the idea (`E-INTAKE-IDEA`), the seconds (`E-INTAKE-SECONDS`), the style file and its schema (`E-INTAKE-STYLE-FILE`, `E-INTAKE-STYLE-<KEY>`), the policy (`E-INTAKE-POLICY`), the price file (`E-INTAKE-PRICES-FILE`, `E-INTAKE-PRICES-<KEY>`), the rulebook and rubric books loaded from `rules/` under the strict loaders (`E-INTAKE-RULEBOOK`, `E-INTAKE-RUBRICS`), the server and its key (`E-INTAKE-SERVER`, `E-INTAKE-SERVER-KEY`), the slots (`E-INTAKE-SLOT-<SLOT>`, `E-INTAKE-SLOT-AUDIOJUDGE`), the media store (`E-INTAKE-TOS`), the target seconds against the CIN-005 window read from the rule's params and the slot's maximum (`E-INTAKE-WINDOW`, with the arithmetic), the policy's completion decisions against what this executor can perform — `completion.onExhaustedShot` must be `promote-best`, `completion.onRenderCeiling` `promote-best` or `still-hold` (`E-INTAKE-POLICY-COMPLETION`, from `completionProblems` in `agents/director/nodes.js`) — and finally POL-000 run through `runPolicyGate` as the law's own confirmation (`E-INTAKE-POL-000`). The `intake` record carries every input in full — style, policy values, prices — with their hashes, the rulebook and rubric versions, the resolved slots and the gate results. Resume, judge and replay read their inputs back from this record: the journal wins.
3. **Synthesize the project** — `makeProject`, the look from the style, reference bible entries, the director agent's `latch`, a latched director thread. No router runs.
4. **Ideate** — `ideate()` derives the brief input with provenance; POL-001 runs on that provenance inside the stage (journaled as `policy.gate`; a refusal is a fault the stage retries, `E-IDEATE-POL-001`); the CLI maps reference names to their bible ids and journals `brief.input`.
5. **Brief, screenplay, breakdown** — the three director tools called through their `run()` in fixed order with `ctx = { client, modelId: null, requireSkillLine, policy, rulebook, journal }`: the rulebook intake loaded (so the sequence pins intake's `rulebookVersion` and nothing fetches `/api/rules`) and the pass journal, which the tools write their gate runs to as `gate.attempt` and refuse to run without (`E-TOOL-RULEBOOK`, `E-TOOL-JOURNAL`). Each call and its output is journaled as `tool`, its final gate report as `gate`, and appended to the director thread as a tool message. The brief's `format` is what ideation carried from `style.format` and `style.audio`, stamped with SCR-008's fps by the brief tool — the CLI patches nothing after the tool. The project is saved after each stage.
6. **Keyframe decisions** — the breakdown records `decideKeyframe` on every plan shot; the CLI confirms them with POL-012 and checks chain lengths with POL-006 (each a `policy.gate` step), journaled as `keyframes` with the attempt and the budget. A blocker is a regeneration, not a failure: `regeneration { stage: 'plan', mode: 'plan-regenerate', attempt, budget, cause, ruleId, blockers }`, then the breakdown runs again with the refusal in its prompt (`input.rejected`), within `policy.attempts.fault`; exhaustion fails the pass by name before any money (`E-PLAN-POLICY-EXHAUSTED`).
7. **Approval** — `approveManifest` over the manifest enriched with subject, force, change and keyframe per shot, with what the ledger has already spent on reasoning; POL-002 through `runPolicyGate` (a `policy.gate` step); the `approve` record carries the arithmetic, the refusals, the estimate and the policy hash. A refusal fails the pass with the numbers (`E-APPROVE-REFUSED`).
8. **The approved sequence** — the `sequence` tool's `prepare()` builds the card; the CLI appends it to the thread already approved and journals `sequence.approved` with `decidedBy: 'policy'`.
9. **Schedule** — `runSequence` from `agents/director/execute.js` with a `pass`: the policy, the pass journal, the priced reserve, the stages, the style, the rubrics, the loaded rulebook and the runId. This is the policy flow: regeneration within the attempt budgets, invalidation of continuous successors, promotion of the best take on exhaustion, faults retried after `policy.resume.backoffMs` and completed by name when `policy.attempts.fault` is spent; the only halt is a completion the executor cannot perform. Every change the schedule applies to the project is written through to `project.json` (atomic, coalesced while a write is in flight, flushed before the pass goes on; a failed write is `E-PROJECT-WRITE`), so a killed pass has a run record to resume from. An executor that returns with the sequence neither assembled nor halted is a defect the CLI names (`E-SCHEDULE-SILENT`).
10. **Join QC and film QC** — after assembly the CLI runs `joinQC` for every join (journaled as `joins`) and `filmQC` over the slice (journaled as `film`). Their judge calls reserve through the reserving client under the plan nodes they name — `chain:<shot>` and `final` — one reservation per call; the CLI makes no reservation of its own for them. Each is a stage with the fault budget; an exhausted stage files a `fault` finding (`E-JOINQC-FAULT`, `E-FILMQC-FAULT`) and the pass still completes. A join whose chain or takes were never measured refuses by name (`E-JOIN-UNMEASURED`), as does a film QC with no assembled slice (`E-FILM-UNASSEMBLED`). A join with a still held under the render ceiling on either side is never judged: there is no take to sample and no measured boundary, so `witness` reads `held` off the `shoot:<shot>` values, journals `join.skipped { joinRef, reason: 'still-hold', held }` and lists the join as `{ joinRef, skipped: 'still-hold', held }` in the `joins` row; the report names every skipped join under the film-and-journal guarantee.
11. **Complete, persist, fold, report** — the journal audit (`policy.audit { scope: 'journal' }`: POL-003, 004, 005, 007, 008, 011, 013 read from the journal alone), the `complete` record with the guarantees and the ledger (a pass whose executor appended no iteration record cannot close: `E-COMPLETE-NO-ITERATION`), the project saved to `project.json`, `kb fold` over every run under `runs/` (journaled as `kb.fold`) followed by the knowledge audit (`policy.audit { scope: 'knowledge' }`: POL-009 and POL-010 over the folded index), and last `report.md` (below), so the pass writes the same report `bravo report` regenerates.

Faults during planning — an unlawful screenplay twice, a tool error, a model fault — retry within `policy.attempts.fault`, each attempt journaled as `fault`; an exhausted stage fails the pass with `E-PASS-EXHAUSTED-<STAGE>`. The CLI builds its client from `createBrowserClient` bare, with no retry of its own: the stage budget is the only retry a reasoning call gets, so a throttled or timed-out call is an `intent` with an error `result`, a `fault` row naming the stage and the attempt, and a fresh reservation before the next try. `agents/client.js` keeps its transport-level retry for the canvas, where there is no journal beneath it. A failed pass writes `pass.failed`, appends an iteration record with `status: { failed }` so notes can attach, writes the report, saves the project and folds the knowledge index — every shortfall named, nothing silent. A halted schedule (a completion the executor cannot perform after an exhausted fault budget — `E-COMPLETION-<KIND>` for a plate, measure, chain, assemble or final node, `E-COMPLETION-NO-TAKE` for a shoot that never recorded a take) writes `pass.halted` and completes with `status: 'halted'`; it is resumable.

### Reservations and the ledger

Every paid or metered call is preceded by a reservation through `makeReserve` from the policy module, priced from the price file. Plates and takes are reserved by the executor's nodes, keyframe candidates by the candidate stage; the CLI wraps the client so every reasoning call reserves one `reason` unit (or one `judge` unit when the call carries images) under the plan node the call names, or — for a call that names none during `ideate`, `brief`, `screenplay` or `breakdown` — under that planning stage; a call without a node id anywhere else is refused (`E-RESERVE-NO-NODE`), so no reservation is ever filed under `schedule` or a stage label. The approval arithmetic counts judge calls the same way the reservations meet them: every judged item times `JUDGE_PROTOCOL.callsPerItem` (2 at base, 5 at most), so `judgeCalls.max` is the ceiling the ledger can reach and the pass's judge reservations equal its kept judge cost rows.

## Outputs, under `runs/<runId>/`

| file | what |
|---|---|
| `journal.ndjson` + `steps/NNNN-<kind>.json` | the pass, in order; every record is `{ step, at, kind, data }` |
| `media/` | `reference-*.ext`, `plate-<entity>-a<admission>-attempt<n>.ext` and the kept `plate-<entity>.ext`, `candidate-<shot>-a<attempt>-c<i>.ext`, `keyframe-<shot>-attempt<n>.ext`, `shoot-<shot>-attempt<n>.mp4` and its `-lastframe.jpg`, `slice-a<admission>.mp4` |
| `project.json` | the persisted project: brief, screenplay, plan, run record, iterations with notes |
| `cost.ndjson` | one row per reserved unit spent, naming its `reservationId`: kept, wasted (coded), refused (coded); reason and judge calls made through the wrapped client are rows too |
| `errors.ndjson` | one typed row per finding, the knowledge index's source |
| `report.md` | the pass in human terms |

### `report.md`

Rendered by `cli/report.js` from the journal and the project, and regenerated verbatim by `bravo report`. It opens with the run's identity and hashes, then the guarantees from PIPELINE.md, each met or not met with its detail and the rows behind an unmet one:

- a film and a journal (the assemble step and the `media/slice-a<admission>.mp4` it names on disk; every join left unjudged under a still-hold, from the `join.skipped` steps)
- target duration (the CIN-008 gate at final)
- every shot names subject, force and change (the plan and POL-012)
- nothing reaches the video model unselected (every `render.start` intent carries a first frame)
- obvious artifacts do not ship (no `E-SHOT-ATTEMPTS-EXHAUSTED`, no `E-SHOT-MEASURE-SHIPPED`)
- money is bounded (paid intents against reservations, waste rows coded)
- the judge's authority is earned (spending rubrics against journaled promotions)
- the journal never lies (this report cites its rows)

Then the policy rules — every `policy.gate` and `policy.audit` row: the rule, where it ran, whether it held, how many rows and blockers — the regenerations with their causes and completion decisions, the shortfalls, the blocking findings, the judge's open findings (witness and judge-reliability rows), the faults, the cost by kind and disposition with the ledger, and the creator's notes.

## Journal kinds

Every command that reads a run back — `resume`, `judge`, `report`, `note`, `replay` — loads it the same way: no `journal.ndjson` under `runs/<runId>/` is `E-RUN-MISSING`, and a journal with no `intake` record is `E-RUN-NO-INTAKE`.

Written by the CLI: `pass` (the command and its start), `intake`, `intake.refused`, `project`, `policy.gate` (one policy rule run where its statement says), `brief.input`, `tool`, `gate`, `brief`, `screenplay`, `plan`, `keyframes`, `regeneration` (with `stage: 'plan'`, a plan the policy refused and the breakdown ran again), `approve`, `sequence.approved`, `fault` (a planning or QC stage attempt that threw), `join.skipped` (a join witness never judged because a side is a held still), `joins`, `film`, `policy.audit` (the journal audit at completion and the knowledge audit after every fold), `pass.failed`, `pass.halted`, `report`, `complete`, `kb.fold`, `resume`, `resume.media`, `resume.refused`, `judge.start`, `judge`, `judge.refused`, `note`; and, only under `replay --dry`, the replayed `candidate`, `score` and `qc` steps (each marked `replayed: true`) that stand in for the QC modules.

Written by the modules the CLI drives: `ideate.start`, `ideate.attempt`, `ideate.result`, `ideate.refused` (ideation); `gate.attempt` (the director tools, one per gate run); `reservation`, `reservation.refused` (policy); `intent`, `result` (the journaled client and the executor's render intents); `node`, `schedule`, `keyframe`, `selection`, `measure`, `join`, `qc`, `assemble`, `final`, `regeneration`, `completionDecision`, `iteration`, `cost`, `finding`, `media` (the executor and the journal); `candidate`, `score`, `select`, `judge` (the QC modules).

`errors.ndjson` rows come from `finding` steps; `cost.ndjson` rows from `cost` steps.

### The pass journal adapter

`passJournal(journal, { runId })` wraps the fsynced journal for the executor and the QC modules, whose call sites do not await every write. It keeps the journal's own ordering (the queue is serial), tracks every write so `drain()` surfaces a failed one, resolves `result(ticket, data)` from the promise `intent()` returned, and stamps `runId` on findings — the one thing the pass knows and the modules do not. It repairs nothing else: a finding whose `evidence` is not an array or a cost row carrying a `cause` column is refused by the journal's schema at the caller, because `FINDING_SCHEMA` and `COST_SCHEMA` are the contract the modules write to directly. The pass suite (`tests/lib/pass.test.js`) runs on this same adapter over the real `openJournal`, so every scenario exercises the fsynced journal; its wire stub carries a virtual clock that `makeReserve` reads, so the wall-minute ceiling scenario is deterministic. A write that failed asynchronously is filed at completion as a `fault` finding coded `E-JOURNAL-WRITE`; a row the journal refuses outright still throws at the caller.

## `resume <runId>`

Hydrates `project.json`, reopens the journal (replaying it, so the step counter continues and unanswered intents are known) and audits every node of the run:

- a **done** node whose media is on disk is kept;
- a done node whose media copy is missing is **restored** from the durable store by the url the node recorded, without paying (`restored`); if the store no longer has it the node is **dropped** and everything that descended from it is reset with it, computed from the dependency graph — a plate resets every keyframe, take, measurement, join, the assembly and the final; a keyframe or take resets its shot and its continuous successors — with every discarded take counted as `E-WASTE-RESUME-DROPPED` (`dropped`, `cascaded`);
- a node that was **running** or **halted** re-enters as pending; a shoot with a task id re-polls that task and never starts a second one; a `render.start` intent with no result is an **orphan**, counted against the take and video-second ceilings;
- fault counts are cleared (`faultsCleared`), the halt is cleared, the ledger is rebuilt from the last reservation plus the orphans, and the pass's start time stays the intake's.

The audit is journaled as `resume`; the schedule re-enters, then join and film QC, the report and `complete` follow as in `film`. The rulebook and rubrics must match the intake record's versions (`E-RESUME-RULEBOOK`, `E-RESUME-RUBRICS`): a pass runs under one law. A pass that completed refuses to resume (`E-RESUME-COMPLETE`); one that failed before its schedule, was killed before the plan landed, or holds no director sequence refuses too (`E-RESUME-FAILED`, `E-RESUME-NO-RUN`, `E-RESUME-NO-SEQUENCE`) — a new pass is the answer. A done assemble node whose value names no media file refuses too (`E-RESUME-ASSEMBLE-UNNAMED`): the expected slice is read from the node, never assumed. A refusal is journaled as `resume.refused` with its code.

## `judge <runId>`

Re-runs join QC and film QC over an assembled run under the rubric books now on disk, no renders, and regenerates the report. Journaled as `judge.start` and `judge` with both rubric versions; a run with no assembled slice refuses (`E-JUDGE-UNASSEMBLED`, journaled as `judge.refused`).

## `note <runId>`

Appends the creator's note to the latest iteration of the run's sequence in the critic's shape — `{ text, shotRef, timecode, ruleRef, severity, author: 'human', disposition: 'pending' }` — journals it as `note`, and saves the project. The note is the ground truth the judge is calibrated against; `kb fold` reads it. Refusals by name: empty `--text` (`E-NOTE-TEXT`), a severity outside `blocker|note|taste` (`E-NOTE-SEVERITY`), a negative or non-numeric `--timecode` (`E-NOTE-TIMECODE`), a `--shot` that is not a shot of the plan (`E-NOTE-SHOT`), a run with no sequence or no iteration record yet (`E-NOTE-NO-SEQUENCE`, `E-NOTE-NO-ITERATION`) — notes attach to a finished pass.

## `kb fold | query | rebuild`

`cli/kb.js` derives `knowledge/index.json` from every `runs/*/` directory that holds a journal. The index is derived and deletable; `folds.ndjson` beside it logs every fold. A fold runs under policy values and under the knowledge audit, both required by name: `foldKnowledge` and `rebuildKnowledge` take `policy` (`E-KB-POLICY` without it — the `propose` and `promote` columns are the policy's decisions, so an index without a policy would be an index that decided nothing) and `audit`, an `index => [[ruleId, gate]]` function that runs POL-009 and POL-010 over the folded index (`E-KB-AUDIT` without it, or when it returns no rule rows), plus a `reason` (`E-KB-REASON`). The audit runs before the index is written, and the fold row in `folds.ndjson` carries it: `{ at, reason, runs, findings, signatures, policyId, audit: { rules: [{ ruleId, pass, blockers }], blockers } }`. Inside a pass the same gates are also journaled as `policy.audit { scope: 'knowledge' }` with their blockers as `E-POLICY-<RULE>` findings; `bravo kb fold --policy` and `bravo kb rebuild --policy` have no pass journal, so the fold row is their record, they print it, and they exit 1 when the audit blocked. `--policy` is required for both (`E-ARGS-MISSING-POLICY`); `kb query` does not take it. It holds:

- `runs`: each run's id, idea, style, seconds, status, findings and notes counts;
- `counts`: findings by code, family, stage and severity;
- `recurrence`: one row per signature (a finding's `signature` column, or `family:stage:code:ruleOrRubric`), with its count, cost, the runs and distinct ideas it appears in, the corrections that answered it, and `propose` from `recurrenceDecision` against `policy.learn`;
- `waste`: wasted and refused units by kind and code;
- `calibration.joins`: measured dHash distances by declared join type; `calibration.overshoot`: measured minus planned seconds by planned duration; `calibration.judge`: per rubric, the judge's failing verdicts on shots the creator annotated, how many of those the creator also flagged (severity blocker or note), the resulting precision, and `promote` from `promotionDecision` against `policy.judge`.

`kb query <term>` matches codes, signatures, rule and rubric ids, shot ids and details across the index and the error rows; it needs a term (`E-KB-QUERY`) and a folded index (`E-KB-NO-INDEX`). `kb rebuild` deletes the index and folds again. A journal or ledger line that is not JSON stops the fold by file and line (`E-KB-UNREADABLE`). `film`, `resume` and `judge` fold automatically when they finish.

## `replay <runId> --dry`

Re-runs a pass with nothing leaving the process: every reasoning answer, image, video start and poll is replayed from the source journal's intent/result pairs in order; measurements come from the source's `measure` and `final` steps; the stitch from its `assemble` step; media from its `media/` files; candidates, scores and take verdicts from its `candidate`, `score` and `qc` steps; join and film QC record a replayed no-op. Rules come from `rules/` on disk and the prompt specs from `skills/`. The replay writes a complete journal of its own under `runs/<runId>-replay-<n>/`; a request the source journal cannot answer refuses by name (`E-REPLAY-EXHAUSTED`, `E-REPLAY-NO-ANSWER`), a source with no intake record or no `skills/` directory refuses (`E-REPLAY-NO-INTAKE`, `E-REPLAY-SKILLS`), and `--dry` is required (`E-REPLAY-DRY`).

## Decisions other builders should know

- The CLI's rulebook is loaded from `rules/` on disk with the policy book and handed to the director tools as `ctx.rulebook`, so the sequence pins the intake's `rulebookVersion` and `bravo resume` checks one version; the tools never fetch `/api/rules`.
- `manifestOf(seq, rulebook)` reads the tolerance from CIN-008 and the render parameters from the brief's format; it does not copy subject, force, change or keyframe from the plan, so the CLI enriches its manifest for approval and film QC. The executor hashes its own manifest under the same rulebook the pass carries.
- The executor's keyframe node passes `scoreCandidate` the shot's whole candidate pool as `siblings` (every attempt so far); the CLI's stage wrapper hands `generateCandidates`, `scoreCandidate`, `selectCandidate`, `takeQC` and `plateQC` through untouched and remembers no batch of its own.
- Candidate ids are `<shot>-a<attempt>-c<i>`, the attempt being the keyframe node's admission count, and media names derive from them, so a new-candidate regeneration of a shot writes fresh media beside the earlier attempt's instead of meeting the journal's refusal to overwrite.
- Plate QC is scheduled by the executor's plate node: `plateQC` is a pass stage beside the candidate and take stages, so `requireStages` refuses a pass without any of the seven (`E-STAGES`).
- The CLI hands `joinQC` the policy so the judge's blind control (`policy.judge.blindFraction`) covers joins; join findings stay witness notes regardless.
- `knowledge/` is derived output and belongs in `.gitignore` beside `runs/`.
