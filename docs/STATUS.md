# Status

What works, what does not, and the decisions still open.

## Works, end to end against real models

| | Agent | Proven by |
|---|---|---|
| Video from a prompt | `shot` | a 10s Seedance 2.5 take, 720p |
| Edit a video | `edit` | a Seedance 2.5 editing task on an existing take |
| Storyboard | `storyboard` | a six-panel board |
| Reference plate | `bible` | a plate, filed and citable |
| Citation | `cite` on shot threads | plate attached as an ordered ref, rides the render request; prompt cites it by number |
| Refinement | `direct` + `attach` on bible threads | notes revise the plate prompt without forgetting earlier ones; the current plate rides as a reference so the likeness holds; reverting to an earlier render is free |

Each runs: route → compose under the bound spec → approval card showing the exact prompt →
approve → render inline.

Around them: the shell (rail, thread pane, composer), multi-project Films, the Skills
screen with provenance, per-thread budgets, live render tracking that survives a reload,
and a macOS package.

**The Director (in progress).** D1: versioned rulebooks (22 rules + 14 metrics), strict
loader, staged narrative-first gate engine, feasibility math. D2: the director agent
(brief → screenplay → breakdown under the rulebook), Sequence artifact, merge-guarded
append-only iterations, 7-case live suite. D3: the executor — one manifest card approves
the whole slice; re-entrant frontier walk with per-node persisted state; chained shoots
(recorded last frame → first_frame); decode-counted measurement (`/api/film/measure`)
with per-join dHash distances; retry pool vs deterministic halts; assembly + final
tolerance gate; ownership guards on sequence shots; live DirectorFlow panel; 5-scenario
dry-run suite on stubbed wire. D4 (partial): loud quota failure on save, note/correction
appends on iterations. D5: the critic agent — notes (ground truth) become traced input
patches, never-blocking rule proposals with provenance, and regression cases; its tool
row physically excludes law and renders; 6-case live suite. Remaining: proposal-approval
into the rulebook + the Rules screen ledger, then the live loop (D6). The first real
slice awaits one approved sequence card in the UI.

## Not built

- **Audio.** `speak` is unimplemented; the agent ships switched off.
- **Fork.** Sibling and next. Shot creation should move entirely to forking.
- **The fleet view.** Several agents working at once is supported by the harness, but
  there is no screen that shows the whole fleet.
- **Example shots.** Promoting takes into an evidence library agents can read.

Staleness fires now: re-rendering a plate marks every shot with a chosen take citing it.

## Open decisions

1. **Where the loop runs.** In the browser today: simplest, and the transport kit is built
   for it. A turn stops when the tab closes (renders survive — their task id is durable).
   Moving it server-side is what a real fleet needs.
2. **Where projects persist.** `localStorage`. Fine for now, a poor home for transcripts
   and takes worth keeping. The kit already has cloud project saves.
3. **The image spec.** `plate-pe` was written for BRAVO because the Seedream slots had
   nothing bound and an unbound slot refuses to compose. It is not a vendor document and
   says so. Replace it from the Skills screen when an official one exists.
4. **Packaging size.** `asar: false` costs a 598 MB bundle, because the skills library is
   resolved through `process.cwd()` and `process.chdir` cannot enter an asar archive.
   Shipping `skills/` via `extraResources` would let asar back on.
The rulebook now has its approval surface. A Rules screen (rail, next to Skills) lists both books with class badges, blocking and calibrating states, and a per-rule ledger folded from iteration records — violations, passes, and notes naming each rule. Proposals the critic files land in a proposal inbox on that screen; approving one calls `/api/rule-approve`, which appends the rule to its book with provenance, never blocking on arrival: judgment rules enter active, plan and measure rules enter calibrating until a check exists and the numbers are in. The route refuses blocking-on-arrival, duplicate ids, and missing provenance. Learned regressions have a home too: `tests/agents/director/learned.json` folds into the live director suite at load, and a case without a runnable structural expectation refuses to load.

A new pillar landed by decree: retrieval-grounded direction. Building a slice agentically means every agent decision consults a database of proven film craft. docs/CORPUS.md now defines that corpus end to end — four provenance classes (canon, measured-canon, house, doctrine), ten collections with schemas, a decision-point map from every pipeline stage to its query, and a verified acquisition catalog: fifty-plus sources checked by live research (ShotBench, AVE, Netflix MatchCut, TRIPOD, MovieSum, Blender Open Movies, Cutting's Cornell statistics, archive.org public-domain footage for in-house calibration, Seedance prompt exemplars, and more), tiered by access friction with license reality noted per item. Retrieval mechanics recommended and verified: sqlite-vec over better-sqlite3 with exact-match enum columns for the fixed vocabularies, Ark doubao-embedding for the fuzzy part. The laws hold the line: retrieval is advisory, gates remain the only law, empty retrieval is stated, every record carries provenance, decisions cite their precedents so the critic can dispute bad evidence. Next: the person sources the tier-1 seed set; the studio builds the ingest and the consult step.
