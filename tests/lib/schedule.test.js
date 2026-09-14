import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chainsOf, dependenciesOf, invalidationOf, nodeIds, runSchedule, successorsOf, validateManifest,
} from '../../agents/director/schedule.js';

const manifest = () => ({
  targetSeconds: 30,
  plates: [{ entity: 'FIGURE-1' }, { entity: 'PLACE-1' }],
  shots: [
    { id: 's1', seconds: 6, join: null },
    { id: 's2', seconds: 6, join: 'cut' },
    { id: 's3', seconds: 6, join: 'continuous' },
    { id: 's4', seconds: 6, join: 'continuous' },
    { id: 's5', seconds: 6, join: 'cut' },
  ],
});

const plan = () => ({ shots: manifest().shots.map((sh) => ({ ...sh, keyframe: { needed: sh.join !== 'continuous', reason: 'test' } })) });

const policy = (over = {}) => ({ attempts: { fault: 2, shot: 3 }, resume: { backoffMs: 0 }, ...over });

const completeDone = async (id, { error, faults }) => ({ status: 'done', value: { completed: id, faults, after: error.message } });

const doneValue = (id, n) => {
  const [kind, sid] = id.split(':');
  if (kind === 'shoot') return { taskId: `task-${sid}-${n}`, promptUsed: 'p', silent: false, reservationId: `res-${sid}-${n}`, takeId: `take-${sid}-${n}`, url: `/${sid}-${n}.mp4`, lastFrameUrl: `/${sid}-${n}.jpg` };
  if (kind === 'keyframe') return { needed: true, url: `/kf-${sid}-${n}.png`, candidateId: `cand-${sid}-${n}` };
  if (kind === 'measure') return { firstHash: 'a', lastHash: 'b' };
  return { id, n };
};

const graph = () => {
  const store = {};
  const journal = { entries: [], write(kind, data) { this.entries.push({ kind, ...data }); return { step: this.entries.length, at: 'now' }; }, cost(row) { this.entries.push({ ...row, kind: 'cost' }); } };
  const nodes = {
    get: (id) => store[id] || { status: 'pending', attempts: 0, value: null },
    set: (id, patch) => { store[id] = { ...nodes.get(id), ...patch }; },
  };
  const pending = new Map();
  const starts = [];
  const ends = [];
  const runs = {};
  const run = (id) => new Promise((resolve, reject) => {
    runs[id] = (runs[id] || 0) + 1;
    starts.push(id);
    pending.set(id, { resolve, reject, n: runs[id] });
  });
  const tick = async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0)); };
  const running = () => [...pending.keys()];
  const finish = async (id, outcome) => {
    const p = pending.get(id);
    if (!p) throw new Error(`${id} is not running (running: ${running().join(', ') || 'nothing'})`);
    pending.delete(id);
    ends.push(id);
    p.resolve(outcome || { status: 'done', value: doneValue(id, p.n) });
    await tick();
  };
  const fail = async (id, message) => {
    const p = pending.get(id);
    pending.delete(id);
    ends.push(id);
    p.reject(new Error(message));
    await tick();
  };
  const finishAll = async (pick = () => null) => {
    while (running().length) {
      const id = running()[0];
      await finish(id, pick(id, pending.get(id).n));
    }
  };
  return { store, journal, nodes, run, tick, running, finish, fail, finishAll, starts, ends, runs };
};

const launch = (g, over = {}) => {
  const p = runSchedule({
    manifest: manifest(), plan: plan(), flow: 'policy', policy: policy(), concurrency: { stills: 4, chains: 3, judge: 4 },
    nodes: g.nodes, run: g.run, complete: completeDone, journal: g.journal, ...over,
  });
  return p;
};

