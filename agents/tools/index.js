import {
  bibleEntryById, chooseTake, filmRows, insertShot, makeBibleEntry, moveShot, newId,
  removeShot, setBibleFields, setShotFields, shotById, touch,
} from '../../state/project.js';
import { resolveShot } from './shared.js';
import { ROOT_CONFIG } from '../../utils/film/suiteConfig.js';
import { compose, direct } from './compose.js';
import { GATED } from './render.js';

export { resolveShot };

const shotView = (project, shot) => {
  const row = filmRows(project).find((r) => r.shot.id === shot.id);
  return {
    id: shot.id,
    n: row?.label || null,
    title: shot.title,
    prompt: shot.prompt,
    model: shot.model,
    refs: shot.refs.map((r, i) => ({ n: i + 1, label: r.label, role: r.role })),
    duration: shot.duration,
    takes: shot.takes.map((t) => ({ id: t.id, createdAt: t.createdAt, chosen: t.id === shot.chosenTakeId })),
    chosenTakeId: shot.chosenTakeId,
    stale: shot.stale,
  };
};

const read = {
  name: 'read',
  gated: false,
  describe: 'read — { "what": "film" | "shot" | "look" | "bible", "shot": <n|id, when what=shot> }. Returns the object.',
  validate: (input) => {
    const what = input.what || (input.shot !== undefined ? 'shot' : 'film');
    if (!['film', 'shot', 'look', 'bible'].includes(what)) return `read: "what" must be film, shot, look or bible — got "${what}"`;
    return null;
  },
  run: ({ input, project, thread }) => {
    const what = input.what || (input.shot !== undefined ? 'shot' : 'film');
    if (what === 'film') {
      return {
        project,
        cost: 0,
        output: { kind: 'film', shots: filmRows(project).map(({ shot, label, depth }) => ({
          id: shot.id, n: label, depth, title: shot.title,
          hasPrompt: !!shot.prompt, takes: shot.takes.length,
          chosen: !!shot.chosenTakeId, stale: shot.stale,
        })) },
      };
    }
    if (what === 'look') return { project, cost: 0, output: { kind: 'look', look: project.look } };
    if (what === 'bible') {
      return { project, cost: 0, output: { kind: 'bible', entries: project.bible.map((b) => ({ id: b.id, name: b.name, role: b.role, hasPlate: !!b.plateUrl })) } };
    }
    const shot = resolveShot(project, input.shot, thread);
    if (!shot) return { project, cost: 0, output: { kind: 'error', error: `no shot matches ${JSON.stringify(input.shot ?? null)}` } };
    return { project, cost: 0, output: { kind: 'shot', shot: shotView(project, shot) } };
  },
};

const WRITABLE = ['title', 'model', 'duration', 'resolution', 'ratio', 'seed', 'generateAudio'];
const SLOTS = Object.keys(ROOT_CONFIG.models);

