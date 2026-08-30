---
name: plate-pe
description: Prompt spec for Seedream reference plates and storyboard panels — bible entries, character/location/prop plates, and the film drawn as panels. AUTHORED FOR BRAVO, not a vendor document; replace it with the official Seedream spec when you have one.
models:
  - seedream
  - seedreamPro
---

# Plate and panel prompt spec

**Provenance, so nobody is misled.** The Seedance specs in this library (`sd25-pe`,
`sd20-pe`) are vendor documents and outrank everything. This one is not — it was written
for BRAVO because the image slots had no spec bound and §7 refuses to compose without one.
It is deliberately visible and editable: replace it wholesale from the Skills screen the
day you have the official Seedream prompt guide.

## What a plate is for

A plate is not an illustration. It is the **reference that rides in later requests** so
every shot draws the same wolf, the same clearing, the same knife. §8: *consistency is
attachment, not description* — the plate is attached and cited, and the shot prompt does
not re-describe what it shows.

So a plate is judged on one thing: **is this subject unmistakably identifiable and
re-renderable from this image alone?**

## The formula

Write one paragraph, in this order. No headings, no bullet lists, no markdown.

1. **The subject, named and specific.** "A grey timber wolf, adult male, heavy winter
   coat." Not "a majestic wolf" — adjectives of praise carry no information.
2. **The identifying marks.** The two or three things that make THIS one recognisable
   again: a torn left ear, a white blaze, a bent aerial. These are what the model keys on
   when the plate is cited later.
3. **The presentation.** For a character or prop plate: full subject in frame, three-quarter
   view, neutral even lighting, plain uncluttered background. For a location plate: the
   establishing angle you will actually shoot from.
4. **The material facts.** Fur, metal, wet stone, worn leather. What it is made of and what
   state it is in.

## Rules

- **State, never feature.** Name what is true of the subject ("the wolf is lean and
  wintered"), never instruct a rendering detail ("guard hairs lift") — a feature
  instruction renders literally and looks wrong.
- **A plate is neutral.** No drama, no action, no story beat. The wolf mid-leap is a shot;
  the wolf standing square is a plate. Drama belongs in the take.
- **No camera language.** No focal lengths, no f-stops, no "shot on". A plate has no
  camera; it has a subject.
- **Never write parameters.** Size, aspect ratio and resolution are fields, never words in
  the prompt.
- **Cite, do not re-describe.** Where a reference image is attached, refer to it by its
  number and add only what changes.

## Storyboard panels

A storyboard is one image showing the film's beats as panels, in order, left to right and
top to bottom.

- Say the panel count and the grid explicitly: "a six-panel storyboard, two rows of three".
- Give each panel one sentence, numbered, describing the STATE of that moment.
- Ask for a consistent drawn treatment across every panel — one medium, one palette.
- Keep panels readable: a storyboard is for judging order and staging, not for beauty.

## Checklist before returning

- Would someone who has never read the script recognise this subject again from the image?
- Is there any camera, lens or parameter language? Remove it.
- Is there any instruction about how to render rather than what is true? Rewrite it as a
  state.
- Is it one paragraph of prose, with no markdown?
