---
name: seedance-direct
description: "INCOMPATIBLE AS WRITTEN — installed for reference, deliberately bound to nothing. From the ModelArk Starter Kit. Same reason as seedance-compose: it returns JSON and assumes a caller-side compiler, which BRAVO has no place for. The note-application method is sound; adapt it to return prose before binding."
models: []
---

---
name: seedance-direct
description: Apply ONE director's note to an existing Seedance shot prompt — the note shapes how the shot FEELS and READS (tone, pacing, mood, emphasis, wording). Events, their order, every [Image N] tag, every dialogue line, all references and keyframes stay exactly as they are; the note wins where it disagrees with the old text.
---

# Seedance Direct — a director's note on a shot prompt

Use this skill when the user has an existing Seedance shot prompt and gives ONE note
about how the shot should feel or read — "slower and heavier", "colder mood", "less
frantic, let it breathe", "the wind carries the scene" — and wants the prompt
re-shaped to match without redesigning the shot.

## Inputs

- **The current prompt** — the shot's action text. This IS the shot.
- **The director's note** — verbatim; do not paraphrase it away.
- **Images, in send order** (optional) — `[Image 1] … [Image N]`, the shot's fixed
  cast, places and frames; the user may name which are keyframes and their order.
- **Target model** — `seedance-2.0` (≤15 s) or `seedance-2.5` (≤30 s) — and the
  shot's duration in seconds.

## The contract

- **The current prompt is the shot.** Its events, their order, every `[Image N]` tag
  and every dialogue line word-for-word in curly braces ALL stay.
- **You re-shape HOW it feels and reads** per the note — tone, pacing, emphasis,
  atmosphere, wording. Where the note and the current text disagree, **the note
  wins**.
- **Never** add, drop or renumber an `[Image N]` tag. Never change what the
  references are. Never contradict the keyframe path if one is given.
- A pacing note lands through adverbs, event density and (on 2.5) interval
  re-allocation — never by inventing or deleting events.
- Touch the sound layer only if the note is about sound.

## Craft rules (always)

- Camera is NAMED grammar — professional terms used raw, ONE camera treatment per
  segment; niche terms as `[term + plain description]`.
- Motion lives at TWO altitudes — general verbs carry the flow; degree-and-speed
  micro-detail only on the one or two story-bearing beats; NEVER repeat an action
  phrase; adverbs set speed.
- Expressions are descriptive sentences, never idioms. Phrase everything positively.
- A transition names its trigger AND method and never dangles.

## Model targets

- **seedance-2.5** — one continuous take up to 30 s. For a shot longer than ~12 s,
  keep/structure the action as CONTINUOUS integer-second intervals (`0-3s: …`), one
  event cluster per 2–4 s, each interval with its own camera, action, dialogue and
  sound. A "slower" note widens intervals; a "tighter" note narrows them — the
  events themselves do not change.
- **seedance-2.0** — one continuous take at most 15 s, plain event order, NO
  timestamps.

## Never write

Composition-binding lines, subject definitions, quality/ratio/duration lines, or
dangling transition markers — the caller's compiler owns the structure around your
text.

## Output

Return ONLY JSON, no prose, no code fences:

```json
{"action": "<the re-shaped action text>",
 "audio": "<only if the note touches sound, else empty>"}
```
