# BRAVO — where we are, and what is next

Companion to [BRAVO.md](BRAVO.md). That file is the spec and does not change; this one
tracks what is actually built and what the next milestone costs.

---

## Where we are

**M1 · Shell — done.** Rail + thread pane + composer in the §2 layout. One project, one
thread, no agent, messages that persist.

| | |
|---|---|
| [state/project.js](../state/project.js) | The §3 model, field for field. Load, save, migrate. |
| [components/Rail.js](../components/Rail.js) | Project name, global links, the film, the bible, `+ new thread`. Fleet glyphs per row. |
| [components/Thread.js](../components/Thread.js) | Transcript newest-at-bottom, composer pinned below. |
| [components/messages/](../components/messages/) | `UserMessage`, `AgentMessage`. |
| [styles/globals.css](../styles/globals.css) | Claude palette, macOS chrome, light/dark. |
| [electron/](../electron/) | The packaged macOS app — see [DESKTOP.md](DESKTOP.md). |

Verified: rename propagates to rail + heading + placeholder; Enter sends and Shift+Enter
does not; multi-line composing and auto-grow; line breaks preserved; **messages survive a
full reload**; transcript re-pins on resize; light/dark/auto; reset with confirm;
`next build` compiles all 21 routes; the packaged `.app` serves its own Next server and
resolves both SKILL.md specs.

The transport kit is byte-identical to the zip (`utils/`, `pages/api/`, `.agents/`).

**Also done, outside the milestone list:** the app packages as a macOS `.dmg` (Electron
boots Next in-process — a static export would 404 every `pages/api/*` route).

### Two bugs the work surfaced, both fixed

- **A hidden tab rendered the whole transcript blank.** The entry animation used
  `animation-fill-mode: both`, and a background tab freezes animations at `currentTime:
  0` — pinning every message to `opacity: 0`. Restored turns now do not animate at all,
  and the animation is never what makes content visible.
- **The composer rendered eight lines tall in the packaged build.** `fit()` measured
  `scrollHeight` before the first frame settled and clamped to the maximum. Intermittent —
  dev won the race, the package lost it. An empty composer is no longer measured; CSS owns
  the resting height.

### Known, deliberate gaps

`components/results/` and `agents/` are empty — they belong to M3+. Films, Skills and
`+ new thread` are drawn in the rail but inert, each tagged with its milestone.
`ffmpeg-static` is uninstalled: the kit imports it lazily and no §6 tool stitches.

---

## The target: agentic v1

Open the app and, by talking in a thread, be able to:

1. **Make a video from a prompt**, with the bound skill leveraged
2. **Edit that video from an instruction**, with the skill leveraged
3. **Generate a storyboard**
4. **Generate a bible**

("A tab" reads as the app plus a thread — §2 rules out tabs *inside* the pane. The four
jobs are thread KINDS, which is what §4 already calls them.)

### Decided: threads are unisex until the conversation picks an agent

This is a **change to §3 and §4**, not an implementation detail, so it is written down
plainly:

> A thread is born with **no kind**. It is a blank conversation. On the first message a
> router reads what you said and selects the agent — shot, edit, storyboard, bible, audio.
> From that moment the kind is **latched** and the thread owns exactly one artifact, as §4
> requires. Latching is what keeps §4's invariant intact: unisex only until first use,
> never after.

Consequences, all good:

- `+ new thread` becomes real at v1 instead of waiting for M6.
- **Storyboard drops out of M7.** Its artifact is a storyboard *image*, not N forked
  shots, so v1 needs no fork machinery at all. M7 stays where the spec put it.
- The router is an LLM promise, so §8 demands a gate: its answer is validated against the
  known kind list, and an unrecognised answer asks rather than guessing. **Never a default
  kind** — §8's "an unknown id resolves to nothing" applies to routing too.

### Decided: the rest

- **Edit** is a video-editing agent on **Seedance 2.5**, so it loads `sd25-pe`. Wire
  contract: an editing task **locks ratio and duration — do not send them**, or it fails
  `InvalidParameter.TaskTypeConstraint`. Resolution *is* honoured. `client.startVideo`
  already omits both when falsy, so pass them falsy.
