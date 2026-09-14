# BRAVO Extend — the product

One input, one film. A person types a story in one or two sentences and picks a length; the pass plans a chain of 20–30 second shots, renders the first from its plan and every next one as an extension of the previous take, judges every take by five rules, edits or regenerates what fails, stitches, and hands back a film with its report. Nobody is asked anything after the click.

## State of the project (2026-09-14)

Working, on the wire, up to the first take: intake, planning, reference stills registered as assets, the first take rendered and registered as a video asset. Everything after that (QC, judgment, editing, extension, stitch, report) is built and covered by stubbed tests but has not yet run end to end against the provider, because every live pass so far hit a dev server started before the routes it calls existed. The single most valuable action today is restarting that server and running one pass to the end.

Built and in use: the browser app (director, shot, bible threads), the CLI (`bravo film` with the edit loop, `bravo extend` with the chain), the `/extend` page, the journal (every prompt, answer, decision, render, cost), the five-rule QC, the policy file, provider-refusal rewriting, fault retries, `report.md`, `errors.ndjson`, the knowledge fold.

Parked: the staged engine (plates, keyframe candidates, chain-parallel schedule) behind `--mode staged`; the old rulebooks for the browser director; the asset-library stage (specified, not built); nine ledger-precision findings on the staged path. Debt: sixty-plus uncommitted files, and every edit since the no-session-runs rule is unverified until the creator runs the suites.

## The product surface

Exactly two ways in, one engine:

- the page `/extend`: story, seconds, one button; live progress from the journal; the film plays on the page
- the command `bravo extend --idea "…" [--seconds 120]`

Everything else in the repository is a workshop tool, not the product. The chat app stays for development; it is not the door.

## Principles

1. One code path. `agents/extend.js` is the engine; nothing else renders in the product. Any feature enters there or not at all.
2. No questions. Defaults are declared in one product config and journaled; a pass never waits.
3. The journal is the memory. Every pass writes what it decided and why; the knowledge fold reads all passes; the next plan prompt carries the lessons.
4. Fast beats perfect. A 120 second film should exist in under thirty minutes; quality is raised by the loop across passes, not by making one pass slower.
5. Restart-proof. The server that renders is a service with a version and a health check, never a hand-started dev process.

## Plan

### M1 — one film, reliably (this week)

- Run the server as a service: `next build` then `next start` under a process manager (or the packaged app with the server embedded). Add `/api/health` returning the build id and the routes the pass calls; the page and the CLI refuse to start a pass against a server whose health answer lacks a route (`E-STALE-SERVER`) instead of discovering it three renders later.
- Commit the tree.
- Run the suites once and fix what is red; then five real passes on five stories; read the five reports; file notes.
- Exit: five films on disk, each with a report whose guarantees are read, not guessed.

### M2 — the loop closes itself

- Continuity question: the QC hands the judge the previous take's last frame alongside the current take's frames, so "people and places hold" is judged against the footage it extends, not only a description.
- Lessons into the plan: the knowledge fold produces the top recurring findings across passes; the plan prompt receives them as doctrine lines with provenance. No human writes them.
- Speed caps in policy: one edit per shot before regenerating; a shot that fails twice ships its best — the film exists first, the next pass improves it.
- Exit: a pass whose plan prompt cites a lesson learned from an earlier pass, and a film whose report shows fewer findings than the previous film of the same story.

### M3 — many films, no one watching

- Batch: `bravo extend --ideas <file>` renders one film per line, sequentially; the page grows a gallery of runs with status, film and report.
- Product knobs only: length (60, 120, 180), three looks, audio on or off (audio needs the audio-capable judge slot).
- Optional post-pass notes (`bravo note`) remain the only human input, and only after a film exists.
- Exit: ten unattended films from a list, a gallery page, and the knowledge index answering which findings recur.

## What stays out

Plates, keyframe candidates, the chain-parallel schedule, the asset library, the browser director's rulebooks — all outside the product until a real film shows they are needed. The edit-loop engine (`bravo film`) stays as the workshop's second bench.
