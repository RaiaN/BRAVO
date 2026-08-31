import {
  appendCorrection, appendNote, sequenceById, setNoteDisposition, setSequenceFields,
} from '../../state/project.js';

const seqOf = (project, thread) => (['director', 'critic'].includes(thread?.kind) ? sequenceById(project, thread.subjectId) : null);
const latestIteration = (seq) => (seq?.iterations?.length ? seq.iterations[seq.iterations.length - 1] : null);

export const note = {
  name: 'note',
  gated: false,
  describe: 'note — { "text", "shotRef"?, "timecode"?, "ruleRef"?, "severity": "blocker"|"note"|"taste" }. Files the person\'s verdict on the latest iteration as ground truth. Their words, not yours — never paraphrase away specifics.',
  validate: (input) => {
    if (!String(input.text || '').trim()) return 'note: needs the person\'s words in "text"';
    if (!['blocker', 'note', 'taste'].includes(input.severity)) return 'note: severity must be blocker, note or taste';
    return null;
  },
  run: ({ input, project, thread }) => {
    const seq = seqOf(project, thread);
    if (!seq) return { project, cost: 0, output: { kind: 'error', error: 'this thread owns no sequence' } };
    const it = latestIteration(seq);
    if (!it) return { project, cost: 0, output: { kind: 'error', error: 'no iteration exists yet — notes attach to a finished run' } };
    const record = {
      text: String(input.text).trim(),
      shotRef: input.shotRef || null,
      timecode: input.timecode || null,
      ruleRef: input.ruleRef || null,
      severity: input.severity,
    };
    const next = appendNote(project, seq.id, it.id, record);
    const saved = sequenceById(next, seq.id).iterations.at(-1).notes.at(-1);
    return { project: next, cost: 0, output: { kind: 'note', sequenceId: seq.id, iterationId: it.id, note: saved } };
  },
};

const PATCHABLE = /^(brief\.(logline|world|constraints|beats|seed)|plan\.shots\[(\d+)\]\.(prompt|moment|setup|side|seconds|location))$/;
const FORBIDDEN = /rule|gate|threshold|theta|tolerance|retry|manifest|iteration|status/i;

const getPath = (obj, path) => {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  return parts.reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
};

const setPath = (obj, path, value) => {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  let cur = clone;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    cur[k] = Array.isArray(cur[k]) ? [...cur[k]] : { ...cur[k] };
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return clone;
};

export const patch = {
  name: 'patch',
  gated: false,
  describe: 'patch — { "noteIds": [""], "changes": [{ "path": "brief.world" | "plan.shots[0].prompt" | …, "to": <value> }] }. Applies input corrections for the NEXT iteration. Only brief and shot-plan input fields are patchable; rules, gates and past records are not yours.',
  validate: (input) => {
    if (!Array.isArray(input.changes) || !input.changes.length) return 'patch: needs "changes"';
    for (const c of input.changes) {
      if (FORBIDDEN.test(String(c.path))) return `patch: "${c.path}" is law or record, not input — refused`;
      if (!PATCHABLE.test(String(c.path))) return `patch: "${c.path}" is not a next-iteration input field`;
    }
    if (!Array.isArray(input.noteIds) || !input.noteIds.length) return 'patch: name the "noteIds" this corrects — corrections trace to ground truth';
    return null;
  },
  run: ({ input, project, thread }) => {
    const seq = seqOf(project, thread);
    if (!seq) return { project, cost: 0, output: { kind: 'error', error: 'this thread owns no sequence' } };
    const it = latestIteration(seq);
    if (!it) return { project, cost: 0, output: { kind: 'error', error: 'no iteration to correct' } };
    const known = new Set(it.notes.map((n) => n.id));
    const missing = input.noteIds.filter((id) => !known.has(id));
    if (missing.length) return { project, cost: 0, output: { kind: 'error', error: `patch: notes not on this iteration: ${missing.join(', ')}` } };

    const applied = [];
    let brief = seq.brief;
    let plan = seq.plan;
    for (const c of input.changes) {
      const root = c.path.startsWith('brief.') ? { brief } : { plan };
      const from = getPath(root, c.path);
      if (c.path.startsWith('brief.')) brief = setPath({ brief }, c.path, c.to).brief;
      else plan = setPath({ plan }, c.path, c.to).plan;
      applied.push({ path: c.path, from: from === undefined ? null : from, to: c.to });
    }

    let next = setSequenceFields(project, seq.id, { brief, plan, status: 'planned', run: null });
    next = appendCorrection(next, seq.id, it.id, { noteIds: input.noteIds, kind: 'patch', patch: applied });
    for (const id of input.noteIds) next = setNoteDisposition(next, seq.id, it.id, id, 'patched');
    return {
      project: next,
      cost: 0,
      output: { kind: 'correction', correction: 'patch', applied, note: 'inputs updated for the next iteration — the manifest changed, so the next run needs a fresh approval' },
    };
  },
};

