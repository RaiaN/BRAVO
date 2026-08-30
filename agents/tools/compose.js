import { setBibleFields, setShotFields } from '../../state/project.js';
import { defaultImageModelKey, imageTraits, videoTraits } from '../../utils/film/suiteConfig.js';
import { resolveSubject } from './shared.js';

const PARAMS_RE = /\b(\d+\s*(seconds?|secs?|s)\b|\d+:\d+\b|1080p|720p|480p|4K)\b/i;

export const composeGates = (prompt, { refCount, dialogue = [] }) => {
  const problems = [];

  const cited = [...String(prompt).matchAll(/@?Image\s*(\d+)/gi)].map((m) => Number(m[1]));
  const outOfRange = [...new Set(cited.filter((n) => n < 1 || n > refCount))];
  if (outOfRange.length) {
    problems.push(`cites Image ${outOfRange.join(', ')} but this shot has ${refCount} reference${refCount === 1 ? '' : 's'}. Cite only 1–${refCount}, or none.`);
  }

  const leak = PARAMS_RE.exec(prompt);
  if (leak) {
    problems.push(`"${leak[0]}" is a parameter, not prompt text. Duration, ratio and resolution are sent as fields — never written into the prompt.`);
  }

  dialogue.filter(Boolean).forEach((line) => {
    if (!String(prompt).includes(line)) problems.push(`the dialogue line ${JSON.stringify(line)} is missing or altered. Reproduce it exactly.`);
  });

  return problems;
};

const brief = (project, shot, note) => {
  const look = [project.look.style, project.look.grade, project.look.notes].filter(Boolean).join(' · ');
  return [
    `THE SHOT: ${shot.title || '(untitled)'}`,
    note ? `WHAT THE PERSON WANTS: ${note}` : '',
    shot.prompt ? `ITS CURRENT PROMPT:\n${shot.prompt}` : '',
    shot.refs.length
      ? `ITS REFERENCES, IN ORDER (position IS the citation number):\n${shot.refs.map((r, i) => `  ${i + 1}. ${r.label || r.role}`).join('\n')}`
      : 'IT HAS NO REFERENCE IMAGES. Do not cite any.',
    look ? `THE LOOK (standing facts for the whole film): ${look}` : '',
  ].filter(Boolean).join('\n\n');
};

const DOCTRINE = `Write the FINAL PROMPT for this shot. What you return is sent to the model
verbatim — it is not a draft, a description, or a plan. Return the prompt and nothing else:
no preamble, no explanation, no quotes around it, no markdown fence.

THE VIDEO MODEL IS A WORLD MODEL. Specify the world and pose the situation; the model
plays the outcome. Describe the state of each subject and the moment they are in; a
listed physical detail renders literally, so keep detail to what identifies the moment.

NEVER write duration, aspect ratio or resolution into the prompt. They are sent as fields.

Consistency is attachment, not description: where a reference is attached, CITE it by its
number and do not re-describe what it shows.`;

const PLATE_DOCTRINE = `Write the FINAL PROMPT for this reference PLATE. What you return is
sent to the image model verbatim — return the prompt and nothing else: no preamble, no
explanation, no quotes, no markdown fence.

A plate is the reference that rides in later requests so every shot draws the same
subject. Neutral presentation, plainly lit, the subject square in frame; drama belongs in
the take that cites it. Keep the prompt to the subject itself — duration, aspect ratio and
resolution travel as fields.`;

const runCompose = async ({ input, project, thread, ctx, mode }) => {
  const shot = resolveSubject(project, thread, input.shot);
  if (!shot) return { project, cost: 0, output: { kind: 'error', error: `no subject matches ${JSON.stringify(input.shot ?? null)}` } };

  const note = String(input.note || input.direction || '').trim();
  if (mode === 'direct' && !note) {
    return { project, cost: 0, output: { kind: 'error', error: 'direct: needs a "note" — the change to apply' } };
  }
  if (mode === 'direct' && !shot.prompt) {
    return { project, cost: 0, output: { kind: 'error', error: 'direct: this shot has no prompt yet. Use compose first.' } };
  }
  let modelKey = shot.model;
  if (!modelKey && shot.kind === 'bible') modelKey = defaultImageModelKey();
  if (!modelKey) {
    return { project, cost: 0, output: { kind: 'error', error: 'this shot has no model slot set. Use write to set "model" first — the skill is bound to the slot.' } };
  }

  let skillLine;
  try {
    skillLine = await ctx.requireSkillLine(modelKey);
  } catch (err) {
    return { project, cost: 0, output: { kind: 'error', error: err.message } };
  }

  const traits = shot.kind === 'bible' ? { refPrefix: '' } : videoTraits(modelKey);
  const system = [
    skillLine,
    '',
    shot.kind === 'bible' ? PLATE_DOCTRINE : DOCTRINE,
    '',
    `This model cites an attached image as "${traits.refPrefix}Image${traits.refPrefix ? '' : ' '}N".`,
    mode === 'direct'
      ? 'APPLY THE NOTE to the existing prompt and PRESERVE ITS STRUCTURE. Change what the note asks for and nothing else. Return the whole revised prompt.'
      : '',
  ].filter(Boolean).join('\n');

  const dialogue = Array.isArray(input.dialogue) ? input.dialogue : [];
  let calls = 0;
  let prompt = '';
  let problems = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ask = attempt === 0
      ? brief(project, shot, note)
      : `${brief(project, shot, note)}\n\nYOUR LAST ATTEMPT WAS REJECTED:\n${problems.map((x) => `- ${x}`).join('\n')}\n\nYour prompt was:\n${prompt}\n\nRewrite it so it passes. Return only the prompt.`;
    // eslint-disable-next-line no-await-in-loop
    const { content } = await ctx.client.reason({ prompt: ask, systemPrompt: system, modelId: ctx.modelId });
    calls += 1;
    prompt = String(content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
    problems = composeGates(prompt, { refCount: shot.refs.length, dialogue });
    if (!problems.length) break;
  }

  if (problems.length) {
    return {
      project,
      cost: calls,
      output: { kind: 'error', error: `the prompt failed its checks twice and was NOT saved:\n${problems.map((x) => `- ${x}`).join('\n')}`, rejected: prompt },
    };
  }

  const next = shot.kind === 'bible'
    ? setBibleFields(project, shot.id, { prompt, model: modelKey })
    : setShotFields(project, shot.id, { prompt });
  return {
    project: next,
    cost: calls,
    output: {
      kind: 'prompt',
      shotId: shot.id,
      model: modelKey,
      refs: shot.refs.map((r, i) => ({ n: i + 1, label: r.label, role: r.role })),
      refPrefix: traits.refPrefix,
      prompt,
      gatesPassed: ['citations in range', 'no parameters in text', ...(dialogue.length ? ['dialogue preserved'] : [])],
    },
  };
};

export const compose = {
  name: 'compose',
  gated: false,
  metered: true,
  describe: 'compose — { "shot": <n|id>, "note": "what this moment is", "dialogue": ["exact line"] }. Writes the shot\'s WHOLE final prompt under the spec bound to its model slot.',
  validate: () => null,
  run: (args) => runCompose({ ...args, mode: 'compose' }),
};

export const direct = {
  name: 'direct',
  gated: false,
  metered: true,
  describe: 'direct — { "shot": <n|id>, "note": "the change to make" }. Applies a note to the existing prompt, preserving its structure.',
  validate: (input) => (String(input.note || input.direction || '').trim() ? null : 'direct: needs a "note"'),
  run: (args) => runCompose({ ...args, mode: 'direct' }),
};
