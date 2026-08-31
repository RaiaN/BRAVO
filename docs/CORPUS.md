# The Reference Corpus

Building a film slice agentically means every decision the director makes is grounded in what already provably works. The rulebook says what must never go wrong; the corpus says what good looks like. Whenever an agent decides — how a premise beats out at N seconds, which setup covers a turn, how a movement is phrased for the render model, what distance a real cut sits at — it retrieves precedent from a database of proven film craft and cites it. The director assembles from evidence, not from vibes.

This document defines what that data is, where each piece verifiably exists as of August 2026, and how retrieval plugs into the pipeline. It is the acquisition brief: find these, store them, and the corpus becomes queryable law-adjacent memory.

## Provenance classes

Every corpus record belongs to one of four classes, and carries its provenance the way rules do:

- **canon** — found film knowledge: annotated shots from real films, beat sheets, screenplay structure, cut grammar. Found once, curated, versioned.
- **measured-canon** — statistics BRAVO computes by running its own measure tools over legally usable real footage. Reproducible: every number carries the clip list and tool version that produced it.
- **house** — BRAVO's own record: every take with its prompt, plan intent, measured result, and human verdict. The only model-specific signal in existence; grows every iteration; costs nothing to collect.
- **doctrine** — the rulebook plus per-rule exemplars: for each rule id, corpus records that demonstrate compliance and violation.

## The collections

### `shots` — annotated shots from real films (canon)
```json
{ "id": "", "source": { "film": "", "year": 0, "dataset": "" },
  "setup": "", "scale": "", "movement": "", "angle": "", "duration_s": 0,
  "position": "opening|build|turn|close", "function": "establish|reveal|reaction|insert|master|close",
  "subjects": [], "num_people": 0, "location_type": "int|ext", "tone": [],
  "precededBy": null, "followedBy": null, "notes": "" }
```
`setup`, `scale`, `movement`, `function` are exact-match enum columns aligned to the breakdown's camera vocabulary — never free text.

### `cuts` — join grammar between shots (canon / measured-canon)
```json
{ "id": "", "from": { "setup": "", "motion": "" }, "to": { "setup": "", "motion": "" },
  "cut_type": "on-action|match|reaction|speaker-change|hard|L-cut|smash",
  "measured": { "joinDistance": null }, "quality": "match|no-match", "why": "" }
```

### `beats` — story structure with timings (canon)
```json
{ "id": "", "film": "", "total_s": 0, "genre": [], "cast_size": 0,
  "beats": [ { "function": "setup|complication|turn|payoff", "start_s": 0, "end_s": 0, "summary": "" } ] }
```
Feature-film beat positions are proportional; normalize to the slice's N seconds.

### `screenplays` — scene-level structure exemplars (canon)
```json
{ "id": "", "source": "", "scene": { "slugline": "", "action_lines": 0, "dialogue_wps": 0,
  "turns": true, "salient": true }, "excerpt_rights": "private-index-only|redistributable" }
```
Most screenplay text is copyrighted: annotations are open, text is a private retrieval index only — never redistributed, never shipped.

### `prompts` — the house prompt library (house)
```json
{ "id": "", "modelKey": "", "modelVersion": "", "prompt": "",
  "intent": { "setup": "", "movement": "", "subjects": [], "seconds": 0 }, "refs": [],
  "measured": { "duration": 0, "fps": 0, "silent": false, "joinDistances": [] },
  "verdict": { "noteIds": [], "disposition": "" }, "takeUrl": "" }
```
Built automatically from iteration records. This is the compounding asset: what THIS model provably does with THIS phrasing, judged by the person whose taste is ground truth.

### `calibration` — measured distributions (measured-canon)
```json
{ "id": "", "metric": "M-CHAIN|dead-air|motion|dialogue-wps|ASL",
  "population": "real-cuts|within-shot|short-form|by-genre",
  "quantiles": {}, "histogram": [], "provenance": { "clips": [], "toolVersion": "" } }
```
These numbers replace guessed thresholds: θ for join continuity comes from the measured distribution of perceptual-hash distance across real cuts versus within a shot, not from a hunch.

### `looks` — color, lighting, and palette conventions (canon)
```json
{ "id": "", "context": { "genre": [], "time_of_day": "", "int_ext": "", "mood": [] },
  "palette": [], "lighting": "", "lens": "", "source": "", "notes": "" }
```
Adopt the taxonomy professional still-reference tools use (shot size, lighting style, time of day, color tags, lens) as enum columns; records are curated notes, not scraped frames.

