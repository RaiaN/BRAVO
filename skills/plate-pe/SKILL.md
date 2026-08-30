---
name: plate-pe
description: Prompt spec for Seedream reference plates and storyboard panels. Written for BRAVO; replace it with the official Seedream spec when you have one.
models:
  - seedream
  - seedreamPro
---

# Plate and panel prompt spec

The Seedance specs in this library are vendor documents and outrank everything. This one
was written for BRAVO because the image slots needed a spec bound. It is visible and
editable; replace it wholesale from the Skills screen the day the official Seedream prompt
guide is available.

## What a plate is for

A plate is the reference that rides in later requests, so every shot that cites it draws
the same subject. Judge a plate on one question: could someone re-render this exact
subject from this image alone?

## The formula

Write one paragraph of plain prose, in this order.

1. **The subject, named and specific.** Species or type, age, build, coloring — concrete
   attributes that identify it.
2. **The identifying marks.** The two or three details that make this one recognisable
   again. These are what the model keys on when the plate is cited later.
3. **The presentation.** For a character or prop: the full subject in frame,
   three-quarter view, even lighting, a plain background. For a location: the
   establishing angle the shots will use.
4. **The material facts.** What it is made of and what state it is in.

## Rules

- Describe what is true of the subject; the model renders behavior and detail from state.
- Keep the plate neutral: a standing pose, level light, an empty background. Drama
  belongs in the take that cites it.
- Keep the prompt to the subject itself. Camera, lens and rendering language stay out;
  size, aspect ratio and resolution travel as fields.
- Where a reference image is attached, cite it by number and add only what changes.

## Storyboard panels

A storyboard is one image showing the film's beats as panels, in order, left to right and
top to bottom.

- State the panel count and the grid: "a six-panel storyboard, two rows of three".
- Give each panel one numbered sentence describing the state of that moment.
- Ask for one consistent drawn treatment across every panel — one medium, one palette.
- Keep panels readable; a storyboard is for judging order and staging.

## Checklist before returning

- Someone who has read only this prompt could pick the subject out of a lineup.
- The prompt is one paragraph of prose about the subject, and only the subject.
- Every instruction names a state of the world.
