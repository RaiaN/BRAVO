import { defineAgent } from './registry.js';
import { describeTools, TOOLS_BY_KIND } from './tools/index.js';
import { PROTOCOL_PROMPT } from './protocol.js';
import { lookLine, SHARED } from './shared.js';
import { filmRows, insertShot, subjectOf } from '../state/project.js';

export const SHOT_TOOLS = TOOLS_BY_KIND.shot;

export const shotContext = (project, thread) => {
  const rows = filmRows(project);
  const i = rows.findIndex((r) => r.shot.id === thread.subjectId);
  const subject = subjectOf(project, thread);
  const near = (j) => (rows[j] ? `${rows[j].label} "${rows[j].shot.title || '—'}"${rows[j].shot.chosenTakeId ? ' (has a chosen take)' : ''}` : 'nothing');

  return [
    `THE FILM (${rows.length} shot${rows.length === 1 ? '' : 's'}, in order):`,
    rows.length
      ? rows.map((r) => `  ${r.label}${r.depth ? ' (fork)' : ''} "${r.shot.title || '—'}"${r.shot.prompt ? ' · has a prompt' : ' · no prompt yet'}${r.shot.takes.length ? ` · ${r.shot.takes.length} take(s)` : ''}`).join('\n')
      : '  (empty)',
    '',
    'THIS THREAD OWNS:',
    subject ? `  ${rows[i]?.label || '—'} "${subject.title || '—'}"` : '  (its shot was removed)',
    subject ? `  prompt: ${subject.prompt ? JSON.stringify(subject.prompt) : '(none yet)'}` : '',
    subject ? `  model slot: ${subject.model || '(not chosen)'} · duration: ${subject.duration}` : '',
    '',
    `NEIGHBOURS: before → ${i > 0 ? near(i - 1) : 'nothing'} · after → ${i >= 0 ? near(i + 1) : 'nothing'}`,
    '',
    `THE LOOK (standing facts for every agent): ${lookLine(project)}`,
  ].filter((l) => l !== '').join('\n');
};

export default defineAgent({
  id: 'shot',
  title: 'Shot',
  job: 'make one shot of the film good — compose its prompt, render takes, judge them',
  tools: SHOT_TOOLS,

  latch: ({ project, title, videoSlot }) => {
    const made = insertShot(project, { fields: { title }, modelSlot: videoSlot });
    return { project: made.project, subjectId: made.shot.id };
  },

  context: shotContext,

  system: () => `You are the agent for ONE shot of a film in BRAVO. Your job: make this shot good.

You own exactly one shot. Everything the person types in this thread is about it — there is
never a "select something first".

A film is an ORDERED LIST OF SHOTS. The order is the film.

TOOLS YOU HOLD:
${describeTools(SHOT_TOOLS)}

THE PROMPT IS WRITTEN BY \`compose\`, NEVER BY YOU. It writes the shot's whole final prompt
under the official spec bound to the shot's model slot. You do not draft prompts, suggest
prompt wording, or paste one into a field — the spec outranks your instincts, and a slot
with no spec bound REFUSES to compose rather than falling back on habit.

- \`still\` is one Seedream image: seconds, cents. Use it to check a prompt cheaply.
- \`shoot\` is one Seedance take: minutes, real money. Use it when the prompt is right.

Each thread has a render budget. When it runs out, stop and say so.

HOW YOU WORK:
- Read before you write. If you are unsure which shot is meant, ask — never guess an id.
- If a tool fails, say what failed and why. Do not retry blindly.
- The film, the shot you own and the look are given to you every turn. Answer questions
  about them directly — only call \`read\` when you need something not already in front of you.
- Judging a finished take is the person's, never yours.

${SHARED}

${PROTOCOL_PROMPT}`,
});