test('the graph names its nodes and dependencies as the contract says', () => {
  const m = manifest();
  assert.deepEqual(chainsOf(m), [['s1'], ['s2', 's3', 's4'], ['s5']]);
  assert.deepEqual(successorsOf(m, 's2'), ['s3', 's4']);
  assert.deepEqual(successorsOf(m, 's4'), []);
  assert.deepEqual(dependenciesOf(m, 'plate:FIGURE-1', { flow: 'policy' }), []);
  assert.deepEqual(dependenciesOf(m, 'keyframe:s2', { flow: 'policy' }), ['plate:FIGURE-1', 'plate:PLACE-1']);
  assert.deepEqual(dependenciesOf(m, 'shoot:s2', { flow: 'policy' }), ['shots', 'keyframe:s2']);
  assert.deepEqual(dependenciesOf(m, 'shoot:s3', { flow: 'policy' }), ['shots', 'shoot:s2']);
  assert.deepEqual(dependenciesOf(m, 'measure:s3', { flow: 'policy' }), ['shoot:s3']);
  assert.deepEqual(dependenciesOf(m, 'qc:s3', { flow: 'policy' }), ['measure:s3']);
  assert.deepEqual(dependenciesOf(m, 'chain:s3', { flow: 'policy' }), ['measure:s2', 'measure:s3']);
  assert.deepEqual(dependenciesOf(m, 'assemble', { flow: 'policy' }), ['qc:s1', 'qc:s2', 'qc:s3', 'qc:s4', 'qc:s5', 'chain:s2', 'chain:s3', 'chain:s4', 'chain:s5']);
  assert.deepEqual(dependenciesOf(m, 'final', { flow: 'policy' }), ['assemble']);
  assert.deepEqual(dependenciesOf(m, 'shoot:s3', { flow: 'card' }), ['shots', 'measure:s2'], 'the approved-card walk spends on the next shot only after the previous take is measured');
  assert.ok(!nodeIds(m, { flow: 'card' }).some((id) => id.startsWith('keyframe:') || id.startsWith('qc:')));
  assert.ok(nodeIds(m, { flow: 'policy' }).includes('qc:s5'));
  assert.deepEqual(invalidationOf(m, 's2', { flow: 'policy', mode: 'new-candidate' }), {
    own: ['keyframe:s2', 'shoot:s2', 'measure:s2', 'qc:s2'],
    successors: ['shoot:s3', 'measure:s3', 'qc:s3', 'shoot:s4', 'measure:s4', 'qc:s4'],
    joins: ['chain:s2', 'chain:s3', 'chain:s4', 'chain:s5'],
    invalidatedShots: ['s3', 's4'],
  });
  assert.throws(() => validateManifest({ shots: [{ id: 's1' }, { id: 's2' }] }), /declare no join/);
  assert.throws(() => validateManifest({ shots: [{ id: 1 }, { id: 2, join: 'cut' }] }), /not in the manifest by name/);
});

test('dependency order is respected: no node starts before every dependency has finished', async () => {
  const g = graph();
  const done = launch(g);
  await g.tick();
  await g.finishAll();
  const result = await done;
  assert.equal(result.status, 'done');
  const m = manifest();
  const ids = nodeIds(m, { flow: 'policy' });
  assert.deepEqual([...g.starts].sort(), [...ids].sort(), 'every node ran exactly once');
  for (const id of ids) {
    for (const dep of dependenciesOf(m, id, { flow: 'policy' })) {
      assert.ok(g.ends.indexOf(dep) < g.starts.indexOf(id), `${id} started before ${dep} finished`);
    }
  }
  assert.equal(g.starts.at(-1), 'final');
  assert.ok(g.journal.entries.some((e) => e.kind === 'schedule' && e.event === 'complete'));
});