const write = {
  name: 'write',
  gated: false,
  describe: `write — { "shot": <n|id>, ${WRITABLE.map((f) => `"${f}"`).join(', ')} }. Sets fields on a shot (a bible entry takes name, role, notes instead). "model" must be one of: ${SLOTS.join(', ')}. It cannot set the prompt: that is compose's job, under the bound skill.`,
  validate: (input) => {
    const keys = Object.keys(input).filter((k) => k !== 'shot');
    if (!keys.length) return 'write: nothing to set';
    if (keys.includes('prompt')) return 'write: the prompt is written by compose under the bound skill, never set directly';
    const allowed = [...WRITABLE, 'name', 'role', 'notes'];
    const unknown = keys.filter((k) => !allowed.includes(k));
    if (unknown.length) return `write: cannot set ${unknown.join(', ')} — writable fields are ${allowed.join(', ')}`;
    if (input.model !== undefined && !SLOTS.includes(input.model)) {
      return `write: "${input.model}" is not a model slot. The slots are: ${SLOTS.join(', ')}`;
    }
    return null;
  },
  run: ({ input, project, thread }) => {
    if (thread?.kind === 'bible') {
      const entry = bibleEntryById(project, thread.subjectId);
      if (!entry) return { project, cost: 0, output: { kind: 'error', error: 'this thread owns no bible entry' } };
      const fields = {};
      ['name', 'role', 'notes'].forEach((f) => { if (input[f] !== undefined) fields[f] = input[f]; });
      if (input.title !== undefined && input.name === undefined) fields.name = input.title;
      if (!Object.keys(fields).length) return { project, cost: 0, output: { kind: 'error', error: 'write: a bible entry takes name, role or notes' } };
      const next = touch({ ...project, bible: project.bible.map((b) => (b.id === entry.id ? { ...b, ...fields } : b)) });
      return { project: next, cost: 0, output: { kind: 'plate', entry: { ...entry, ...fields } } };
    }
    const shot = resolveShot(project, input.shot, thread);
    if (!shot) return { project, cost: 0, output: { kind: 'error', error: `no shot matches ${JSON.stringify(input.shot ?? null)}` } };
    const fields = {};
    WRITABLE.forEach((f) => { if (input[f] !== undefined) fields[f] = input[f]; });
    const next = setShotFields(project, shot.id, fields);
    return { project: next, cost: 0, output: { kind: 'shot', changed: Object.keys(fields), shot: shotView(next, shotById(next, shot.id)) } };
  },
};

const order = {
  name: 'order',
  gated: false,
  describe: 'order — { "move": <n|id>, "to": <position> } or { "insert": true, "after": <n|id>, "title": "" } or { "remove": <n|id> }. Returns the new order.',
  validate: (input) => {
    const ops = ['move', 'insert', 'remove'].filter((k) => input[k] !== undefined);
    if (ops.length !== 1) return 'order: use exactly one of move, insert or remove';
    if (input.move !== undefined && !Number.isInteger(Number(input.to))) return 'order: move needs a "to" position';
    return null;
  },
  run: ({ input, project, thread }) => {
    let next = project;
    if (input.move !== undefined) {
      const shot = resolveShot(project, input.move, thread);
      if (!shot) return { project, cost: 0, output: { kind: 'error', error: `no shot matches ${JSON.stringify(input.move)}` } };
      next = moveShot(project, shot.id, Number(input.to) - 1);
    } else if (input.remove !== undefined) {
      const shot = resolveShot(project, input.remove, thread);
      if (!shot) return { project, cost: 0, output: { kind: 'error', error: `no shot matches ${JSON.stringify(input.remove)}` } };
      next = removeShot(project, shot.id);
    } else {
      const after = input.after !== undefined ? resolveShot(project, input.after, thread) : null;
      next = insertShot(project, { afterId: after?.id || null, fields: { title: String(input.title || '') } }).project;
    }
    return {
      project: next,
      cost: 0,
      output: { kind: 'film', shots: filmRows(next).map(({ shot, label, depth }) => ({
        id: shot.id, n: label, depth, title: shot.title,
        hasPrompt: !!shot.prompt, takes: shot.takes.length,
        chosen: !!shot.chosenTakeId, stale: shot.stale,
      })) },
    };
  },
};

const choose = {
  name: 'choose',
  gated: false,
  describe: 'choose — { "shot": <n|id>, "take": "<takeId>" }. Marks a take as the chosen one.',
  validate: (input) => (input.take ? null : 'choose: needs a "take" id'),
  run: ({ input, project, thread }) => {
    const shot = resolveShot(project, input.shot, thread);
    if (!shot) return { project, cost: 0, output: { kind: 'error', error: `no shot matches ${JSON.stringify(input.shot ?? null)}` } };
    const next = chooseTake(project, shot.id, input.take);
    if (next === project) return { project, cost: 0, output: { kind: 'error', error: `shot ${shot.id} has no take ${input.take}` } };
    return { project: next, cost: 0, output: { kind: 'shot', shot: shotView(next, shotById(next, shot.id)) } };
  },
};

