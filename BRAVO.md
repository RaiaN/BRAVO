# BRAVO — implementation spec

An AI film studio with a Claude-style interface: a left rail of **threads**, a
conversation in the main pane, and **one agent per thread** doing the work.

New repository. Nothing is ported except the transport kit (§10). Build in the order in §11.

---

## 1 · What it is

A film is an **ordered list of shots**. Each shot has a thread. A thread has an agent. You
talk to the agent; it composes prompts, renders stills and takes, and reports. Agents run
independently, so several shots progress at once while you attend to one.

There is **no canvas**. Nothing is dragged, positioned or connected. The rail is the film,
in order.

---

## 2 · The interface

Replicate the Claude web layout.

```
┌──────────────────────┬─────────────────────────────────────────────┐
│  BRAVO               │                                             │
│  ─────────────       │   03 · the collision                        │
│  ⌘  Films            │   ─────────────────────────────────────     │
│  ⚙  Skills           │                                             │
│  ▾  More             │   [agent] I read shots 1-2 for continuity.  │
│                      │   The wolf lands on the log. Compose?       │
│  THE WOLF            │                                             │
│  ⌗  01 the ridge  ✓  │   [you] make it uglier, less balletic       │
│  ⌗  02 dog breaks ⟳  │                                             │
│  ⌗  03 collision  ●  │   [agent] ⟳ composing under sd25-pe…        │
│     └ 03b harder     │                                             │
│  ⌗  04 —          ○  │   ┌── prompt ready · 1,240 chars ────────┐  │
│  ─────────────       │   │  @Image1 maps to the wolf…            │  │
│  BIBLE               │   │  [ approve · 1 take ~3 min ]  [ edit ]│  │
│  ◆  the wolf      ⚠  │   └───────────────────────────────────────┘  │
│  ◆  the clearing  ✓  │                                             │
│                      │   ───────────────────────────────────────   │
│  + new thread        │   [ message the agent…               ] ⏎    │
└──────────────────────┴─────────────────────────────────────────────┘
```

**Rail.** Project name at top, then global links (Films, Skills). Two sections: **the film**
(shots in order, forks indented under their parent) and **the bible** (entries, unordered).
`+ new thread` at the bottom.

The rail is also a **fleet monitor**. Every row shows the state of its agent:

| Glyph | State |
|---|---|
| `○` | empty — no prompt yet |
| `⟳` | working — composing or rendering, with an ETA |
| `●` | needs you — a decision, an approval, or a choice between takes |
| `✓` | settled — a chosen take, current with its inputs |
| `⚠` | stale — an input changed after the chosen take was rendered |

**Main pane.** The thread's transcript: messages, tool results and approval cards in order,
newest at the bottom, composer pinned below. No tabs inside the pane, no inspector panels,
no floating windows.

**Tool results render inline and visual** — a still grid, a take player, a ref chip row, a
prompt in a fenced block with an approve button. Never a wall of text where a picture is
the answer.

**Selection is implicit.** The open thread is the subject of everything you type. There is
never a "select something first".

---

## 3 · Data model

Persist as JSON per project. One canonical film; threads reference it.

```
Project
  id, title, createdAt, updatedAt
  film:    Film
  bible:   [ BibleEntry ]
  threads: [ Thread ]
  look:    { style, grade, notes }    # standing facts every agent reads

Film
  shots: [ Shot ]                     # ORDER IS THE FILM

Shot
  id            # stable; never the index
  n             # derived 1-based position — what the user says out loud
  parentId      # set when forked from another shot; else null
  title         # "the collision"
  prompt        # THE FINAL PROMPT — verbatim, exactly what the model receives
  model         # slot key: seedance25 | seedance | seedanceFast | seedanceMini
  refs: [ Ref ] # ORDERED; position IS the citation number
  keyframes: [ refId ]   # ordered; empty when the model has no keyframe control
  duration      # seconds | 'auto'
  resolution, ratio, seed, generateAudio
  takes: [ Take ]
  chosenTakeId
  stale         # an input moved after the chosen take was rendered

Ref
  id, kind: 'image' | 'audio' | 'video'
  url, assetId  # assetId = portrait-library id, preferred on the wire
  label, role: 'character' | 'location' | 'prop' | 'frame'
  bibleEntryId  # set when it came from the bible

Take
  id, url, posterUrl, createdAt, ms
  promptUsed    # what was ACTUALLY sent — recorded, never reconstructed
  model, seed, resolution, ratio, duration

BibleEntry
  id, name, role, plateUrl, assetId, notes
  citedBy: [ shotId ]   # derived; drives staleness

Thread
  id, kind: 'shot' | 'bible' | 'audio' | 'edit'
  subjectId             # shotId or bibleEntryId — a thread owns exactly ONE
  title
  messages: [ Message ]
  status: 'idle' | 'working' | 'needs-you' | 'settled'
  budget: { takesCap, spentTakes }

Message
  id, at, role: 'user' | 'agent' | 'tool'
  text                  # user / agent
  tool                  # tool: { name, input, output, approved, cost }
```