test('cut shots run in parallel after the plates, longest chain first under the chains cap', async () => {
  const g = graph();
  const done = launch(g, { concurrency: { stills: 2, chains: 2, judge: 4 } });
  await g.tick();
  assert.deepEqual([...g.running()].sort(), ['plate:FIGURE-1', 'plate:PLACE-1', 'shots'], 'plates depend on nothing');
  await g.finish('shots');
  await g.finish('plate:FIGURE-1');
  assert.ok(!g.running().some((id) => id.startsWith('keyframe:')), 'keyframes wait for every plate');
  await g.finish('plate:PLACE-1');
  assert.deepEqual([...g.running()].sort(), ['keyframe:s1', 'keyframe:s2', 'keyframe:s3', 'keyframe:s4'], 'two cut shots storyboard at once under the stills cap; the continuous shots’ keyframe nodes only record their decision and take no still slot');
  await g.finish('keyframe:s3', { status: 'done', value: { needed: false, url: null, candidateId: null } });
  await g.finish('keyframe:s4', { status: 'done', value: { needed: false, url: null, candidateId: null } });
  assert.ok(!g.running().includes('keyframe:s5'), 's5 waits for a still slot');
  await g.finish('keyframe:s1');
  assert.ok(g.running().includes('keyframe:s5'));
  await g.finish('keyframe:s2');
  assert.deepEqual([...g.running()].sort(), ['keyframe:s5', 'shoot:s1', 'shoot:s2'], 'two cut shots shoot in parallel under a chains cap of 2');
  await g.finish('keyframe:s5');
  assert.ok(!g.running().includes('shoot:s5'), 'the third chain waits for a chain slot');
  await g.finish('shoot:s1');
  await g.finish('measure:s1');
  await g.finish('qc:s1');
  assert.ok(g.running().includes('shoot:s5'), 's5 enters when a chain slot frees');
  await g.finishAll();
  assert.equal((await done).status, 'done');
});

test('when a chain slot frees, the longest waiting chain is admitted first', async () => {
  const g = graph();
  const done = launch(g, { concurrency: { stills: 4, chains: 1, judge: 4 } });
  await g.tick();
  await g.finish('shots');
  await g.finish('plate:FIGURE-1');
  await g.finish('plate:PLACE-1');
  await g.finish('keyframe:s3', { status: 'done', value: { needed: false, url: null, candidateId: null } });
  await g.finish('keyframe:s4', { status: 'done', value: { needed: false, url: null, candidateId: null } });
  await g.finish('keyframe:s1');
  assert.deepEqual([...g.running()].sort(), ['keyframe:s2', 'keyframe:s5', 'shoot:s1'], 'one chain in flight');
  await g.finish('keyframe:s5');
  await g.finish('keyframe:s2');
  assert.ok(!g.running().includes('shoot:s2') && !g.running().includes('shoot:s5'), 'both cut shots wait for the single chain slot');
  await g.finish('shoot:s1');
  await g.finish('measure:s1');
  await g.finish('qc:s1');
  assert.ok(g.running().includes('shoot:s2') && !g.running().includes('shoot:s5'), 'the s2-s3-s4 chain (length 3) outranks s5 (length 1) for the freed slot');
  await g.finishAll();
  assert.equal((await done).status, 'done');
});

test('a continuous chain serializes on the previous take while its measure and QC overlap the next shoot', async () => {
  const g = graph();
  const done = launch(g);
  await g.tick();
  await g.finish('shots');
  await g.finish('plate:FIGURE-1');
  await g.finish('plate:PLACE-1');
  await g.finish('keyframe:s1');
  await g.finish('keyframe:s2');
  await g.finish('keyframe:s5');
  assert.ok(!g.running().includes('shoot:s3'), 's3 cannot start before s2 has a last frame');
  await g.finish('shoot:s2');
  assert.ok(g.running().includes('shoot:s3'), 's3 starts from s2’s recorded last frame');
  assert.ok(g.running().includes('measure:s2'), 'the measure of s2 overlaps the shoot of s3');
  assert.ok(!g.running().includes('shoot:s4'), 's4 waits for s3');
  await g.finish('shoot:s3');
  assert.ok(g.running().includes('shoot:s4'));
  await g.finishAll();
  assert.equal((await done).status, 'done');
  assert.ok(g.ends.indexOf('shoot:s2') < g.starts.indexOf('shoot:s3') && g.ends.indexOf('shoot:s3') < g.starts.indexOf('shoot:s4'));
});