const tag = {
  name: 'tag',
  gated: false,
  describe: 'tag — { "name": "<subject>", "role": "character|location|prop", "url": "<a rendered still url>", "notes": "" }. Files a plate into the bible.',
  validate: (input) => {
    if (!String(input.name || '').trim()) return 'tag: needs a "name"';
    if (input.assetId !== undefined && typeof input.assetId !== 'string') return 'tag: "assetId" must be a string';
    if (!input.role) return 'tag: needs a "role" — character, location, prop or frame';
    if (!['character', 'location', 'prop', 'frame'].includes(input.role)) return `tag: role must be character, location, prop or frame — got "${input.role}"`;
    return null;
  },
  run: ({ input, project, thread }) => {
    const subject = thread?.kind === 'bible' ? bibleEntryById(project, thread.subjectId) : null;
    const shot = thread?.subjectId ? shotById(project, thread.subjectId) : null;
    const lastStill = (shot?.stills || [])[(shot?.stills || []).length - 1];
    const url = input.url || lastStill?.url || subject?.plateUrl || null;
    if (!url) return { project, cost: 0, output: { kind: 'error', error: 'tag: there is no rendered plate to file yet — render one with still first' } };

    const uploaded = thread?.messages?.find((m) => m.asset && m.asset.url === url);
    const fields = {
      name: String(input.name).trim(),
      role: input.role,
      plateUrl: url,
      assetId: input.assetId || uploaded?.asset?.assetId || subject?.assetId || null,
      notes: String(input.notes || subject?.notes || ''),
    };

    if (subject) {
      const next = touch({ ...project, bible: project.bible.map((b) => (b.id === subject.id ? { ...b, ...fields } : b)) });
      return { project: next, cost: 0, output: { kind: 'plate', entry: { ...subject, ...fields } } };
    }
    const entry = makeBibleEntry(fields);
    return {
      project: touch({ ...project, bible: [...project.bible, entry] }),
      cost: 0,
      output: { kind: 'plate', entry },
    };
  },
};

const cite = {
  name: 'cite',
  gated: false,
  describe: 'cite — { "shot": <n|id>, "entry": "<bible entry name or id>" } attaches that entry\'s plate as the next reference (its position is the citation number); { "shot": <n|id>, "remove": <position> } detaches one.',
  validate: (input) => {
    if (input.entry === undefined && input.remove === undefined) return 'cite: needs an "entry" to attach or a "remove" position';
    return null;
  },
  run: ({ input, project, thread }) => {
    const shot = resolveShot(project, input.shot, thread);
    if (!shot) return { project, cost: 0, output: { kind: 'error', error: `no shot matches ${JSON.stringify(input.shot ?? null)}` } };

    if (input.remove !== undefined) {
      const n = Number(input.remove);
      if (!Number.isInteger(n) || n < 1 || n > shot.refs.length) {
        return { project, cost: 0, output: { kind: 'error', error: `cite: this shot has ${shot.refs.length} reference(s); ${JSON.stringify(input.remove)} matches none` } };
      }
      const next = setShotFields(project, shot.id, { refs: shot.refs.filter((_, i) => i !== n - 1) });
      return { project: next, cost: 0, output: { kind: 'shot', shot: shotView(next, shotById(next, shot.id)) } };
    }

    const q = String(input.entry).trim().toLowerCase();
    const matches = project.bible.filter((b) => b.id === input.entry || b.name.trim().toLowerCase() === q);
    if (!matches.length) return { project, cost: 0, output: { kind: 'error', error: `cite: no bible entry matches ${JSON.stringify(input.entry)}` } };
    if (matches.length > 1) return { project, cost: 0, output: { kind: 'error', error: `cite: ${JSON.stringify(input.entry)} matches ${matches.length} entries — use an id` } };
    const entry = matches[0];
    if (!entry.plateUrl) return { project, cost: 0, output: { kind: 'error', error: `cite: "${entry.name}" has no plate yet — render one in its bible thread first` } };
    if (shot.refs.some((r) => r.bibleEntryId === entry.id)) {
      const at = shot.refs.findIndex((r) => r.bibleEntryId === entry.id) + 1;
      return { project, cost: 0, output: { kind: 'error', error: `cite: "${entry.name}" is already reference ${at}` } };
    }

    const ref = { id: newId('ref'), kind: 'image', url: entry.plateUrl, assetId: entry.assetId || null, label: entry.name, role: entry.role, bibleEntryId: entry.id };
    const next = setShotFields(project, shot.id, { refs: [...shot.refs, ref] });
    return { project: next, cost: 0, output: { kind: 'shot', shot: shotView(next, shotById(next, shot.id)) } };
  },
};

