import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../../agents/tools/index.js';

test('tag refuses a plate with no role rather than assuming "character"', () => {
  assert.match(TOOLS.tag.validate({ name: 'the clearing' }), /needs a "role"/);
  assert.match(TOOLS.tag.validate({ name: 'x', role: 'backdrop' }), /must be character/);
  assert.equal(TOOLS.tag.validate({ name: 'the clearing', role: 'location' }), null);
});

test('an unknown model slot is refused, never accepted and quietly bound to nothing', () => {
  assert.match(TOOLS.write.validate({ model: 'storyboard' }), /is not a model slot/);
  assert.equal(TOOLS.write.validate({ model: 'seedance25' }), null);
});

test('write cannot set a prompt — that is compose, under the bound spec', () => {
  assert.match(TOOLS.write.validate({ prompt: 'a wolf' }), /compose/);
});

test('a gated tool refuses to prepare a card when the prompt is missing', () => {
  const out = TOOLS.shoot.prepare({
    input: {},
    project: { film: { shots: [] }, bible: [], threads: [] },
    thread: { id: 't', kind: 'shot', subjectId: null },
  });
  assert.ok(out.error, 'must refuse, not invent a subject');
});

test('sequence-owned shots refuse other agents', async () => {
  const { insertShot, latchThread, makeProject } = await import('../../state/project.js');
  let p = makeProject();
  const made = insertShot(p, { fields: { title: 'owned', ownedBy: 'seq_1', takes: [{ id: 'tk1' }], chosenTakeId: 'tk1', prompt: 'x' } });
  p = made.project;
  assert.throws(() => latchThread(p, p.threads[0].id, 'edit', { subjectId: made.shot.id }), /belongs to sequence/);
  const order = TOOLS.order.run({ input: { remove: made.shot.id }, project: p, thread: null });
  assert.match(order.output.error, /belongs to sequence/);
  const choose = TOOLS.choose.run({ input: { shot: made.shot.id, take: 'tk1' }, project: p, thread: null });
  assert.match(choose.output.error, /belongs to sequence/);
});