const RULE_SHAPE = /^[A-Z]{3}-\d{3}$/;

export const propose = {
  name: 'propose',
  gated: false,
  describe: 'propose — { "noteIds": [""], "rule": { "id", "title", "statement", "class": "plan"|"measure"|"judgment", "appliesTo", "blocking": false } }. Proposes a NEW rule learned from a note. Proposals never activate themselves: the director approves them into the rulebook, or they stay proposals.',
  validate: (input) => {
    const r = input.rule;
    if (!r) return 'propose: needs a "rule"';
    if (!RULE_SHAPE.test(r.id || '')) return 'propose: rule id must look like XXX-000';
    if (!['plan', 'measure', 'judgment'].includes(r.class)) return 'propose: class must be plan, measure or judgment';
    if (r.blocking) return 'propose: a proposal is never blocking on arrival — calibration and the director\'s signature come first';
    if (!Array.isArray(input.noteIds) || !input.noteIds.length) return 'propose: name the "noteIds" this learns from';
    return null;
  },
  run: ({ input, project, thread }) => {
    const seq = seqOf(project, thread);
    if (!seq) return { project, cost: 0, output: { kind: 'error', error: 'this thread owns no sequence' } };
    const it = latestIteration(seq);
    if (!it) return { project, cost: 0, output: { kind: 'error', error: 'no iteration to learn from' } };
    const proposal = {
      ...input.rule,
      blocking: false,
      status: 'proposed',
      provenance: { origin: 'note', iteration: it.id, note: input.noteIds[0] },
    };
    let next = appendCorrection(project, seq.id, it.id, { noteIds: input.noteIds, kind: 'ruleProposal', proposal });
    for (const id of input.noteIds) next = setNoteDisposition(next, seq.id, it.id, id, 'ruled');
    return { project: next, cost: 0, output: { kind: 'correction', correction: 'ruleProposal', proposal } };
  },
};

export const regression = {
  name: 'regression',
  gated: false,
  describe: 'regression — { "noteIds": [""], "case": { "name", "input", "expectation" } }. Files a note as a permanent regression case for the harness suite.',
  validate: (input) => {
    const c = input.case;
    if (!c || !String(c.name || '').trim() || !String(c.input || '').trim() || !String(c.expectation || '').trim()) {
      return 'regression: needs a "case" with name, input and expectation';
    }
    if (!Array.isArray(input.noteIds) || !input.noteIds.length) return 'regression: name the "noteIds"';
    return null;
  },
  run: ({ input, project, thread }) => {
    const seq = seqOf(project, thread);
    if (!seq) return { project, cost: 0, output: { kind: 'error', error: 'this thread owns no sequence' } };
    const it = latestIteration(seq);
    if (!it) return { project, cost: 0, output: { kind: 'error', error: 'no iteration to learn from' } };
    let next = appendCorrection(project, seq.id, it.id, { noteIds: input.noteIds, kind: 'regression', case: input.case });
    for (const id of input.noteIds) next = setNoteDisposition(next, seq.id, it.id, id, 'regression');
    return { project: next, cost: 0, output: { kind: 'correction', correction: 'regression', case: input.case } };
  },
};