### `sounds` — the audio layer's vocabulary (canon)
```json
{ "id": "", "setting": "", "description": "", "duration_s": 0, "category": "", "source": "" }
```
Captions and durations as a retrieval reference for the prompt's audio clause. Respect source terms: some archives explicitly exclude AI training — captions consulted, audio never ingested.

### `notes` / `corrections` — ground truth and its consequences (house)
Already recorded append-only in iteration records; indexed for retrieval so the critic can ask "has this mistake been seen before, and what fixed it."

### `rule_exemplars` — the rulebook's evidence (doctrine)
```json
{ "ruleId": "", "polarity": "complies|violates", "recordRef": { "collection": "", "id": "" }, "commentary": "" }
```

## Where each decision retrieves

| Stage | The decision | Query (structured filters first) | Collections |
|---|---|---|---|
| Brief | Is this premise workable at N seconds? What dramatic shape fits? | N, genre, cast size | `beats`, `notes` |
| Screenplay | Beat count, where the scene turns, how much dialogue fits | N, beat count, genre; dialogue seconds available | `beats`, `screenplays`, `calibration` |
| Breakdown | Which setups cover this beat, in what order, at what length | function, position, duration window, tone | `shots`, `cuts`, `rule_exemplars` |
| Compose | How to phrase setup/movement/subject for the render model | setup, movement, subject class, model version | `prompts`, vendor exemplars, `looks`, `sounds` |
| Plates | What anchors identity and look across shots | entity role, mood, palette | `looks`, house plates |
| Measure | What join distance is a cut vs a break; what is dead air | metric id, population | `calibration` |
| Critic | Has this been seen before; patch, rule, or dispute | note text, rule ref, shot context | `notes`, `corrections`, `rule_exemplars` |

## The acquisition catalog

Everything below was verified to exist by direct web research (August 2026). Items marked ◐ were confirmed to exist but their download artifact or license text could not be fully inspected — check before depending on them.

### Tier 1 — the seed set (direct download, permissive or research-clean, start here)

| Source | What it feeds | Access | License |
|---|---|---|---|
| **ShotBench / ShotQA** (Vchitect) — 3,572 expert QA over 200+ acclaimed films; 8 cinematography dimensions incl. 7-level shot scale; ~70K QA training set; ShotVL judge model | `shots` vocabulary; an automatic shot-attribute judge for measure/critic | huggingface.co/datasets/Vchitect/ShotBench (3.34 GB, direct) | Apache-2.0 (card verified; underlying frames from copyrighted films — internal use) |
| **AVE — Anatomy of Video Editing** — 196K shots / 5,591 scenes, >1.5M tags: size, angle, type, motion, subject, int/ext, num-people, sound-source, timestamps, setup grouping | `shots` (richest attribute set), `cuts`, duration stats per function | github.com/dawitmureja/AVE (annotations via Drive link; videos re-fetched from MovieClips YouTube with yt-dlp) | research use; annotations directly usable without video |
| **Netflix MatchCut** — 19.3K shot pairs labeled for match-cut suitability, shot timings, embeddings, from 100 films | `cuts` quality grammar; join-continuity threshold calibration | github.com/Netflix/matchcut (labels in-repo; 3 GB embeddings tar) | Apache-2.0 (verified) |
| **TRIPOD** — 122 films, five screenwriting turning points annotated in synopses + screenplays; multimodal video-aligned version | `beats` structure ground truth | github.com/ppapalampidi/TRIPOD; video version: hdl.handle.net/10283/3820 | research; screenplay text private-index-only |
| **MovieSum** — 2,200 formatted screenplays with sluglines/action/dialogue markup + summaries | `screenplays` retrieval index | huggingface.co/datasets/rohitsaxena/MovieSum | research; text private-index-only |
| **Save the Cat beat sheets** — hundreds of 15-beat film breakdowns with minute positions + a beat mapper by runtime | `beats` duration calibration; dramatic-function vocabulary | savethecat.com/beat-sheets + beatsheetdatabase.wordpress.com (scrape-and-structure; no packaged dataset exists) | editorial content — learn statistics, do not republish text |
| **Blender Open Movies** — ~15 professional narrative CG shorts with production assets and storyboards | the gold seed: hand-annotate beats+timings, full shot lists, cut grammar end-to-end on redistributable shorts at exactly slice scale | studio.blender.org/films (direct) | CC-BY (verified) |
| **James Cutting's Cornell film statistics** — shot-by-shot durations for 220 films 1915–2015, per-shot motion/luminance/clutter, shot scale for 24 films | `calibration` anchors (published ASL, duration distributions, motion norms) | people.psych.cornell.edu/~jec7/data.htm ◐ (server flaky — Wayback copies work) | posted for research |
| **CMU Movie Summary Corpus** — 42K plot summaries + genre/runtime/character metadata | `beats`/brief priors (protagonist, genre, runtime) | cs.cmu.edu/~ark/personas (46 MB, direct) | CC BY-SA (verified) |
| **Seedance prompt exemplars** — official BytePlus ModelArk prompt guide ◐ (JS-rendered; scrape headless), fal.ai Seedance 2.0 guide (7 worked prompts; camera lexicon: dolly, pan, tilt, crane, push-in, rack focus, locked-off), MIT-licensed community repo of 30+ structured Seedance prompts | `prompts` vendor exemplars for compose | docs.byteplus.com/en/docs/ModelArk/1631633; fal.ai/learn/tools/seedance-2-0-prompting-guide; github.com/Anil-matcha/awesome-seedance-2.5-api-prompts | docs copyright / MIT (repo) |
| **The house extractor** — every BRAVO take → `prompts` record with intent, measurement, verdict | `prompts` house library | built from iteration records, automatic | ours |