test('a failing QC regenerates (same keyframe, then a new candidate) and on exhaustion the best take is promoted', async () => {
  const g = graph();
  const done = launch(g, { concurrency: { stills: 4, chains: 5, judge: 4 } });
  await g.tick();
  await g.finish('shots');
  await g.finish('plate:FIGURE-1');
  await g.finish('plate:PLACE-1');
  await g.finish('keyframe:s1');
  await g.finish('keyframe:s2');
  await g.finish('keyframe:s5');
  await g.finish('shoot:s2');
  await g.finish('measure:s2');
  await g.finish('qc:s2', { status: 'regenerate', shotId: 's2', mode: 'same-keyframe', n: 1, cause: 'E-QC-MORPHING', ruleId: null });
  assert.equal(g.runs['keyframe:s2'], 1, 'the same keyframe is kept on the first regeneration');
  assert.ok(g.running().includes('shoot:s2'), 's2 re-shoots');
  assert.equal(g.nodes.get('shoot:s2').attempts, 2);
  assert.ok(!g.journal.entries.some((e) => e.kind === 'cost' && e.code === 'E-WASTE-KEYFRAME-REJECTED'), 'a same-keyframe regeneration retires no candidate');
  await g.finish('shoot:s2');
  await g.finish('measure:s2');
  await g.finish('qc:s2', { status: 'regenerate', shotId: 's2', mode: 'new-candidate', n: 2, cause: 'E-QC-EXTRA-LIMB', ruleId: null });
  assert.ok(g.running().includes('keyframe:s2'), 'the second regeneration asks for a new candidate');
  assert.deepEqual(g.nodes.get('keyframe:s2').rejected, ['cand-s2-1'], 'the losing keyframe is recorded as rejected');
  const retired = g.journal.entries.filter((e) => e.kind === 'cost' && e.code === 'E-WASTE-KEYFRAME-REJECTED');
  assert.deepEqual(retired.map((e) => [e.disposition, e.nodeId, e.shotId, e.candidateId, e.units]), [['wasted', 'keyframe:s2', 's2', 'cand-s2-1', 1]], 'the retired keyframe still is coded as waste');
  assert.match(retired[0].detail, /new candidate after E-QC-EXTRA-LIMB/);
  await g.finish('keyframe:s2');
  assert.equal(g.nodes.get('keyframe:s2').value.candidateId, 'cand-s2-2');
  await g.finish('shoot:s2');
  await g.finish('measure:s2');
  const promote = { taskId: 'task-s2-2', promptUsed: 'p', silent: false, reservationId: 'res-s2-2', takeId: 'take-s2-2', url: '/s2-2.mp4', lastFrameUrl: '/s2-2.jpg' };
  await g.finish('qc:s2', { status: 'done', value: { pass: false, promoted: 'take-s2-2', attempts: 3 }, promote });
  assert.equal(g.nodes.get('shoot:s2').value.takeId, 'take-s2-2', 'the best-scoring take is promoted onto the shoot node');
  assert.equal(g.nodes.get('qc:s2').status, 'done');
  const regenerations = g.journal.entries.filter((e) => e.kind === 'regeneration');
  assert.deepEqual(regenerations.map((r) => [r.mode, r.cause]), [
    ['same-keyframe', 'E-QC-MORPHING'],
    ['new-candidate', 'E-QC-EXTRA-LIMB'],
    ['promote-best', 'promoted take take-s2-2 is not the last take rendered'],
  ]);
  assert.deepEqual(regenerations.map((r) => r.attempt), [1, 2, null], 'each regeneration names the admission it answers');
  assert.deepEqual(regenerations.map((r) => r.n), [1, 2, null], 'each regeneration carries the number its mode was chosen for');
  await g.finishAll();
  assert.equal((await done).status, 'done');
  assert.equal(g.runs['shoot:s2'], 3);
});

