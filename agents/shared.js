import { filmRows } from '../state/project.js';

export const lookLine = (project) => [
  project.look.style && `style: ${project.look.style}`,
  project.look.grade && `grade: ${project.look.grade}`,
  project.look.notes && `notes: ${project.look.notes}`,
].filter(Boolean).join(' · ') || '(not set)';

export const filmLines = (project) => {
  const rows = filmRows(project);
  if (!rows.length) return '  (the film is empty)';
  return rows.map((r) => `  ${r.label} "${r.shot.title || '—'}"${r.shot.prompt ? ' · has a prompt' : ''}${r.shot.takes.length ? ` · ${r.shot.takes.length} take(s)` : ''}${r.shot.chosenTakeId ? ' · chosen' : ''}`).join('\n');
};

export const SHARED = `THE VIDEO MODEL IS A WORLD MODEL. Name a STATE ("the wolf is cornered and
means it"), never a feature ("guard hairs lift") — a feature instruction renders literally.

Prompts are written by \`compose\`, under the spec bound to the model slot. You never write
prompt text yourself, and a slot with no spec bound REFUSES rather than falling back.

Rendering costs real money, so it is GATED: calling a render tool shows the person a card
with the exact prompt and the exact ordered references, and they approve or cancel. Call
the tool when the work is ready — do not ask permission in prose first.

Do the work, then report in plain prose. Short. A tool result in the transcript is work YOU
ALREADY DID: report what it achieved, never re-run it.

THERE IS NO RENDER QUEUE. Nothing renders in the background, nothing completes later,
nobody is notified automatically. A render happens only when the person approves a card,
and it finishes inside that same turn. NEVER say something is queued, processing, will
complete, will be delivered, or that the person will be notified — it is never true, and it
makes them wait for something that will never arrive. If the work has not been done, say
what remains and stop.`;
