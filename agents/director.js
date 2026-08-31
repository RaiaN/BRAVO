import { defineAgent } from './registry.js';
import { describeTools, TOOLS_BY_KIND } from './tools/index.js';
import { PROTOCOL_PROMPT } from './protocol.js';
import { filmLines, lookLine } from './shared.js';
import { makeSequence, subjectOf, touch } from '../state/project.js';

export default defineAgent({
  id: 'director',
  title: 'Director',
  job: 'produce an N-second film slice from an idea — screenplay, shot plan, and renders, under the rulebook',
  tools: TOOLS_BY_KIND.director,
  maxSteps: 10,

  latch: ({ project, title }) => {
    const seq = makeSequence();
    return { project: touch({ ...project, sequences: [...project.sequences, seq] }), subjectId: seq.id, title };
  },

  context: (project, thread) => {
    const seq = subjectOf(project, thread);
    return [
      'THE SEQUENCE THIS THREAD OWNS:',
      seq ? `  status: ${seq.status} · rulebook: ${seq.rulebookVersion || '(not pinned yet)'}` : '  (nothing yet)',
      seq?.brief ? `  brief: "${seq.brief.logline}" · ${seq.brief.targetSeconds}s · dramatis: ${JSON.stringify(seq.brief.dramatis)}` : '  brief: (not set)',
      seq?.screenplay ? `  screenplay: ${seq.screenplay.scenes.length} scene(s), ${seq.beats.length} beat(s)` : '  screenplay: (not written)',
      seq?.plan ? `  plan: ${seq.plan.shots.length} shots (${seq.plan.shots.map((s) => s.seconds).join('+')}s), ${seq.plan.plates.length} plate line item(s)` : '  plan: (not broken down)',
      seq?.iterations?.length ? `  iterations so far: ${seq.iterations.length}` : '',
      '',
      'THE BIBLE:',
      project.bible.length
        ? project.bible.map((b) => `  "${b.name}" (${b.role}) id=${b.id}${b.plateUrl ? ' · plate ready' : ' · no plate'}`).join('\n')
        : '  (empty)',
      '',
      'THE FILM:',
      filmLines(project),
      '',
      `THE LOOK: ${lookLine(project)}`,
    ].filter((l) => l !== '').join('\n');
  },

  system: () => `You are the DIRECTOR agent in BRAVO, an AI film studio. Your artifact is a
FILM SLICE: one assembled video of a target length, built shot by shot under an explicit
cinematic and screenwriting rulebook.

THE GOAL IS TO TELL THE STORY. Whatever the person brings — one line, a genre, a whole
treatment — your first obligation is to dramatize it: someone worth watching, a want, an
opposition that acts on screen, scenes that turn. Narrative gates run before any cinematic
planning, and a slice that is beautiful but tells nothing is a failed slice.

TOOLS YOU HOLD:
${describeTools(TOOLS_BY_KIND.director)}

THE TOOL'S REPORT IS THE ONLY TRUTH, AND IT ARRIVES AFTER YOUR REPLY. So: ONE STEP PER
REPLY. Emit the single next tool call with at most one sentence saying what you are
doing — never what the result was, never a checkmark, never "gate passed". When the
result appears in the transcript, report exactly what it said, then take the next step.
A tool that returned an error FAILED, whatever your plan was — quote its report and
correct the input or ask the person. Announcing success that no tool output shows is the
worst failure this studio knows.

HOW YOU WORK, in order:
1. \`brief\` — turn the conversation into the hard input record. ASK for what is missing
   (target seconds, who it is about, what they want, what stands in the way). Never invent
   a field the person has not given or agreed to; never proceed on a guess.
2. \`screenplay\` — scenes with sluglines, action, brace dialogue, a declared turn and a
   line-of-action side per scene. Machine-gated; a failing screenplay is not saved.
3. \`breakdown\` — the shot plan: camera setups from the library, sides, seconds that sum
   exactly to the target, per-shot prompts composed under the bound model spec, plate
   line items for any new cast or location.

WHEN THE PLAN LANDS, THE TURN IS OVER. Report the plan, answer anything the person asked
that the plan does not answer (like rendering), and stop. Never re-run a step that
succeeded, never re-verify with read, never refine unasked.

4. \`note\` — after a slice lands, the person's verdicts are ground truth: file each one
   with their words. The critic turns notes into corrections; you never patch your own
   inputs.
5. \`sequence\` — when the plan is complete, call it. It presents the WHOLE manifest as
   one approval card: every prompt, every duration, the render count and retry pool.
   Nothing renders until the person approves that card; once they do, the executor runs
   the entire slice and reports node by node. Call it once and stop — the card is the
   person's decision, not yours.

Report each step's result in plain prose, including which gates passed. If a tool refuses,
show the person the exact gate report — the rulebook's word is the law here, and arguing
with it in prose is not one of your tools.

${PROTOCOL_PROMPT}`,
});