const attach = {
  name: 'attach',
  gated: false,
  describe: 'attach — { "url": "<an image uploaded or rendered in this thread>", "label": "" } adds it as an ordered reference for the next plate render; { "remove": <position> } detaches one.',
  validate: (input) => {
    if (input.url === undefined && input.remove === undefined) return 'attach: needs the "url" of an uploaded image, or a "remove" position';
    return null;
  },
  run: ({ input, project, thread }) => {
    const entry = thread?.kind === 'bible' ? bibleEntryById(project, thread.subjectId) : null;
    if (!entry) return { project, cost: 0, output: { kind: 'error', error: 'attach: this thread owns no bible entry' } };
    const refs = entry.refs || [];

    if (input.remove !== undefined) {
      const n = Number(input.remove);
      if (!Number.isInteger(n) || n < 1 || n > refs.length) {
        return { project, cost: 0, output: { kind: 'error', error: `attach: this entry has ${refs.length} reference(s); ${JSON.stringify(input.remove)} matches none` } };
      }
      const next = setBibleFields(project, entry.id, { refs: refs.filter((_, i) => i !== n - 1) });
      return { project: next, cost: 0, output: { kind: 'plate', entry: bibleEntryById(next, entry.id) } };
    }

    const uploaded = thread.messages.find((m) => m.asset && m.asset.url === input.url);
    const rendered = input.url === entry.plateUrl || (entry.stills || []).some((st) => st.url === input.url);
    if (!uploaded && !rendered) return { project, cost: 0, output: { kind: 'error', error: `attach: ${JSON.stringify(input.url)} was not uploaded or rendered in this thread` } };
    if (refs.some((r) => r.url === input.url)) {
      return { project, cost: 0, output: { kind: 'error', error: `attach: that image is already reference ${refs.findIndex((r) => r.url === input.url) + 1}` } };
    }
    const ref = { id: newId('ref'), kind: 'image', url: input.url, assetId: uploaded?.asset?.assetId || (rendered ? entry.assetId : null) || null, label: String(input.label || uploaded?.asset?.name || (rendered ? 'current plate' : 'upload')), role: 'frame', bibleEntryId: null };
    const next = setBibleFields(project, entry.id, { refs: [...refs, ref] });
    return { project: next, cost: 0, output: { kind: 'plate', entry: bibleEntryById(next, entry.id), refs: [...refs, ref].map((r, i) => ({ n: i + 1, label: r.label })) } };
  },
};

export const TOOLS = { read, write, order, choose, cite, compose, direct, tag, attach, ...GATED };

export const TOOLS_BY_KIND = {
  shot:       ['read', 'write', 'order', 'choose', 'cite', 'compose', 'direct', 'still', 'shoot'],
  edit:       ['read', 'choose', 'direct', 'edit', 'shoot'],
  storyboard: ['read', 'write', 'order', 'cite', 'compose', 'still'],
  bible:      ['read', 'write', 'attach', 'compose', 'direct', 'still', 'tag'],
  audio:      ['read', 'write'],
};

export const describeTools = (names) => names
  .map((n) => TOOLS[n]?.describe)
  .filter(Boolean)
  .map((d) => `- ${d}`)
  .join('\n');