test('regenerating a shot invalidates every continuous successor: finished takes are wasted, in-flight takes are discarded, joins are re-measured', async () => {
  const g = graph();
  const done = launch(g);
  await g.tick();
  await g.finish('shots');
  await g.finish('plate:FIGURE-1');
  await g.finish('plate:PLACE-1');
  await g.finish('keyframe:s1');
  await g.finish('keyframe:s2');
  await g.finish('keyframe:s5');
  await g.finish('shoot:s2');
  await g.finish('shoot:s3');
  await g.finish('measure:s3');
  await g.finish('measure:s2');
  await g.finish('chain:s3');
  assert.equal(g.nodes.get('shoot:s3').status, 'done');
  assert.equal(g.nodes.get('chain:s3').status, 'done');
  assert.ok(g.running().includes('shoot:s4'), 's4 is in flight from s3’s last frame');
  await g.finish('qc:s2', { status: 'regenerate', shotId: 's2', mode: 'same-keyframe', n: 1, cause: 'E-QC-FROZEN', ruleId: null });
  assert.equal(g.nodes.get('shoot:s3').status, 'pending');
  assert.equal(g.nodes.get('shoot:s3').value, null);
  assert.equal(g.nodes.get('measure:s3').status, 'pending');
  assert.equal(g.nodes.get('chain:s3').status, 'pending', 'a stale join measurement cannot survive');
  const reg = g.journal.entries.find((e) => e.kind === 'regeneration');
  assert.deepEqual(reg.invalidatedShots, ['s3', 's4']);
  assert.deepEqual(reg.wasted, ['take-s3-1']);
  assert.ok(reg.inFlight.includes('shoot:s4'));
  assert.ok(g.journal.entries.some((e) => e.kind === 'cost' && e.disposition === 'wasted' && e.takeId === 'take-s3-1' && e.reservationId === 'res-s3-1' && e.code === 'E-WASTE-INVALIDATED-SUCCESSOR'));
  await g.finish('shoot:s4');
  assert.equal(g.nodes.get('shoot:s4').status, 'pending', 'the in-flight successor’s take is discarded on arrival');
  assert.ok(g.journal.entries.some((e) => e.kind === 'cost' && e.disposition === 'wasted' && e.takeId === 'take-s4-1'));
  assert.deepEqual(g.nodes.get('shoot:s3').invalidated, ['take-s3-1'], 'the shoot node records the take the schedule invalidated');
  assert.deepEqual(g.nodes.get('shoot:s4').invalidated, ['take-s4-1'], 'the in-flight take discarded on arrival is recorded too');
  assert.ok(!g.running().includes('shoot:s3'), 's3 waits for the new s2 take');
  await g.finish('shoot:s2');
  assert.ok(g.running().includes('shoot:s3'), 's3 re-shoots from the regenerated s2');
  await g.finish('shoot:s3');
  await g.finish('measure:s3');
  assert.equal(g.nodes.get('shoot:s3').attempts, 2, 'the re-shoot is the successor’s second admission');
  await g.finish('qc:s3');
  assert.ok(g.journal.entries.some((e) => e.kind === 'schedule' && e.event === 'invalidated' && e.id === 'qc:s3'), 'the QC that was in flight over the stale take is discarded on arrival');
  assert.ok(g.running().includes('qc:s3'), 'the re-shot take is judged again');
  await g.finish('qc:s3', { status: 'regenerate', shotId: 's3', mode: 'same-keyframe', n: 1, cause: 'E-QC-FROZEN', ruleId: null });
  const successor = g.journal.entries.filter((e) => e.kind === 'regeneration' && e.shotId === 's3');
  assert.deepEqual(successor.map((r) => [r.attempt, r.n, r.mode]), [[2, 1, 'same-keyframe']], 'the invalidated successor’s first regeneration is its second admission but its first counted take, and the row carries both');
  await g.finishAll();
  assert.equal((await done).status, 'done');
  assert.equal(g.runs['shoot:s3'], 3);
  assert.equal(g.runs['shoot:s4'], 3);
  assert.equal(g.runs['chain:s3'], 2, 'the join was never re-measured between the two regenerations — measure:s2 was still in flight');
});

test('a qc or measure node that asks to regenerate without its regeneration number is refused by name', async () => {
  const g = graph();
  const done = launch(g);
  await g.tick();
  await g.finish('shots');
  await g.finish('plate:FIGURE-1');
  await g.finish('plate:PLACE-1');
  await g.finish('keyframe:s1');
  await g.finish('shoot:s1');
  await g.finish('measure:s1');
  const refused = assert.rejects(done, /node "qc:s1" asked to regenerate shot s1 without its regeneration number/);
  await g.finish('qc:s1', { status: 'regenerate', shotId: 's1', mode: 'same-keyframe', cause: 'E-QC-FROZEN', ruleId: null });
  await refused;
});