### Tier 2 — gated or heavier, high value

| Source | What it feeds | Access | License |
|---|---|---|---|
| **MovieShots** — 46,857 trailer shots labeled 5-scale × 4-movement | `shots` scale/movement priors | movienet.github.io/projects/eccv20shot.html (Drive/OpenDataLab, registration) | research (MovieNet terms) |
| **MovieCuts** — 174K clips labeled with 10 professional cut types | `cuts` type grammar | github.com/PardoAlejo/MovieCuts (request form + emailed link) ◐ form turnaround unverified | research |
| **Condensed Movies** — 33K captioned key scenes, 400K face-tracks, 3K films | scene-level story descriptions over real footage | Oxford VGG page (email-gated, ~117 GB) | CC BY 4.0 annotations |
| **CameraBench** — ~3K videos, cinematographer-designed camera-motion taxonomy + captions | compose movement vocabulary; motion evaluation | github.com/sy77777en/CameraBench (test set open; train gated) ◐ license file unread | research |
| **CineTechBench** — 600+ stills, 120+ clips, 7 dimensions incl. lighting/color/focal length, with per-technique scores of what T2V models can execute | `looks` + a capability prior for compose (which camera terms the model can actually perform) | github.com/PRIS-CV/CineTechBench + HF (metadata + links only) | CC BY-NC-ND (annotations) |
| **Public-domain footage + our measure pipeline** — archive.org feature_films (28,483 items), short_films (3,140), Prelinger (10,468, ~65% PD); segment with TransNetV2 (MIT) ∩ PySceneDetect (BSD-3), keep agreed cuts, compute per-join perceptual-hash distance, dead-air, motion | `calibration` — the θ for join continuity, dead-air fractions, motion norms, measured on real film with our own tools | `pip install internetarchive; ia download` + pip scenedetect + transnetv2 | IA terms; PD is per-item — verify each title's Usage field |
| **OpenSubtitles/OPUS** — subtitle cues with start/end timestamps at massive scale | `calibration` dialogue words-per-second (computed by us; no ready-made WPS dataset exists) | opus.nlpl.eu (2018, direct) / HF OpenSubtitles2024 | CC BY-NC-SA 3.0 (2018) / ODC-BY (2024) |
| **OpenS2V-5M** — 5.4M subject-image→video triples + NexusScore consistency judge | plate→shot consistency exemplars; automatic cast-consistency scoring (M-CAST) | huggingface.co/datasets/BestWishYsh/OpenS2V-5M ◐ card license unread; sample a curated slice | research release |
| **VideoGen-RewardBench** — 25,234 human-rated prompt/video pairs (visual, motion, alignment, overall) with videos | which prompt phrasings win on quality; calibrating an automatic judge | huggingface.co/datasets/KwaiVGI/VideoGen-RewardBench (13.4 GB) | Apache-2.0 (card verified) |

### Tier 3 — consult-only references (not ingestable datasets)

