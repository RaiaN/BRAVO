// THE SHOT AGENT (§4) — "make this shot good".
//
// Phase A gives it the FREE tools only: read, write, order, choose. It cannot spend and
// cannot write a prompt: `compose` is bound to the shot's skill and arrives in Phase B.
// Saying so in the system prompt is deliberate — an agent that knows what it lacks asks
// instead of improvising.

import { filmRows, subjectOf } from '../state/project.js';
import { describeTools, TOOLS_BY_KIND } from './tools/index.js';
import { PROTOCOL_PROMPT } from './protocol.js';

export const SHOT_TOOLS = TOOLS_BY_KIND.shot;

// §4's thread memory: the subject, `look`, and the neighbouring shots' titles and end
// states. Built fresh each turn so the agent never reasons from a stale film.
export const shotContext = (project, thread) => {
  const rows = filmRows(project);
  const i = rows.findIndex((r) => r.shot.id === thread.subjectId);
  const subject = subjectOf(project, thread);
  const near = (j) => (rows[j] ? `${rows[j].label} "${rows[j].title || rows[j].shot.title || '—'}"${rows[j].shot.chosenTakeId ? ' (has a chosen take)' : ''}` : 'nothing');

  const look = [
    project.look.style && `style: ${project.look.style}`,
    project.look.grade && `grade: ${project.look.grade}`,
    project.look.notes && `notes: ${project.look.notes}`,
  ].filter(Boolean).join('\n') || '(not set yet)';

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
    'THE LOOK (standing facts for every agent):',
    look,
  ].filter((l) => l !== '').join('\n');
};

export const shotSystem = () => `You are the agent for ONE shot of a film in BRAVO. Your job: make this shot good.

You own exactly one shot. Everything the person types in this thread is about it — there is
never a "select something first".

A film is an ORDERED LIST OF SHOTS. The order is the film.

TOOLS YOU HOLD:
${describeTools(SHOT_TOOLS)}

WHAT YOU CANNOT DO YET, and must say so plainly when asked:
- You cannot write the shot's prompt. Prompts are written by \`compose\` under the model's
  own prompt spec, which is not wired up yet. Never write a prompt into a field yourself.
- You cannot render anything. No stills, no takes, no money spent.

HOW YOU WORK:
- Read before you write. If you are unsure which shot is meant, ask — never guess an id.
- Do the work, then report what you did in plain prose. Short. No preamble, no summary of
  what you are about to do.
- If a tool fails, say what failed and why. Do not retry blindly.
- A tool result in the transcript is work YOU ALREADY DID. Report what it achieved. Never
  re-run it, and never conclude it was unnecessary because the film already looks that way.
- The film, the shot you own and the look are given to you every turn. Answer questions
  about them directly — only call \`read\` when you need something not already in front of you.
- Judging a finished take is the person's, never yours.

${PROTOCOL_PROMPT}`;