Three invariants:

1. **`prompt` is the final prompt.** Nothing wraps, compiles or appends at send time. What
   the thread shows is what the model receives.
2. **`refs` order is the citation numbering.** The Nth ref is image N. Reordering is a data
   operation; prompt text is never rewritten to compensate.
3. **`promptUsed` is recorded at send time.** A take must explain itself later, even after
   its shot has moved on.

---

## 4 · Threads and agents

A thread owns **exactly one** artifact, so two threads can never contend for the same
subject. Each thread has its own agent: its own system prompt, tool set and skills.

| Kind | The agent's job | Skill it loads | Tools |
|---|---|---|---|
| `shot` | make this shot good | the spec bound to `shot.model` | `read` `write` `order` `compose` `direct` `still` `shoot` `edit` `extend` `choose` |
| `bible` | make this plate right, keep it consistent | the image spec | `read` `write` `still` `imagine` `tag` |
| `audio` | voice, score, sound design | the audio spec | `read` `write` `speak` `attach` |
| `edit` | operate on an existing take | the video spec | `read` `shoot` `edit` `extend` `trim` |

**Agents run independently.** Told *"make this shot good"*, an agent composes, renders,
looks, revises — while you work in another thread. It stops when it has something to show,
when it needs a decision, or when it hits its budget. It never picks between finished takes
on its own; judging a take is the user's.

**Thread memory.** The agent reads the transcript up to a cap, then a rolling summary of
decisions beneath that; plus its subject, `look`, and — for a `shot` thread — the
neighbouring shots' titles and end states.

---

## 5 · Fork

**Forking is the only way a shot is created.** There is no "add shot" button.

- **Fork as sibling** — `03` → `03b`. Same moment, different approach; inherits the whole
  transcript and the shot's refs. Siblings are alternatives: exactly one can be chosen into
  the cut, the rest stay as thinking. Rendered indented under the parent.
- **Fork as next** — `03` → `04`. The following moment; inherits `look`, the cast and place
  refs, and the parent's end state. Not the transcript, unless asked.

Both insert into `film.shots` — sibling beside, next after — and record `parentId`.

---

## 6 · Tools

Uniform contract: `{ name, input }` → `{ output, cost }`. Every result is a `Message` with
`role: 'tool'`, rendered inline.

**Free** — run without asking:

| Tool | Input | Output |
|---|---|---|
| `read` | film \| shot n \| bible entry \| takes | the object, rendered |
| `write` | shot fields to set | the updated shot |
| `order` | move \| insert \| remove | the new order |
| `choose` | takeId | the shot with `chosenTakeId` set |
| `tag` | url, role, name | a new BibleEntry |

**Metered** — one reasoner call, no approval:

| Tool | Does |
|---|---|
| `compose` | write the shot's whole final prompt under its bound skill |
| `direct` | apply a note to the existing prompt, preserving its structure |

**Gated** — real money, approved first:

| Tool | Cost |
|---|---|
| `still` | one Seedream image |
| `shoot` | one Seedance take — minutes |
| `edit` | a Seedance editing task on an existing take |
| `extend` | continue past the end of a take |
| `speak` | one audio render |

### The approval card

A gated call renders a card showing **the exact prompt and the exact ordered references**
before spending, with `approve` / `edit` / `cancel`. Nothing is sent from an unapproved card.

### Budget

Each thread has `takesCap`. An agent that reaches it stops and reports; it does not ask to
continue in a loop. Project-level spend is visible from the rail.

---

## 7 · Skills

A skill is a vendor prompt spec at `.agents/skills/<id>/SKILL.md`, bound to model slots via
frontmatter `models:`, sent **verbatim** in the system prompt of every call that model makes.

- `sd25-pe` → `seedance25`
- `sd20-pe` → `seedance`, `seedanceFast`, `seedanceMini`

`requireSkillLine(modelKey)` throws when a slot is unbound. **There is no fallback and no
house style** — a slot without a spec refuses to compose. Every skill bound to a slot rides,
in library order.

