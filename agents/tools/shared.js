import { bibleEntryById, filmRows, shotById } from '../../state/project.js';

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
      refs: entry.refs || [],
      raw: entry,
    };
  }
  const shot = resolveShot(project, ref, thread);
  if (!shot) return null;
  return { kind: 'shot', id: shot.id, title: shot.title, prompt: shot.prompt, model: shot.model, refs: shot.refs, raw: shot };
};
