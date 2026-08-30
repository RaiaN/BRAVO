---
name: seedance-compose
description: "INCOMPATIBLE AS WRITTEN — installed for reference, deliberately bound to nothing. From the ModelArk Starter Kit. It ends 'Return ONLY JSON' and says 'the caller's compiler adds structure around your text'. BRAVO has no compiler (§8: the prompt is the prompt), and compose saves what comes back verbatim — so binding this would store a JSON blob as the shot's prompt. Its keyframe method is worth reading; adapt it into a skill that returns prose before binding."
models: []
---

---
name: seedance-compose
description: Compose a Seedance 2.0/2.5 shot ACTION prompt from ordered keyframe images + reference images + optional draft text. Keyframes are the approved design and override the text; dialogue and names ride verbatim. Two-step pipeline — derive events from the keyframes alone, then enrich with references.
---

# Seedance Compose — keyframes → shot action prompt

Use this skill when the user has a set of reference images for one video shot — some of
them marked as ORDERED KEYFRAMES (the compositions the shot opens on, passes through,
and lands on) — and wants the shot's action prompt written for Seedance 2.0 or 2.5.

## Inputs

- **Images, in send order** — the exact images the video model will receive, numbered
  `[Image 1] … [Image N]`. The user tells you which are keyframes and their order
  (e.g. "keyframes: Image 2 → Image 5 → Image 6"). The rest are identity references
  (characters, places, props).
- **Draft text** (optional) — the user's existing prompt or script fragment.
- **Target model** — `seedance-2.0` (≤15 s take) or `seedance-2.5` (≤30 s take).
- **Duration** — the shot's length in seconds.

## Authority contract

- **Keyframes given → the pictures rule.** Derive the shot's events FROM the keyframe
  path; what changes between the keyframes IS the performance. From the draft text
  carry ONLY what pictures cannot show: every dialogue line word-for-word in curly
  braces with its speaker named, proper names, and intent that does not contradict
  the images. List every draft event you overrode — never drop content silently.
- **No keyframes → the text rules.** The draft is the material and the authority on
  what happens: carry its wording, events and dialogue verbatim; re-structure and
  ground it against the reference images, never re-invent it.

## Procedure

**Step 1 — DERIVE (keyframes only).** Look ONLY at the keyframe images, in order.
Ignore the draft text entirely in this step (so it cannot anchor you). Narrate the
shot's events chronologically, keyframe to keyframe: name each figure by a short
consistent visual handle, prefer slow continuous movement with natural inertia,
externalize emotion as visible physical detail. No dialogue, no camera directions,
no binding lines — events only. Pace the events to the duration, no more.

**Step 2 — ENRICH (everything).** Rewrite the derived events into the final action:
replace each visual handle with its subject's real `[Image N]` number; keep the event
order and pacing; weave the draft's dialogue verbatim at the right moments; open with
a ONE-SENTENCE SUMMARY (subject + location + event + style + camera). Sound effects
in angle brackets `<…>`, music in full-width parens `（…）`.

## Craft rules (always)

- Camera is NAMED grammar — professional terms used raw (shot size, angle, movement,
  techniques like long take / dolly zoom / speed ramp), ONE camera treatment per
  segment; niche terms as `[term + plain description]`.
- Motion lives at TWO altitudes — general verbs carry the flow ("the two engage in
  close combat"); degree-and-speed micro-detail is spent on only one or two
  story-bearing beats per shot; NEVER repeat an action phrase (repetition loops the
  motion); adverbs set speed.
- Expressions are descriptive sentences, never idioms. Phrase everything positively —
  say what happens, not what doesn't.
- A transition names its trigger AND method ("at 5s, a quick left wipe with a natural
  dissolve") and never dangles at the end of the text.

## Model targets

- **seedance-2.5** — one continuous take up to 30 s. For a shot longer than ~12 s,
  structure the action as CONTINUOUS integer-second intervals (`0-3s: … 3-8s: …`, no
  gaps), roughly ONE event cluster per 2–4 seconds; each interval carries its OWN
  camera, action, dialogue and sound; time-POINTS for accents ("at the 5-second
  mark, …"). Never overpack an interval (phantom cuts) or leave one thin (invites
  improvisation).
- **seedance-2.0** — one continuous take at most 15 s; a tight, unbroken event chain
  in plain event order. NO timestamps (2.0 ignores them).

## Never write

Composition-binding lines ("opens exactly on…", "Use Image k as a keyframe"), subject
definitions ("Define the person in…"), quality/ratio/duration lines, or transition
markers dangling at the end — the caller's compiler adds structure around your text.

## Output

Return ONLY JSON, no prose, no code fences:

```json
{"action": "<the shot's action text>",
 "audio": "<one sound line in the symbol grammar, or empty>",
 "dropped": ["<a draft event the keyframes overrode, or omit>"]}
```
