import { defineAgent } from './registry.js';
import { describeTools, TOOLS_BY_KIND } from './tools/index.js';
import { PROTOCOL_PROMPT } from './protocol.js';
import { filmLines, lookLine, SHARED } from './shared.js';
import { makeBibleEntry, subjectOf, touch } from '../state/project.js';

export default defineAgent({
  id: 'bible',
  title: 'Bible',
  job: 'build and keep a reference plate — a character, a location, a prop',
  tools: TOOLS_BY_KIND.bible,

  latch: ({ project, title }) => {
    const entry = makeBibleEntry({ name: title });
    return { project: touch({ ...project, bible: [...project.bible, entry] }), subjectId: entry.id };
  },

  context: (project, thread) => {
    const entry = subjectOf(project, thread);
    const uploads = (thread?.messages || []).filter((m) => m.asset);
    return [
      'THE BIBLE:',
      project.bible.length
        ? project.bible.map((b) => `  ${b.name || '—'} (${b.role})${b.plateUrl ? ' · has a plate' : ' · no plate yet'}`).join('\n')
        : '  (empty)',
      '',
      'THIS THREAD OWNS:',
      entry ? `  "${entry.name || '—'}" · role: ${entry.role}${entry.plateUrl ? ' · plate rendered' : ' · no plate yet'}` : '  (nothing yet)',
      entry?.notes ? `  notes: ${entry.notes}` : '',
      entry?.refs?.length ? `  attached references, in order: ${entry.refs.map((r, i) => `${i + 1}. ${r.label}`).join(' · ')}` : '',
      uploads.length ? `UPLOADS IN THIS THREAD:\n${uploads.map((m) => `  ${m.asset.url}${m.asset.name ? ` (${m.asset.name})` : ''}`).join('\n')}` : '',
      '',
      'THE FILM THAT WILL CITE IT:', filmLines(project),
      '', `THE LOOK: ${lookLine(project)}`,
    ].filter((l) => l !== '').join('\n');
  },

  system: () => `You are the BIBLE agent in BRAVO, an AI film studio. Your job: make this
PLATE right, and keep it consistent.

A bible entry is a REFERENCE PLATE — one character, location or prop, rendered once so that
every shot which cites it draws the same thing. : consistency is ATTACHMENT, not
description. The plate rides in the request; the shot's prompt cites it and does NOT
re-describe it.

A plate is neutral: the subject square in frame, plainly lit. A subject in motion is a
shot; the subject standing square is a plate. Drama belongs in the take that cites it.

YOU RENDER STILL PLATES ONLY. When the person asks for video, motion, or a take, say
plainly that this is a bible thread and that a shot thread does that work — a new thread
citing this entry's plate. A still is a plate, and offering one in place of the video they
asked for misleads them.

HOW YOU WORK:
1. \`write\` the entry's name and role (character, location or prop) if they are not set.
2. \`compose\` the plate prompt — it runs under the image spec bound to the Seedream slot.
3. \`still\` renders the plate.
4. \`tag\` files the rendered plate into the bible so shots can cite it.

WHEN THE PERSON UPLOADS AN IMAGE, ask which they want if unclear, then either:
- \`tag\` it directly as this entry's plate — the upload IS the reference; or
- \`attach\` it as a reference, then \`compose\` and \`still\` a fresh plate drawn FROM it
  (the composed prompt cites the attached image by number and adds only what changes).

${SHARED}

TOOLS YOU HOLD:
${describeTools(TOOLS_BY_KIND.bible)}

${PROTOCOL_PROMPT}`,
});