test('promoting a take that is not the last rendered invalidates continuous successors the same way a regeneration does: their rendered takes are coded as waste', async () => {
  const g = graph();
  const done = launch(g, { concurrency: { stills: 4, chains: 5, judge: 4 } });
  await g.tick();
  await g.finish('shots');
  await g.finish('plate:FIGURE-1');
  await g.finish('plate:PLACE-1');
  await g.finish('keyframe:s1');
  await g.finish('keyframe:s2');
  await g.finish('keyframe:s5');
  await g.finish('shoot:s2');
  await g.finish('measure:s2');
  await g.finish('shoot:s3');
  await g.finish('measure:s3');
  await g.finish('qc:s2', { status: 'regenerate', shotId: 's2', mode: 'same-keyframe', n: 1, cause: 'E-QC-MORPHING', ruleId: null });
  await g.finish('shoot:s4');
  await g.finish('shoot:s2');
  await g.finish('measure:s2');
  await g.finish('shoot:s3');
  await g.finish('measure:s3');
  await g.finish('chain:s3');
  assert.equal(g.nodes.get('shoot:s3').value.takeId, 'take-s3-2');
  assert.ok(g.running().includes('shoot:s4'), 's4 is in flight from s3’s second take');
  const promote = { taskId: 'task-s2-1', promptUsed: 'p', silent: false, reservationId: 'res-s2-1', takeId: 'take-s2-1', url: '/s2-1.mp4', lastFrameUrl: '/s2-1.jpg' };
  await g.finish('qc:s2', { status: 'done', value: { pass: false, promoted: 'take-s2-1', attempts: 2 }, promote });
  assert.equal(g.nodes.get('shoot:s2').value.takeId, 'take-s2-1');
  assert.equal(g.nodes.get('shoot:s3').value, null);
  assert.ok(g.running().includes('shoot:s3'), 's3 re-shoots from the promoted s2 take');
  assert.equal(g.nodes.get('chain:s3').value, null, 'a stale join measurement cannot survive the promotion');
  assert.deepEqual(g.nodes.get('shoot:s3').invalidated, ['take-s3-1', 'take-s3-2'], 'the shoot node records the take the promotion invalidated');
  const reg = g.journal.entries.filter((e) => e.kind === 'regeneration').find((e) => e.mode === 'promote-best');
  assert.deepEqual(reg.invalidatedShots, ['s3', 's4']);
  assert.deepEqual(reg.wasted, ['take-s3-2'], 'the promotion lists the successor take it discarded');
  assert.ok(reg.reset.includes('shoot:s3'));
  assert.ok(reg.inFlight.includes('shoot:s4'), 'the in-flight successor is named too');
  const coded = g.journal.entries.filter((e) => e.kind === 'cost' && e.code === 'E-WASTE-INVALIDATED-SUCCESSOR');
  assert.deepEqual(coded.map((e) => [e.disposition, e.nodeId, e.takeId, e.reservationId, e.units]), [
    ['wasted', 'shoot:s3', 'take-s3-1', 'res-s3-1', 6],
    ['wasted', 'shoot:s4', 'take-s4-1', 'res-s4-1', 6],
    ['wasted', 'shoot:s3', 'take-s3-2', 'res-s3-2', 6],
  ], 'the successor take dropped by the promotion is coded as waste, in seconds of video');
  assert.match(coded[2].detail, /shot s2 promoted take take-s2-1/);
  await g.finish('shoot:s4');
  assert.equal(g.nodes.get('shoot:s4').status, 'pending');
  assert.ok(g.journal.entries.some((e) => e.kind === 'cost' && e.code === 'E-WASTE-INVALIDATED-SUCCESSOR' && e.takeId === 'take-s4-2'));
  await g.finishAll();
  assert.equal((await done).status, 'done');
  assert.equal(g.runs['shoot:s3'], 3);
});