- **ShotDeck** (1M+ hand-tagged stills; the tool working DPs consult; $12.95/mo) and free **shot.cafe** — not downloadable; the durable takeaway is the **tag taxonomy** (shot size, lighting style, time of day, color tags, lens, mood) adopted as `looks` enum columns, plus manually curated palette notes.
- **BBC Sound Effects Archive** — 33K captioned, duration-stamped effects. RemArc licence excludes AI training/data mining: consult captions and durations as `sounds` references; never ingest the audio. Freesound (per-item CC0/CC-BY) is the permissive substitute.
- **Cinemetrics** (cinemetrics.uchicago.edu, migrated from the dead .lv domain) and **Barry Salt's database** ◐ — ASL and shot-scale distributions by era/genre; site is live but bulk export unconfirmed post-migration.
- **MAD** — 384K audio-description sentences with timestamps over 1,200h of film; NDA-gated, features-only. Action-line pacing at scale if ever needed.
- Cross-model prompt guides with transferable camera vocabulary: Sora 2 cookbook (MIT), Google's Veo 3.1 guide (the 2–3 camera modifiers per shot rule), Runway Gen-3/4 guides (positive-phrasing doctrine), Kling's formula guide (fetched and confirmed; includes failure modes: precise object counts, complex physics).

### Known gaps after this pass
Music/score conventions mapped to dramatic function (no verified corpus exists); genre-convention/trope structure data (candidates exist, unverified); spoken-dialogue syllable-rate corpora (only needed if dialogue sync becomes a real failure mode).

## Retrieval mechanics

The corpus is small and curated (tens of thousands of records, not millions). The honest architecture, verified current as of August 2026:

- **Store**: one SQLite file via `better-sqlite3` + `sqlite-vec` (MIT/Apache-2.0, npm 0.1.9). Structured filters are first-class: the vec0 table's metadata columns hold the enums (`setup`, `function`, `duration_s`, `stage`), so `WHERE setup = ? AND duration_s BETWEEN ? AND ?` prunes before any distance math, then exact KNN over survivors — no approximate index, perfect recall, single committed `.db` file in the repo. At the seed scale (≤ ~20K records) plain JSON + brute-force cosine is also honest; `sqlite-vec` removes the ceiling for one dependency.
- **Embeddings**: the Ark platform BRAVO already talks to exposes an OpenAI-shaped embeddings endpoint (`doubao-embedding` family, POST `{base}/api/v3/embeddings`). Embed the corpus once at ingest, cache vectors, embed only the query at plan time. Verify the app's key region exposes the chosen model before committing to a dimension. Offline/test fallback: `@huggingface/transformers` v3 local ONNX models — but never mix embedding models in one index.
- **The design decision that matters most**: BRAVO's fixed vocabularies — camera setup, dramatic function, scale, side — are exact-match enum columns, never embedded text. Embeddings cover only the fuzzy part: action, mood, intent.
- **Upgrade path**: `@lancedb/lancedb` (Apache-2.0, active) if the corpus outgrows SQLite or needs multimodal plate retrieval; FTS5 + reciprocal-rank fusion if exact terminology search earns its place.

## Laws

1. **Retrieval is advisory.** A precedent can shape a plan; it can never pass a gate, relax a threshold, or excuse a violation. Gates remain the only law.
2. **Empty retrieval is a stated condition.** When the corpus has nothing for a query, the agent proceeds on the rulebook alone and says so.
3. **No record without provenance.** Source, license, extraction method — a record that cannot say where it came from does not enter.
4. **Decisions cite their precedents.** Which records informed which choice is part of the iteration record. When a precedent-informed decision draws a note, the critic can dispute the precedent — flagged `disputed`, never silently dropped. Bad data is findable exactly like bad rules.
5. **License hygiene is structural.** Copyright-derived text and frames live in a private retrieval index only; public-domain status on archive.org is verified per item; sources that exclude AI training contribute captions, never media. `excerpt_rights` is a field, not a footnote.
6. **House records are append-only**, like iterations.

## How it feeds the loop

Retrieval citations enter the iteration record, so observation covers not just what was decided but what evidence backed it. Notes flow to the critic as before — with one new disposition available: dispute the precedent. Calibration tables turn `calibrating` rules into `active` ones with numbers derived from real film rather than guesses — the measured distribution of join distances across real cuts is what finally sets θ. And the house `prompts` collection compounds: every approved take, every note, every silent-audio retake becomes retrievable precedent for the next plan. The corpus and the rulebook grow the same way — by named evidence, never by silent default.
