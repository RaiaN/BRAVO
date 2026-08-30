import { defineAgent } from './registry.js';
import { describeTools, TOOLS_BY_KIND } from './tools/index.js';
import { PROTOCOL_PROMPT } from './protocol.js';
import { filmLines, lookLine, SHARED } from './shared.js';
import { filmRows, subjectOf } from '../state/project.js';

export default defineAgent({
  id: 'edit',
  title: 'Edit',
  job: 'operate on an existing take — a Seedance 2.5 editing task, or extend it',
  tools: TOOLS_BY_KIND.edit,

  latch: ({ project }) => {
    const withTakes = (project.film.shots || []).filter((s) => s.takes.length);
    return { project, subjectId: withTakes.length === 1 ? withTakes[0].id : null };
  },

  context: (project, thread) => {
    const subject = subjectOf(project, thread);
    const withTakes = filmRows(project).filter((r) => r.shot.takes.length);
    return [
      'THE FILM:', filmLines(project), '',
      'SHOTS THAT HAVE TAKES TO EDIT:',
      withTakes.length
        ? withTakes.map((r) => `  ${r.label} "${r.shot.title || '—'}" — ${r.shot.takes.map((t) => `${t.id}${t.id === r.shot.chosenTakeId ? ' (chosen)' : ''}`).join(', ')}`).join('\n')
        : '  (none yet — nothing has been shot)',
      '',
      'THIS THREAD OWNS:',
      subject ? `  "${subject.title || '—'}" · ${subject.takes?.length || 0} take(s)` : '  (no shot yet — it must attach to one that has a take)',
      subject?.prompt ? `  its prompt: ${JSON.stringify(subject.prompt)}` : '',
      '', `THE LOOK: ${lookLine(project)}`,
    ].filter((l) => l !== '').join('\n');
  },

  system: () => `You are the EDIT agent in BRAVO, an AI film studio. Your job: operate on an
EXISTING take.

You have two different ways to change a take, and choosing correctly matters:

- \`edit\` runs a SEEDANCE EDITING TASK on the take itself — reframing, retiming, altering
  what is already in the footage. An editing task LOCKS ratio and duration: they are not
  sent, and resolution is honoured.
- \`direct\` then \`shoot\` revises the PROMPT and renders a NEW take. Use this when the
  change is about what the moment IS, not about the footage you have.

If the person's note is about the material ("trim the tail", "hold longer on the eyes"),
edit. If it is about the moment ("make it uglier, less balletic"), direct then shoot.

YOU CANNOT INVENT A TAKE. If nothing has been shot, say so and stop. If several shots have
takes and it is not obvious which is meant, ask — never pick one.

${SHARED}

TOOLS YOU HOLD:
${describeTools(TOOLS_BY_KIND.edit)}

${PROTOCOL_PROMPT}`,
});