- **The loop runs in the browser**, through the kit's `createBrowserClient`. `pages/api`
  stays untouched (§10). Accepted cost: a reload kills an in-flight run, and M6's
  many-at-once is bounded by one tab. Revisit at M6, not before.

Skill binding verified end to end: `sd20-pe` declares
`models: [seedance, seedanceFast, seedanceMini]` in its own frontmatter, and `sd25-pe`
carries none — `DEFAULT_BINDING` in `utils/film/skills.js` supplies `seedance25`. So
`requireSkillLine('seedance25')` resolves today, and "the skill is leveraged" is real
rather than aspirational.

### What v1 costs

A vertical slice, but a narrower one than it first looked:

| Goal | Agent | Tools | Pulls in |
|---|---|---|---|
| Make a video | `shot` | `compose` → `shoot` | M3 loop, M4 skills, M5 gating |
| Edit it | `edit` (Seedance 2.5) | `edit` / `extend` | M9 |
| Storyboard | `storyboard` *(new)* | `compose` → `still` | M5 `still` |
| Bible | `bible` | `imagine` / `still` / `tag` | M8 |

**M7 (fork) and M6 (fleet) are both out of v1.** M10 too.

### Three findings that shape it

**1 · No function calling** (above). The loop parses a text protocol, and that parser is
the code gate §8 demands. The router runs on the same machinery.

**2 · `animate()` assembles a prompt — unless you stop it.**
`operations.buildAnimatePrompt` prepends `Camera move: … Lens: … Focal length: …` to the
motion text: assembly at send time, which §8 forbids, and cinematography leaking into
prompt text.

No kit change needed. `notAuto = (v) => v && v !== 'auto'`, so

```js
animate({ motion: shot.prompt })      // camera/lens/focalLength/aperture left unset
```

leaves `cine` empty and returns `motion` **verbatim**. That is the only spec-legal way for
`shoot` to use the kit. Duration, ratio and resolution stay parameters, never text (§8).

**3 · Two gaps in the spec.** "Storyboard" appears nowhere in BRAVO.md, and §4 gives the
bible agent an `imagine` tool that §6's tables never define. Both now need a definition:
storyboard as its own agent (above), and `imagine` as *revise a plate against a note* —
which is what the kit's `film/imagine.js` does.

### Hard rule: an agent does not land without its tests

Every agent added ships with `tests/agents/<kind>/`, running it on **at least five
different inputs** — the ordinary case, a boundary, an ambiguity, one that must be
refused, and any field bug as a permanent regression. Full contract in
[TESTING.md](TESTING.md).

This is §8's *"every LLM promise needs a code gate"* applied to the agents themselves.
Gated tools are stubbed unless `--spend` is passed, so the suite stays cheap enough that
nobody skips it. `node --test` is the runner — Node 24 ships it, so no test framework
becomes a dependency.

Every phase below therefore has two exit tests: the behaviour, and its five cases green.

### Order of work

Each phase ends somewhere you can stand.

| Phase | Ships | Exit test (plus: ≥5 cases green) |
|---|---|---|
| **A · Loop + router** | free tools, text protocol, parser gate, unisex→latch routing, `ToolResult`, **`tests/lib` harness** | A blank thread becomes a shot thread because of what you typed |
| **B · Compose** | `compose`/`direct`, `requireSkillLine`, citation + dialogue gates | The prompt in the thread is visibly written under sd25-pe |
| **C · Still** | `still` + approval card + budget | One Seedream image for real money, exact prompt shown first |
| **D · Shoot** | `shoot` via `animate({motion: prompt})` | **Goal 1** — a take from a prompt |
| **E · Edit** | `edit`/`extend` on Seedance 2.5, ratio+duration omitted | **Goal 2** — that take, revised |
| **F · Storyboard** | the storyboard agent, `StillGrid` | **Goal 3** — a storyboard image |
| **G · Bible** | `tag`/`imagine`, `preserve.js` asset ids, citation | **Goal 4** — plates riding as `image_asset_id` |

