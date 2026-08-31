import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendIteration, appendNote, latchThread, makeProject, makeSequence, sequenceById, touch,
} from '../../state/project.js';
import { TOOLS } from '../../agents/tools/index.js';
import '../../agents/index.js';

const seeded = () => {
  let p = makeProject();
  const seq = makeSequence({
    brief: { logline: 'A crosses.', targetSeconds: 12, format: { fps: 24, audio: true }, cast: [{ name: 'A', bibleEntryId: 'new' }], locations: [{ name: 'P', bibleEntryId: 'new' }], dramatis: { protagonist: 'A', want: 'x', opposition: 'y' }, world: '', constraints: [], seed: null },
    plan: { slot: 'seedance25', shots: [{ id: 's1', prompt: 'First.', seconds: 6, setup: 'Wide Establisher', side: 'L', location: 'P', beatId: 'b1' }, { id: 's2', prompt: 'Second.', seconds: 6, setup: 'Close-Up', side: 'L', location: 'P', beatId: 'b2' }], plates: [] },
    status: 'assembled',
  });
  p = touch({ ...p, sequences: [seq] });
  p = appendIteration(p, seq.id, { id: 'it1', notes: [], corrections: [], gates: [], measurements: {}, cost: {}, status: 'assembled' });
  p = appendNote(p, seq.id, 'it1', { text: 'shot 2 opens too settled — the cut should land mid-movement', severity: 'note' });
  const noteId = sequenceById(p, seq.id).iterations[0].notes[0].id;
  const thread = { id: 't', kind: 'critic', subjectId: seq.id, messages: [] };
  return { p, seq, noteId, thread };
};

test('patch applies only next-iteration input fields, resets the run, and traces to notes', () => {
  const { p, seq, noteId, thread } = seeded();
  const r = TOOLS.patch.run({
    input: { noteIds: [noteId], changes: [{ path: 'plan.shots[1].prompt', to: 'Second, already moving.' }] },
    project: p,
    thread,
  });
  const q = sequenceById(r.project, seq.id);
  assert.equal(q.plan.shots[1].prompt, 'Second, already moving.');
  assert.equal(q.plan.shots[0].prompt, 'First.');
  assert.equal(q.status, 'planned');
  assert.equal(q.run, null, 'a patched plan needs fresh approval — the old run state is void');
  assert.equal(q.iterations[0].corrections[0].kind, 'patch');
  assert.equal(q.iterations[0].corrections[0].patch[0].from, 'Second.');
  assert.equal(q.iterations[0].notes[0].disposition, 'patched');
});

test('patch refuses law, records, and unknown paths outright', () => {
  const checks = [
    ['plan.shots[0].threshold', /law or record/],
    ['rulebookVersion', /law or record|not a next-iteration/],
    ['iterations[0].gates', /law or record/],
    ['brief.format.fps', /not a next-iteration/],
    ['status', /law or record/],
  ];
  for (const [path, re] of checks) {
    assert.match(TOOLS.patch.validate({ noteIds: ['n'], changes: [{ path, to: 1 }] }), re, path);
  }
  assert.match(TOOLS.patch.validate({ changes: [{ path: 'brief.world', to: 'x' }] }), /noteIds/);
});

test('a proposal is never blocking, carries provenance, and does not touch the rulebook', () => {
  const { p, seq, noteId, thread } = seeded();
  assert.match(TOOLS.propose.validate({ noteIds: [noteId], rule: { id: 'CIN-101', title: 't', statement: 's', class: 'measure', appliesTo: 'joins', blocking: true } }), /never blocking/);
  const r = TOOLS.propose.run({
    input: { noteIds: [noteId], rule: { id: 'CIN-101', title: 'Cut on movement', statement: 'A join lands mid-movement.', class: 'judgment', appliesTo: 'joins', blocking: false } },
    project: p,
    thread,
  });
  const q = sequenceById(r.project, seq.id);
  const cor = q.iterations[0].corrections[0];
  assert.equal(cor.proposal.status, 'proposed');
  assert.deepEqual(cor.proposal.provenance, { origin: 'note', iteration: 'it1', note: noteId });
  assert.equal(q.iterations[0].notes[0].disposition, 'ruled');
});

test('a note on a missing iteration or unknown note id is refused', () => {
  const { p, thread } = seeded();
  const bad = TOOLS.patch.run({ input: { noteIds: ['note_nope'], changes: [{ path: 'brief.world', to: 'x' }] }, project: p, thread });
  assert.match(bad.output.error, /notes not on this iteration/);
  const fresh = makeProject();
  const empty = TOOLS.note.run({ input: { text: 'x', severity: 'note' }, project: fresh, thread: { id: 't', kind: 'director', subjectId: null, messages: [] } });
  assert.match(empty.output.error, /owns no sequence/);
});

test('the critic row physically excludes render and gate machinery', async () => {
  const { agentFor } = await import('../../agents/registry.js');
  const row = agentFor('critic').tools;
  for (const banned of ['shoot', 'still', 'edit', 'sequence', 'write', 'compose', 'brief', 'breakdown']) {
    assert.ok(!row.includes(banned), `critic must not hold ${banned}`);
  }
});
