import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../agents/index.js';
import {
  agentFor, allAgents, defineAgent, enabledAgents, explainMissing, isEnabled, setEnabled,
} from '../../agents/registry.js';

test('every registered agent satisfies the module contract', () => {
  for (const a of allAgents()) {
    assert.ok(a.id && a.title && a.job, `${a.id}: missing identity`);
    assert.ok(Array.isArray(a.tools), `${a.id}: tools must be a list`);
    assert.equal(typeof a.system, 'function', `${a.id}: system() required`);
    assert.equal(typeof a.context, 'function', `${a.id}: context() required`);
    assert.ok(a.system().length > 100, `${a.id}: system prompt looks empty`);
  }
});

test('defineAgent refuses an incomplete module rather than half-registering it', () => {
  assert.throws(() => defineAgent({ id: 'broken' }), /missing/);
});

test('an unknown kind resolves to nothing, never to a default agent', () => {
  assert.equal(agentFor('nonsense'), null);
  assert.equal(agentFor(null), null);
  assert.match(explainMissing('nonsense'), /no "nonsense" agent/);
});

test('audio ships switched off, because `speak` is not built', () => {
  assert.equal(isEnabled('audio'), false);
  assert.equal(agentFor('audio'), null);
  assert.match(explainMissing('audio'), /switched off/);
  assert.ok(!enabledAgents().some((a) => a.id === 'audio'));
});

test('disabling an agent removes it from the roster the router sees', () => {
  assert.ok(enabledAgents().some((a) => a.id === 'storyboard'));
  setEnabled('storyboard', false);
  assert.equal(agentFor('storyboard'), null, 'a disabled agent must not run');
  assert.ok(!enabledAgents().some((a) => a.id === 'storyboard'), 'nor be offered to the router');
  setEnabled('storyboard', true);
  assert.ok(agentFor('storyboard'), 'and comes back when switched on');
});

test('an agent module owns its own tool row — the engine cannot widen it', () => {
  const shot = agentFor('shot');
  assert.ok(shot.tools.includes('compose'));
  assert.ok(!shot.tools.includes('tag'), 'tag belongs to the bible agent');
  assert.ok(agentFor('bible').tools.includes('tag'));
  assert.ok(!agentFor('edit').tools.includes('still'), 'edit does not render stills');
});

test('every registered agent latches a thread without a silent no-op', async () => {
  const { latchThread, makeProject } = await import('../../state/project.js');
  for (const a of allAgents()) {
    let p = makeProject();
    const threadId = p.threads[0].id;
    const made = a.latch ? a.latch({ project: p, title: 't', videoSlot: 'seedance25', imageSlot: 'seedream' }) : { project: p, subjectId: null };
    p = made.project;
    const r = latchThread(p, threadId, a.id, { subjectId: made.subjectId, title: 't' });
    assert.equal(r.thread.kind, a.id, `${a.id} failed to latch`);
  }
  const fresh = makeProject();
  assert.throws(() => latchThread(fresh, fresh.threads[0].id, ''), /not a thread kind/);
});
