// THE TOOLS (§6).
//
// Uniform contract: `{ name, input } → { output, cost }`. Every result becomes a Message
// with `role: 'tool'`, rendered inline and visual (§2) — never a wall of text where a
// picture is the answer.
//
// These four are FREE: they run without asking. Metered (`compose`, `direct`) and gated
// (`still`, `shoot`, `edit`, `extend`, `speak`) tools arrive in later phases and are the
// reason `cost` is in the contract from the start.
//
// Each tool is `{ name, gated, describe, validate, run }`.
//   validate(input) → null when the input is usable, else the reason it is not.
//                     This is a §8 code gate: it runs before anything is mutated.
//   run({ input, project, thread }) → { project, output, cost }

import {
  bibleEntryById, chooseTake, filmRows, insertShot, makeBibleEntry, moveShot,
  removeShot, setShotFields, shotById, touch,
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

// ---- read ------------------------------------------------------------------------

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

// ---- write -----------------------------------------------------------------------

// The fields a shot agent may set directly. `prompt` is NOT here: §3 invariant 1 makes it
// the final prompt and §6 gives it its own tool (`compose`/`direct`) bound to the skill.
// Letting `write` set it would be exactly the unskilled prompt-authoring §7 forbids.
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
    const allowed = [...WRITABLE, 'name', 'role', 'notes'];   // the bible entry's fields
    const unknown = keys.filter((k) => !allowed.includes(k));
    if (unknown.length) return `write: cannot set ${unknown.join(', ')} — writable fields are ${allowed.join(', ')}`;
    // THE SLOT MUST BE A REAL SLOT. Without this an agent can write model:"storyboard",
    // which is accepted silently and then refuses to compose because nothing is bound to
    // a slot that does not exist. §8: an unknown id resolves to nothing — so refuse it
    // here, where the reason is still legible.
    if (input.model !== undefined && !SLOTS.includes(input.model)) {
      return `write: "${input.model}" is not a model slot. The slots are: ${SLOTS.join(', ')}`;
    }
    return null;
  },
  run: ({ input, project, thread }) => {
    // A bible thread owns an ENTRY, not a shot: `name`, `role` and `notes` are its fields.
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

// ---- order -----------------------------------------------------------------------

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

// ---- choose ----------------------------------------------------------------------

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

// ---- tag (§6 free) -----------------------------------------------------------------
// Files a rendered plate into the bible so shots can cite it. Consistency is attachment
// (§8): what `tag` records is what will RIDE in later requests.

const tag = {
  name: 'tag',
  gated: false,
  describe: 'tag — { "name": "the wolf", "role": "character|location|prop", "url": "<a rendered still url>", "notes": "" }. Files a plate into the bible.',
  validate: (input) => {
    if (!String(input.name || '').trim()) return 'tag: needs a "name"';
    const role = input.role || 'character';
    if (!['character', 'location', 'prop', 'frame'].includes(role)) return `tag: role must be character, location, prop or frame — got "${role}"`;
    return null;
  },
  run: ({ input, project, thread }) => {
    // Prefer the plate this thread just rendered over a url the model retyped from
    // memory — a mistyped url is a plate that silently never rides (§8).
    const subject = thread?.kind === 'bible' ? bibleEntryById(project, thread.subjectId) : null;
    const shot = thread?.subjectId ? shotById(project, thread.subjectId) : null;
    const lastStill = (shot?.stills || [])[(shot?.stills || []).length - 1];
    const url = input.url || lastStill?.url || subject?.plateUrl || null;
    if (!url) return { project, cost: 0, output: { kind: 'error', error: 'tag: there is no rendered plate to file yet — render one with still first' } };

    const fields = {
      name: String(input.name).trim(),
      role: input.role || 'character',
      plateUrl: url,
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

export const TOOLS = { read, write, order, choose, compose, direct, tag, ...GATED };

// §4's rows. An agent can only reach the tools its kind holds; the gate enforces it.
export const TOOLS_BY_KIND = {
  shot:       ['read', 'write', 'order', 'choose', 'compose', 'direct', 'still', 'shoot'],
  edit:       ['read', 'choose', 'direct', 'edit', 'shoot'],
  storyboard: ['read', 'write', 'order', 'compose', 'still'],
  bible:      ['read', 'write', 'compose', 'still', 'tag'],
  audio:      ['read', 'write'],
};

export const describeTools = (names) => names
  .map((n) => TOOLS[n]?.describe)
  .filter(Boolean)
  .map((d) => `- ${d}`)
  .join('\n');
