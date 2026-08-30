// Shared by every tool: how a shot the agent NAMED becomes a shot BRAVO holds.

import { bibleEntryById, filmRows, shotById } from '../../state/project.js';

// Resolve what the agent called a shot. Accepts the number a person says out loud
// ("shot 3"), the `03b` label a fork wears, or a stable id. Anything else resolves to
// NOTHING — never "the shot we were just looking at".
export const resolveShot = (project, ref, thread) => {
  if (ref === undefined || ref === null || ref === '') {
    return thread?.subjectId ? shotById(project, thread.subjectId) : null;
  }
  const rows = filmRows(project);
  const s = String(ref).trim();
  const byId = shotById(project, s);
  if (byId) return byId;
  const byLabel = rows.find((r) => r.label.toLowerCase() === s.toLowerCase().padStart(2, '0'));
  if (byLabel) return byLabel.shot;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= rows.length) return rows[n - 1].shot;
  return null;
};



// THE SUBJECT a tool acts on. A `bible` thread owns a BibleEntry; every other kind owns a
// Shot. Both are composed and rendered the same way, so this returns one shape and the
// render tools stop caring which they were handed. Without it the bible agent called
// `still`, hit "no shot matches null", and looped.
export const resolveSubject = (project, thread, ref) => {
  if (thread?.kind === 'bible') {
    const entry = bibleEntryById(project, thread.subjectId);
    if (!entry) return null;
    return {
      kind: 'bible',
      id: entry.id,
      title: entry.name,
      prompt: entry.prompt,
      model: entry.model,
      refs: [],
      raw: entry,
    };
  }
  const shot = resolveShot(project, ref, thread);
  if (!shot) return null;
  return { kind: 'shot', id: shot.id, title: shot.title, prompt: shot.prompt, model: shot.model, refs: shot.refs, raw: shot };
};