C before D on purpose: a still costs seconds and cents, a take costs minutes and more. If
`compose` is wrong it is far cheaper to learn that on an image.

M2 folds into A — the loop needs somewhere to put shots, and unisex threads supply it.

### One conflict still open

§5 says *"Forking is the only way a shot is created. There is no add-shot button."* With
unisex threads, a new thread that routes to `shot` **creates a shot** — which makes
`+ new thread` a shot-creation path. Either §5 relaxes to "a shot is created by forking or
by opening a thread about a new moment", or a thread routing to `shot` must attach to an
existing shot instead of making one. It needs one sentence from you before Phase A lands.

---

## Phase A in detail — the next thing to build

The milestone that carries the design risk. *"If a turn-based loop is not a pleasant way
to build a film, that shows there — before any money is spent."*

```
agents/loop.js          the turn: plan → tools → report
agents/router.js        unisex thread → the agent the message calls for, then latch
agents/shot.js          the shot agent's system prompt and tool set
agents/tools/read.js  write.js  order.js  choose.js
components/messages/ToolResult.js
components/results/     FilmStrip, PromptBlock, RefChips
tests/lib/              the runner, the gates, the report writer
tests/agents/router/    ≥5 messages → the kind each must latch
tests/agents/shot/      ≥5 instructions → the calls each must produce
```

- **The uniform contract** (§6): `{ name, input } → { output, cost }`. Every result is a
  `Message` with `role: 'tool'`, rendered inline. Free tools run without asking.
- **Thread memory** (§4): the transcript to a cap, a rolling summary of decisions beneath
  it, plus the subject, `look`, and the neighbouring shots' titles and end states.
- **Status wiring**: `idle → working → needs-you | settled`. This is where the rail stops
  being decorative — `⟳` and `●` start meaning something.
- **Inline and visual** (§2): `read film` renders a strip, not a wall of text.

Carried in from the old M2, because Phase A needs them:

1. **`look` — style, grade, notes.** §3's standing facts that every agent reads. It needs
   an editor before there is an agent to read it.
2. **Per-thread composer drafts.** `Composer` holds its text in local state and `Thread`
   stays mounted across a thread switch, so a half-written message for one thread would
   follow you to the next. Invisible with one thread, wrong the moment there are two.
3. **Numbering under load.** `filmRows()` derives `n` and the `03b` fork labels; with real
   shots it needs proof.

---

## After v1

| | | Carries |
|---|---|---|
| **M6** | Threads | Many agents running at once, the fleet view. Forces the browser-loop decision to be revisited. |
| **M7** | Fork | Sibling and next — the spec's real shot-creation path. |
| **M10** | Example shots | Takes promoted into the evidence library; agents read it. |

Plus `audio` threads, which none of the four goals reach.

---

## Open, and yours

1. **§5 vs unisex threads** — the conflict above. One sentence settles it.
2. **Where do projects persist?** localStorage today. §3 says "persist as JSON per
   project", and the kit already has TOS project saves plus `~/.modelark-starter-kit` on
   disk. Fine for now; a bad home for transcripts and takes you care about, and v1 starts
   producing those at Phase C.
3. **Spend guardrails.** Phase C spends real money. `takesCap` defaults to 4 per thread —
   say if that is wrong, and whether you want a project-level ceiling too (§6 says
   project spend is visible from the rail).
4. **Is there a Films screen?** §2 puts "Films" in the rail; no milestone introduces
   multiple projects. I labelled it `M2` on my own authority — spec it or drop the label.
5. **Packaging size.** `asar: false` costs a 598 MB bundle and slow builds. Shipping
   `.agents` via `extraResources` and chdir-ing to `process.resourcesPath` puts asar back
   on. One change.

---

## Next step

**Phase A.** It is the whole design risk in one piece: if talking to an agent is not a
good way to build a film, it shows there, before a cent is spent.

Only item 1 above blocks it, and only at the very end of the phase.