A **Skills** screen lists them: token weight, model binding, full-text editor, reset to
disk, add-your-own. Dropping a folder into `.agents/skills/` makes it appear.

### Example shots

A second library built from takes: the take, its `promptUsed`, and why it worked. Agents may
read it. Skills are the vendor's theory; example shots are the evidence.

---

## 8 · Build rules

Non-negotiable.

- **The video model is a WORLD MODEL.** Specify the world, pose the situation, never
  choreograph the outcome. Name a state ("the wolf is cornered and means it"), never a
  feature ("guard hairs lift") — a feature instruction renders literally.
- **The prompt is the prompt.** No compiler, no wrapper, no assembly at send time.
- **The spec outranks us.** A bound skill replaces house guidance wholesale.
- **Never substitute a default.** An unknown id resolves to nothing. Unbound means refused.
- **Consistency is attachment, not description.** Plates ride in the request; the prompt
  cites them and does not re-describe them.
- **Every LLM promise needs a code gate** — a deterministic check, a retry, a visible
  report. Minimum: citation numbers within range, dialogue lines preserved.
- **Capabilities are traits, never model-name comparisons.** `keyframes`, `refPrefix`,
  `maxSeconds`, `refCap` live in one table.
- **Duration, ratio and resolution are parameters, never prompt text.**
- **Show the full prompt before spending.**

---

## 9 · Stack and layout

Next.js (pages router), React, one component library. No graph library, no canvas library.

```
pages/
  index.js                    # the shell: rail + thread pane
  api/…                       # from the transport kit, unchanged
components/
  Rail.js                     # film list, bible list, states, new thread
  Thread.js                   # transcript + composer
  messages/                   # UserMessage, AgentMessage, ToolResult, ApprovalCard
  results/                    # StillGrid, TakePlayer, RefChips, PromptBlock, FilmStrip
  SkillsScreen.js
agents/
  loop.js                     # the turn: plan → tools → report
  shot.js  bible.js  audio.js  edit.js
  tools/                      # one file per tool, uniform contract
state/
  project.js                  # the model in §3 — load, save, migrate
utils/film/…                  # from the transport kit, unchanged
.agents/skills/…              # from the transport kit
```

---

## 10 · The transport kit

`BRAVO-api-kit.zip` is the model layer, lifted whole. Unzip into the new repo before writing
anything else. It contains **no UI, no agents and no film logic**.

- `pages/api/*` — reasoner, image, video start/poll, audio, media, stitch, skills
- `utils/film/core/client.js` — the single transport: `reason` · `generateImage` ·
  `startVideo` · `pollVideo` · `generateSpeech`
- `utils/film/core/operations.js` — `animate`, the video call with refs and first frame
- `utils/film/suiteConfig.js` — model slots and capability traits
- `utils/film/skills.js` — the skills library and `requireSkillLine`
- `utils/film/promptTemplates.js` — machinery only, empty catalogue
- `.agents/skills/sd25-pe`, `.agents/skills/sd20-pe`

Its README documents the wire contracts that are easy to get wrong: video is async; editing
tasks lock ratio and duration; `duration: 'auto'` omits the field; photoreal people must ride
as a registered `image_asset_id`, never a raw url.

Setup: copy `.env.example` → `.env.local`, fill the model ids, run with `NODE_USE_SYSTEM_CA=1`.

---

## 11 · Milestones

**M1 · Shell.** Rail + thread pane + composer in the Claude layout. One project, one thread,
no agent. Messages persist.

**M2 · Project state.** The model in §3, loaded and saved. The rail renders the film from
`film.shots`. Manual shot creation for now.

**M3 · The loop, free tools only.** A shot agent with `read`, `write`, `order`, `choose`. No
spending. Proves the conversation is a workable way to edit a film.

**M4 · Compose.** `compose` and `direct` wired to skills. The agent writes prompts under the
bound spec. Still no rendering.

**M5 · Gated tools.** `still` and `shoot` behind approval cards, with budget. First takes.
The rail shows `⟳` and `●`.

**M6 · Threads.** Many threads, per-thread agents, independent runs, the fleet view.

**M7 · Fork.** Sibling and next. Shot creation moves entirely to forking.

**M8 · Bible threads.** Plates, citation, staleness propagation into shots.

**M9 · Edit and extend.** Seedance editing tasks and extension as tools.

**M10 · Example shots.** Promote takes into the evidence library; agents read it.

M1–M3 carry the design risk. If a turn-based loop is not a pleasant way to build a film,
that shows there — before any money is spent.