test('faults: the approved-card flow halts at the node; the policy flow retries within policy.attempts.fault after the policy backoff and then completes the node by name, never halting', async () => {
  const card = graph();
  const cardRun = runSchedule({
    manifest: manifest(), plan: plan(), flow: 'card', policy: null, concurrency: { stills: 1, chains: 1, judge: 1 },
    nodes: card.nodes, run: card.run, journal: card.journal,
  });
  await card.tick();
  await card.finish('shots');
  await card.fail('plate:FIGURE-1', 'the provider hung up');
  const halted = await cardRun;
  assert.equal(halted.status, 'halted');
  assert.deepEqual(halted.halted, { node: 'plate:FIGURE-1', reason: 'the provider hung up', ruleId: null });
  assert.equal(card.runs['plate:FIGURE-1'], 1, 'no retry without a policy');

  const g = graph();
  const completions = [];
  const done = launch(g, { complete: async (id, info) => { completions.push([id, info.faults, info.error.message]); return { status: 'done', value: { completed: true } }; } });
  await g.tick();
  await g.fail('plate:FIGURE-1', 'the provider hung up');
  assert.equal(g.runs['plate:FIGURE-1'], 2, 'a fault retries under the policy');
  assert.ok(g.journal.entries.some((e) => e.kind === 'fault' && e.faults === 1 && e.budget === 2 && e.backoffMs === 0), 'the fault names its budget and the policy backoff');
  await g.fail('plate:FIGURE-1', 'the provider hung up again');
  assert.equal(g.runs['plate:FIGURE-1'], 2, 'no third attempt past the fault budget');
  assert.deepEqual(completions, [['plate:FIGURE-1', 2, 'the provider hung up again']], 'the exhausted node is handed to the completion with its fault count');
  assert.ok(g.journal.entries.some((e) => e.kind === 'schedule' && e.event === 'exhausted' && e.id === 'plate:FIGURE-1' && e.faults === 2 && e.budget === 2));
  assert.equal(g.nodes.get('plate:FIGURE-1').status, 'done', 'the completion stands in for the faulted node');
  assert.deepEqual(g.nodes.get('plate:FIGURE-1').value, { completed: true });
  await g.finishAll();
  const out = await done;
  assert.equal(out.status, 'done', 'the pass completes with the shortfall named, never halts after intake');
  assert.ok(g.starts.some((id) => id.startsWith('keyframe:')), 'the pass goes on from the completed node');

  const h = graph();
  const failing = launch(h, { complete: async () => { throw new Error('E-COMPLETION-PLATE: nothing rendered to promote'); } });
  await h.tick();
  await h.fail('plate:FIGURE-1', 'the provider hung up');
  await h.fail('plate:FIGURE-1', 'the provider hung up again');
  await h.finishAll();
  const refused = await failing;
  assert.equal(refused.status, 'halted', 'a completion that refuses by name is the one halt the policy flow knows');
  assert.equal(refused.halted.node, 'plate:FIGURE-1');
  assert.match(refused.halted.reason, /the provider hung up again \(2 faults, budget 2\).*E-COMPLETION-PLATE/);
  assert.ok(h.journal.entries.some((e) => e.kind === 'schedule' && e.event === 'completion-failed' && e.id === 'plate:FIGURE-1'));
  assert.ok(!h.starts.some((id) => id.startsWith('keyframe:')), 'nothing new is admitted after the halt');
});

test('the schedule refuses a missing plan, mismatched flow and policy, and caps that are not positive integers', async () => {
  const g = graph();
  await assert.rejects(() => launch(g, { plan: null }), /needs the plan/);
  await assert.rejects(() => launch(g, { flow: 'card' }), /carries no policy/);
  await assert.rejects(() => launch(g, { policy: null }), /needs the policy values/);
  await assert.rejects(() => launch(g, { policy: policy({ resume: {} }) }), /policy\.resume\.backoffMs/);
  await assert.rejects(() => launch(g, { complete: undefined }), /needs a completion/);
  await assert.rejects(() => launch(g, { concurrency: { stills: 4, chains: 0, judge: 4 } }), /concurrency\.chains/);
  await assert.rejects(() => launch(g, { concurrency: { stills: 4, chains: 3 } }), /concurrency\.judge/);
});
