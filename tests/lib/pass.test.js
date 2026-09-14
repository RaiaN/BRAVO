import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDeployModels } from '../../utils/film/suiteConfig.js';
import { openJournal, validateCost } from '../../agents/journal.js';
import { generateCandidates, scoreCandidate } from '../../agents/director/candidates.js';
import { takeQC } from '../../agents/director/qc.js';
import { NODES } from '../../agents/director/nodes.js';
import {
  POLICY, STYLE, makePassWire, passClient, passJournal, passRubrics, resumePass, runFullPass,
} from './wire-stub.js';

applyDeployModels({ seedance25: 'test-sd25', seedance: 'test-sd', seedream: 'test-sr', seedreamPro: 'test-srp', reasoner: 'test-r' });

const IDEA = 'a figure races the tide to a locked door';
const made = [];
const opened = [];
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bravo-pass-'));
  made.push(dir);
  return dir;
};
after(async () => {
  for (const journal of opened) await journal.close();
  made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

const policyWith = (patch) => { const p = POLICY(); patch(p); return p; };

const filmPass = async ({ behaviors = {}, policy = POLICY() } = {}) => {
  const dir = fresh();
  const runId = `run-${path.basename(dir)}`;
  const wire = makePassWire({ behaviors });
  const journal = await passJournal({ dir, runId });
  opened.push(journal);
  wire.install();
  try {
    const handle = await runFullPass({ idea: IDEA, wire, journal, runId, policy });
    return { handle, wire, journal, dir, runId };
  } finally {
    wire.restore();
  }
};

const data = (journal, kind) => journal.entries(kind).map((r) => r.data);
const kindsOf = (journal) => journal.entries().reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] || 0) + 1 }), {});
const faultsOf = (journal) => data(journal, 'fault').map((f) => `${f.id}: ${f.reason}`);
const assembled = (handle, journal) => {
  const q = handle.seq();
  assert.equal(handle.status, 'assembled', `the pass did not assemble — halted: ${JSON.stringify(q.run.halted || null)}; faults: ${JSON.stringify(faultsOf(journal).slice(0, 3))}`);
  return q;
};
const firstFrame = (b) => b.content.find((c) => c.role === 'first_frame')?.image_url?.url || null;
const references = (b) => b.content.filter((c) => c.role === 'reference_image');
const tolerance = (seq) => Math.max(0.5, 0.06 * seq.plan.shots.length);

test('a clean 20-shot pass assembles from an idea: every stage journaled, every intent answered, every cost kept, errors.ndjson empty', async () => {
  const { handle, wire, journal } = await filmPass();
  const seq = assembled(handle, journal);

  assert.equal(data(journal, 'ideate.attempt').length, 1, 'ideation derived the brief in one call');
  assert.equal(data(journal, 'screenplay')[0].calls, 1);
  assert.equal(data(journal, 'breakdown')[0].calls, 1 + 20 + 3, 'one structure call, one compose per shot, one per plate');
  assert.equal(seq.plan.shots.length, 20);
  assert.equal(seq.plan.shots.reduce((a, sh) => a + sh.seconds, 0), 100);
  assert.equal(seq.plan.plates.length, 3);
  assert.ok(seq.plan.shots.every((sh) => typeof sh.keyframe?.needed === 'boolean' && sh.keyframe.reason && sh.subject && sh.force && sh.change));
  const heads = seq.plan.shots.filter((sh, i) => i === 0 || sh.join === 'cut').map((sh) => sh.id);
  assert.deepEqual(heads, ['s1', 's5', 's9', 's13', 's17']);
  const approve = data(journal, 'approve')[0];
  assert.equal(approve.approval.ok, true);
  assert.ok(approve.gates.every((g) => g.pass), 'POL-002, POL-006 and POL-012 pass before any money');
  const firstPaid = journal.entries().findIndex((r) => r.kind === 'intent' && ['generateImage', 'startVideo'].includes(r.data.call));
  const approveStep = journal.entries('approve')[0].step;
  assert.ok(firstPaid >= 0 && journal.entries()[firstPaid].step > approveStep, 'approval precedes the first paid intent');

  const kinds = kindsOf(journal);
  for (const kind of ['ideate.start', 'ideate.attempt', 'ideate.result', 'brief', 'screenplay', 'breakdown', 'approve', 'reservation', 'intent', 'result', 'node', 'schedule', 'cost', 'media', 'keyframe', 'candidate', 'score', 'select', 'selection', 'judge', 'measure', 'qc', 'join', 'assemble', 'final', 'iteration', 'film']) {
    assert.ok(kinds[kind] > 0, `journal kind "${kind}" is present`);
  }
  for (const kind of ['finding', 'regeneration', 'completionDecision', 'fault', 'reservation.refused']) {
    assert.equal(kinds[kind] || 0, 0, `a clean pass writes no "${kind}"`);
  }
  assert.deepEqual(journal.errors(), [], 'errors.ndjson is empty');
  assert.deepEqual(handle.reserve.refusals, [], 'null ceilings never refuse');

  const stills = wire.calls.imagine.length;
  const takes = wire.calls.animate.length;
  assert.equal(stills, 3 + 5 * 3, 'three plates and three candidates per keyframe shot');
  assert.equal(takes, 20);
  const costs = journal.costs();
  assert.equal(costs.length, stills + takes);
  assert.ok(costs.every((c) => c.disposition === 'kept'));
  assert.equal(data(journal, 'reservation').length, stills + takes, 'every paid call was reserved');
  assert.ok(data(journal, 'reservation').every((r) => r.nodeId && r.justification));
  const secondsPlanned = seq.plan.shots.reduce((a, sh) => a + sh.seconds, 0);
  const takeReservations = data(journal, 'reservation').filter((r) => r.kind === 'take');
  const secondsByShot = Object.fromEntries(seq.plan.shots.map((sh) => [String(sh.id), sh.seconds]));
  assert.ok(takeReservations.every((r) => r.units === secondsByShot[r.nodeId.slice('shoot:'.length)]), 'a take is reserved as its shot\'s seconds, not as one unit');
  assert.ok(costs.filter((c) => c.kind === 'take').every((c) => c.units === secondsByShot[c.shotId]), 'every kept take cost row carries the shot\'s seconds');
  assert.deepEqual({ takes: handle.ledger.takes, videoSeconds: handle.ledger.videoSeconds }, { takes, videoSeconds: secondsPlanned }, 'the ledger counts one take and the shot\'s seconds per reservation');
  const approval = data(journal, 'approve')[0].approval;
  assert.equal(approval.arithmetic.videoSeconds.max, secondsPlanned * POLICY().attempts.shot, 'the approved video-second ceiling is the sum the take reservations can reach');
  assert.equal(approval.arithmetic.videoSeconds.base, takeReservations.reduce((a, r) => a + r.units, 0), 'a clean pass spends exactly the approval\'s base video seconds');

  const intents = data(journal, 'intent');
  const results = data(journal, 'result');
  assert.equal(intents.length, results.length, 'every intent has its result');
  assert.equal(new Set(intents.map((i) => i.intentId)).size, intents.length);
  const calls = intents.reduce((acc, i) => ({ ...acc, [i.call]: (acc[i.call] || 0) + 1 }), {});
  assert.equal(calls.startVideo, 20);
  assert.equal(calls.pollVideo, 20);
  assert.equal(calls.generateImage, stills);
  assert.equal(calls['render.start'], 20);
  assert.equal(calls['render.image'], 3);
  assert.equal(calls.reason, wire.calls.reason.length, 'every reasoning call is an intent');
  assert.ok(intents.filter((i) => i.call === 'reason').every((i) => i.prompt && i.systemPrompt && typeof i.images === 'number'));

  const keyframes = data(journal, 'keyframe');
  assert.equal(keyframes.length, 20);
  assert.deepEqual(keyframes.filter((k) => k.needed).map((k) => k.shotId).sort(), [...heads].sort());
  assert.ok(keyframes.filter((k) => !k.needed).every((k) => /last frame/.test(k.reason)));
  assert.equal(data(journal, 'candidate').length, 15);
  assert.equal(data(journal, 'score').length, 15);
  assert.equal(data(journal, 'select').length, 5);
  assert.equal(data(journal, 'selection').length, 5);
  assert.ok(data(journal, 'selection').every((s) => s.ranked.length === 3 && s.shortfall === null));

  for (const b of wire.calls.animate) {
    assert.equal(references(b).length, 0, 'no take carries references');
    if (heads.includes(b.shotId)) assert.match(firstFrame(b), /key=still\d+\.png/, `${b.shotId} starts from its promoted keyframe`);
    else {
      const i = seq.plan.shots.findIndex((sh) => sh.id === b.shotId);
      const prev = seq.run.takes[seq.plan.shots[i - 1].id].at(-1);
      assert.equal(firstFrame(b), prev.lastFrameUrl, `${b.shotId} starts from the recorded last frame of its predecessor`);
    }
  }

  const qc = data(journal, 'qc');
  assert.equal(qc.filter((q) => q.kind === 'take').length, 20);
  assert.ok(qc.filter((q) => q.kind === 'take').every((q) => q.pass === true && q.score > 0.5));
  assert.equal(qc.filter((q) => q.kind === 'film').length, 1);
  assert.deepEqual(data(journal, 'film')[0].findings, []);
  assert.ok(wire.calls.reason.every((c) => c.images.length <= POLICY().judge.maxFramesPerCall + 3), 'the judge never sees more than the policy frame cap');
  assert.equal(data(journal, 'measure').length, 20);
  assert.equal(data(journal, 'join').length, 19);
  assert.ok(data(journal, 'join').every((j) => Number.isInteger(j.distance) && ['cut', 'continuous'].includes(j.joinType)));
  const final = data(journal, 'final')[0];
  assert.ok(final.gates.some((g) => g.ruleId === 'CIN-008' && g.pass));
  assert.ok(Math.abs(final.totalMeasured - 100) <= tolerance(seq));
  assert.equal(data(journal, 'iteration')[0].status, 'assembled');
  assert.ok(data(journal, 'schedule').some((s) => s.event === 'complete' && s.waves > 1));

  assert.equal(data(journal, 'media').length, 3 + 3 + 5 + 15 + 20 + 20 + 1, 'plate attempts, kept plates, keyframes, candidates, takes, last frames and the slice');
  assert.ok(data(journal, 'media').every((m) => fs.existsSync(m.path) && m.bytes > 0));
  assert.equal(seq.shotIds.length, 20);
  assert.ok(Object.values(seq.run.takes).every((t) => t.length === 1 && t[0].pass === true));
  assert.equal(seq.iterations.length, 1);
  assert.equal(seq.iterations[0].cost.renders, stills + takes);
  assert.equal(handle.get().bible.filter((b) => b.plateUrl).length, 3);
});

test('a shot whose takes fail artifact QC twice regenerates twice — same keyframe, then a new candidate — and passes, with every cause journaled', async () => {
  const { handle, wire, journal } = await filmPass({ behaviors: { s5: { artifact: [true, true] } } });
  const seq = assembled(handle, journal);

  const ledger = seq.run.takes.s5;
  assert.deepEqual(ledger.map((t) => t.pass), [false, false, true]);
  assert.equal(ledger[1].keyframeId, ledger[0].keyframeId, 'the first regeneration keeps the keyframe');
  assert.notEqual(ledger[2].keyframeId, ledger[0].keyframeId, 'the second regeneration shoots from a new candidate');
  const regen = data(journal, 'regeneration').filter((r) => r.shotId === 's5');
  assert.deepEqual(regen.map((r) => r.mode), ['same-keyframe', 'new-candidate']);
  assert.ok(regen.every((r) => r.cause === 'E-RUBRIC-FAIL' && r.ruleId === null && r.invalidatedShots.join() === 's6,s7,s8'));
  assert.deepEqual(regen.map((r) => r.attempt), [1, 2]);
  assert.deepEqual(regen.map((r) => r.n), [1, 2], 'the regeneration number the mode was chosen for rides on the row');

  const rows = journal.errors();
  const fails = rows.filter((r) => r.code === 'E-RUBRIC-FAIL');
  assert.equal(fails.length, 2);
  assert.ok(fails.every((r) => r.shotId === 's5' && r.rubricId === 'take.anatomy' && r.severity === 'blocker' && r.disposition === 'regenerate' && r.family === 'qc'));
  assert.deepEqual(fails.map((r) => r.takeId), ledger.slice(0, 2).map((t) => t.takeId));
  assert.ok(rows.every((r) => r.code === 'E-RUBRIC-FAIL'), 'no other error row');
  const qc = data(journal, 'qc').filter((q) => q.kind === 'take' && q.shotId === 's5');
  assert.deepEqual(qc.map((q) => q.pass), [false, false, true]);
  assert.ok(qc.slice(0, 2).every((q) => q.rubric.verdicts['take.anatomy'].falsification.pointed === true), 'the judge pointed at the frame before the take was rejected');

  assert.equal(seq.run.nodes['keyframe:s5'].rejected.length, 1);
  assert.equal(seq.run.nodes['keyframe:s5'].rejected[0], ledger[0].keyframeId);
  const selections = data(journal, 'selection').filter((s) => s.shotId === 's5');
  assert.equal(selections.length, 2);
  assert.ok(!selections[1].ranked.some((c) => c.id === ledger[0].keyframeId), 'the rejected keyframe is never offered again');
  const candidates = data(journal, 'candidate').filter((c) => c.shotId === 's5');
  assert.equal(candidates.length, 6);
  assert.equal(new Set(candidates.map((c) => c.id)).size, 6, 'every candidate id is unique across attempts');
  assert.equal(wire.calls.animate.filter((b) => b.shotId === 's5').length, 3);

  const wasted = journal.costs().filter((c) => c.disposition === 'wasted');
  assert.ok(wasted.filter((c) => c.code === 'E-WASTE-INVALIDATED-SUCCESSOR').length >= 3);
  assert.deepEqual(wasted.filter((c) => c.code === 'E-WASTE-QC-REGENERATED').map((c) => c.takeId), ledger.slice(0, 2).map((t) => t.takeId), 'both rejected takes are coded once the third passes');
  assert.deepEqual(wasted.filter((c) => c.code === 'E-WASTE-KEYFRAME-REJECTED').map((c) => c.candidateId), [ledger[0].keyframeId]);
  assert.ok(wasted.every((c) => ['E-WASTE-INVALIDATED-SUCCESSOR', 'E-WASTE-QC-REGENERATED', 'E-WASTE-KEYFRAME-REJECTED'].includes(c.code)));
  assert.ok(!wasted.some((c) => c.takeId === ledger[2].takeId), 'the passing take is never waste');
  assert.equal(seq.run.takes.s6.at(-1).firstFrameUrl, ledger[2].lastFrameUrl, 'the successor re-shot from the passing take');
  assert.equal(wire.calls.stitch[0].shots[4], ledger[2].url, 'assembly uses the passing take');
  assert.equal(data(journal, 'completionDecision').length, 0);
  assert.ok(Math.abs(data(journal, 'final')[0].totalMeasured - 100) <= tolerance(seq));
});

test('a shot that exhausts policy.attempts.shot ships its best take with a shortfall finding, and the pass still assembles', async () => {
  const { handle, wire, journal } = await filmPass({ behaviors: { s5: { artifact: [true, true, true, true, true] } } });
  const seq = assembled(handle, journal);
  const budget = POLICY().attempts.shot;

  const ledger = seq.run.takes.s5;
  assert.equal(ledger.length, budget);
  assert.ok(ledger.every((t) => t.pass === false && typeof t.score === 'number'));
  assert.equal(wire.calls.animate.filter((b) => b.shotId === 's5').length, budget);
  const regen = data(journal, 'regeneration').filter((r) => r.shotId === 's5');
  assert.deepEqual(regen.slice(0, budget - 1).map((r) => r.mode), ['same-keyframe', 'new-candidate', 'new-candidate', 'new-candidate']);

  const decision = data(journal, 'completionDecision').find((d) => d.shotId === 's5');
  assert.ok(decision, 'the completion decision is journaled');
  assert.equal(decision.decision, 'promote-best');
  assert.equal(decision.attempts, budget);
  assert.equal(decision.budget, budget);
  assert.equal(decision.takes.length, budget);
  const best = Math.max(...decision.takes.map((t) => t.score));
  const promoted = seq.run.nodes['qc:s5'].value.promoted;
  assert.equal(decision.takes.find((t) => t.takeId === promoted).score, best, 'the best-scoring take is promoted');
  assert.equal(seq.run.nodes['shoot:s5'].value.takeId, promoted);
  assert.equal(wire.calls.stitch[0].shots[4], ledger.find((t) => t.takeId === promoted).url);
  assert.equal(seq.run.takes.s6.at(-1).firstFrameUrl, ledger.find((t) => t.takeId === promoted).lastFrameUrl, 'the successor descends from the promoted take');

  const shortfall = journal.errors().filter((r) => r.code === 'E-SHOT-ATTEMPTS-EXHAUSTED');
  assert.equal(shortfall.length, 1);
  assert.equal(shortfall[0].family, 'shortfall');
  assert.equal(shortfall[0].stage, 'qc');
  assert.equal(shortfall[0].severity, 'blocker');
  assert.equal(shortfall[0].takeId, promoted);
  assert.equal(shortfall[0].attempt, budget);
  assert.equal(shortfall[0].evidence.length, budget, 'the finding carries every attempt with its score');
  assert.equal(journal.errors().filter((r) => r.code === 'E-RUBRIC-FAIL').length, budget);
  const lost = journal.costs().filter((c) => c.code === 'E-WASTE-NOT-PROMOTED');
  assert.equal(lost.length, budget - 1, 'every take that lost to the promoted best is coded');
  assert.ok(lost.every((c) => c.shotId === 's5' && c.takeId !== promoted && c.nodeId === 'shoot:s5'));
  assert.ok(!journal.costs().some((c) => c.disposition === 'wasted' && c.takeId === promoted), 'the promoted take is never waste');
  assert.equal(seq.iterations[0].status, 'assembled');
  assert.ok(Math.abs(data(journal, 'final')[0].totalMeasured - 100) <= tolerance(seq));
});

test('a continuous successor is invalidated and re-shot when its predecessor regenerates on a measure gate', async () => {
  const { handle, wire, journal } = await filmPass({ behaviors: { s1: { overshoot: [0.5] }, s2: { holdUntil: (calls) => calls.animate.filter((a) => a.shotId === 's1').length >= 2 } } });
  const seq = assembled(handle, journal);

  const rows = journal.errors();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'E-MEASURE-CIN-007');
  assert.ok(rows[0].family === 'gate' && rows[0].stage === 'measure' && rows[0].severity === 'blocker' && rows[0].shotId === 's1' && rows[0].attempt === 1);
  assert.ok('value' in rows[0] && 'threshold' in rows[0]);

  const regen = data(journal, 'regeneration');
  assert.equal(regen.length, 1);
  assert.equal(regen[0].shotId, 's1');
  assert.equal(regen[0].mode, 'same-keyframe');
  assert.equal(regen[0].ruleId, 'CIN-007');
  assert.deepEqual(regen[0].invalidatedShots, ['s2', 's3', 's4']);
  assert.ok(regen[0].inFlight.includes('shoot:s2'), 'the successor already in flight is discarded on arrival');

  assert.equal(seq.run.takes.s1.length, 2);
  assert.deepEqual(seq.run.takes.s1.map((t) => t.pass), [null, true]);
  assert.equal(seq.run.takes.s1[1].keyframeId, seq.run.takes.s1[0].keyframeId, 'the same keyframe is kept');
  assert.equal(data(journal, 'selection').filter((s) => s.shotId === 's1').length, 1);
  assert.equal(seq.run.takes.s2.length, 2);
  assert.equal(seq.run.takes.s2[1].firstFrameUrl, seq.run.takes.s1[1].lastFrameUrl, 'the successor re-shot from the regenerated take');
  assert.equal(seq.run.nodes['shoot:s2'].value.takeId, seq.run.takes.s2[1].takeId);
  assert.ok(data(journal, 'schedule').some((s) => s.event === 'invalidated' && s.id === 'shoot:s2'));
  const wasted = journal.costs().filter((c) => c.disposition === 'wasted');
  assert.deepEqual(wasted.map((c) => [c.code, c.takeId]).sort(), [['E-WASTE-GATE-REGENERATED', seq.run.takes.s1[0].takeId], ['E-WASTE-INVALIDATED-SUCCESSOR', seq.run.takes.s2[0].takeId]], 'the take the gate re-shot and the successor it invalidated are both coded');
  assert.equal(seq.run.takes.s3.length, 1);
  assert.equal(seq.run.takes.s3[0].firstFrameUrl, seq.run.takes.s2[1].lastFrameUrl);
  assert.equal(wire.calls.animate.length, 22);
  const joins = data(journal, 'join').filter((j) => j.to === 's2');
  assert.equal(joins.length, 1, 'the join is measured once, after the re-shoot — the regeneration landed before chain:s2 could run');
  assert.ok(journal.entries('join').find((r) => r.data.to === 's2').step > journal.entries('regeneration')[0].step);
  assert.equal(seq.run.nodes['chain:s2'].status, 'done');
  assert.ok(Math.abs(data(journal, 'final')[0].totalMeasured - 100) <= tolerance(seq));
});

test('a kill mid-poll halts with the task id kept; the resumed pass re-polls the same task and never starts a second render', async () => {
  const policy = policyWith((p) => { p.attempts.fault = 1; });
  const { handle, wire, journal, dir, runId } = await filmPass({ behaviors: { s3: { killPoll: 1 } }, policy });
  let seq = handle.seq();
  assert.equal(handle.status, 'halted', `expected the kill to halt the pass — status ${handle.status}, faults ${JSON.stringify(faultsOf(journal))}`);
  assert.equal(seq.run.halted.node, 'shoot:s3');
  assert.match(seq.run.halted.reason, /killed while polling/);
  const taskId = seq.run.nodes['shoot:s3'].value.taskId;
  assert.ok(taskId, 'the task id survives the kill');
  assert.equal(seq.run.takes.s3, undefined, 'no take was recorded for the killed poll');
  const broken = data(journal, 'result').filter((r) => r.call === 'pollVideo' && r.taskId === undefined && r.error);
  assert.equal(broken.length, 1, 'the failed poll is journaled as an error result');
  assert.deepEqual(journal.openIntents(), [], 'every intent was answered before the halt');
  assert.deepEqual(data(journal, 'iteration').map((i) => i.status), ['halted']);
  const animatesBefore = wire.calls.animate.length;
  const stepsBefore = journal.entries().length;
  await journal.close();

  const again = await passJournal({ dir, runId });
  opened.push(again);
  assert.equal(again.entries().length, stepsBefore, 'the reopened journal replays the whole pass');
  wire.install();
  try {
    await resumePass(handle, { journal: again });
  } finally {
    wire.restore();
  }
  seq = assembled(handle, again);
  const resume = data(again, 'resume')[0];
  assert.deepEqual(resume.undone, [{ id: 'shoot:s3', status: 'halted', taskId }]);
  assert.ok(animatesBefore < 20, 'the halt stopped admitting shots');
  assert.equal(wire.calls.animate.length, 20, 'the resumed pass renders only the shots that never started');
  assert.equal(wire.calls.animate.filter((b) => b.shotId === 's3').length, 1, 'the killed shot was not started again');
  assert.ok(seq.plan.shots.every((sh) => wire.calls.animate.filter((b) => b.shotId === sh.id).length === 1));
  const starts = data(again, 'intent').filter((i) => i.call === 'render.start' && i.shotId === 's3');
  assert.equal(starts.length, 1, 'one render.start intent for s3 across both runs');
  const polls = data(again, 'intent').filter((i) => i.call === 'pollVideo' && i.taskId === taskId);
  assert.equal(polls.length, 2, 'the same task was polled again');
  const pollResults = polls.map((p) => data(again, 'result').find((r) => r.intentId === p.intentId));
  assert.ok(pollResults[0].error && !pollResults[1].error);
  assert.equal(seq.run.takes.s3.length, 1);
  assert.equal(seq.run.takes.s3[0].taskId, taskId);
  assert.equal(again.costs().filter((c) => c.kind === 'take').length, 20, 'no take was paid twice');
  assert.equal(data(again, 'reservation').filter((r) => r.kind === 'take').length, 20, 'a resumed shoot with a task id reserves nothing new');
  assert.deepEqual(again.errors(), []);
  assert.deepEqual(data(again, 'iteration').map((i) => i.status), ['halted', 'assembled']);
});

test('a null ceiling never refuses; a wall-minute ceiling hit mid-pass stops the spend and holds the remaining shots as stills, and the timeline still sums', async () => {
  const policy = policyWith((p) => { p.budget.maxWallMinutes = 0.05; });
  const keyframesDone = (calls, handle) => Boolean(handle) && ['s1', 's5', 's9', 's13', 's17'].every((id) => handle.seq().run.nodes[`keyframe:${id}`]?.status === 'done');
  const { handle, wire, journal } = await filmPass({ behaviors: { s1: { holdUntil: keyframesDone, advanceMs: [3500] } }, policy });
  const seq = handle.seq();

  const refused = data(journal, 'reservation.refused');
  assert.ok(refused.length >= 1, 'the ceiling was crossed mid-pass');
  assert.ok(refused.every((r) => r.code === 'E-BUDGET-MAXWALLMINUTES'));
  assert.equal(handle.reserve.refusals.length, refused.length);
  const refusedShots = [...new Set(refused.map((r) => r.request.nodeId.split(':')[1]))];
  const firstRefusal = journal.entries('reservation.refused')[0].step;
  const paidAfter = journal.entries().filter((r) => r.step > firstRefusal && r.kind === 'intent' && ['generateImage', 'startVideo'].includes(r.data.call));

  const decisions = data(journal, 'completionDecision').filter((d) => d.decision === 'still-hold');
  assert.deepEqual(decisions.map((d) => d.shotId).sort(), refusedShots.sort(), `every shot refused by the ceiling takes the policy's ceiling decision (${policy.completion.onRenderCeiling}) — decisions: ${JSON.stringify(data(journal, 'completionDecision'))}`);
  assert.equal(paidAfter.length, 0, `no paid call after a refused reservation — ${paidAfter.length} went to the wire after step ${firstRefusal}`);
  assert.equal(handle.status, 'assembled', `the pass completes under the ceiling — halted: ${JSON.stringify(seq.run.halted || null)}`);
  assert.ok(journal.errors().some((r) => r.family === 'budget' && refusedShots.includes(r.shotId)), 'the downgrade is a coded finding');
  const final = data(journal, 'final')[0];
  assert.ok(Math.abs(final.totalMeasured - 100) <= tolerance(seq), `the held stills keep the timeline complete: ${final.totalMeasured}s`);
  assert.equal(wire.calls.stitch.at(-1).shots.length, 20);
});

const seam = async () => {
  const dir = fresh();
  const wire = makePassWire();
  const journal = await passJournal({ dir, runId: 'run-seam' });
  opened.push(journal);
  const client = passClient(wire);
  const shot = { id: 's1', subject: 'FIGURE-1', force: 'the tide climbs the steps, seen as water crossing the frame', change: 'dry stone -> wet stone', setup: 'Wide Establisher', side: 'L', seconds: 5, location: 'PLACE-1', prompt: '[s1] the figure climbs the wet stone', join: null, beatId: 'b1' };
  const plates = [{ entity: 'FIGURE-1', role: 'character', url: '/api/film/media?key=still1.png' }];
  const take = async () => {
    const { taskId } = await client.startVideo({ content: [{ type: 'text', text: shot.prompt }], duration: 5 });
    const polled = await client.pollVideo({ taskId });
    return { taskId, promptUsed: shot.prompt, silent: false, takeId: 'take_1', url: polled.videoCacheUrl, lastFrameUrl: polled.lastFrameCacheUrl, attempt: 1, measure: null };
  };
  return { wire, journal, client, shot, plates, take, style: STYLE(), rubrics: passRubrics(), policy: POLICY() };
};

test('seam: scoreCandidate needs the shot\'s candidate pool as siblings, and the keyframe node hands it over', async () => {
  const s = await seam();
  s.wire.install();
  try {
    await s.client.generateImage({ prompt: 'a plate', referenceImages: [], size: '2K' });
    const [candidate] = await generateCandidates({ shot: s.shot, plates: s.plates, k: 1, attempt: 1, client: s.client, journal: s.journal, reserve: async (r) => ({ id: 'res_1', ...r }) });
    await assert.rejects(
      () => scoreCandidate({ candidate, shot: s.shot, plates: s.plates, style: s.style, rubrics: s.rubrics, policy: s.policy, client: s.client, journal: s.journal }),
      /siblings is required/,
      'docs/PIPELINE.md: scoreCandidate takes siblings — the near-duplicate check needs the pool; a missing list refuses by name',
    );
    await assert.doesNotReject(() => scoreCandidate({ candidate, siblings: [candidate], shot: s.shot, plates: s.plates, style: s.style, rubrics: s.rubrics, policy: s.policy, client: s.client, journal: s.journal }));
    const nodes = fs.readFileSync('agents/director/nodes.js', 'utf8');
    assert.match(nodes, /stages\.scoreCandidate\(\{ candidate, siblings,/, 'agents/director/nodes.js keyframe() passes the pool as siblings');
  } finally { s.wire.restore(); }
});

test('seam: takeQC names the take by take.id, and the qc node hands it the shoot value under that name', async () => {
  const s = await seam();
  s.wire.install();
  try {
    await s.client.generateImage({ prompt: 'a plate', referenceImages: [], size: '2K' });
    const take = await s.take();
    await assert.rejects(
      () => takeQC({ take, shot: s.shot, keyframe: null, plates: s.plates, style: s.style, rubrics: s.rubrics, policy: s.policy, client: s.client, journal: s.journal }),
      /take\.id and take\.url are required/,
      'docs/PIPELINE.md: takeQC requires take.id; a shoot value that only carries takeId refuses by name',
    );
    await assert.doesNotReject(() => takeQC({ take: { id: take.takeId, ...take }, shot: s.shot, keyframe: null, plates: s.plates, style: s.style, rubrics: s.rubrics, policy: s.policy, client: s.client, journal: s.journal }));
    const nodes = fs.readFileSync('agents/director/nodes.js', 'utf8');
    assert.match(nodes, /stages\.takeQC\(\{ take: \{ id: shootValue\.takeId, \.\.\.shootValue/, 'agents/director/nodes.js qc() names the take by its takeId');
  } finally { s.wire.restore(); }
});

test('seam: a rubric failure files a finding the errors taxonomy accepts', async () => {
  const s = await seam();
  s.wire.behaviors.s1 = { artifact: [true] };
  s.wire.install();
  try {
    await s.client.generateImage({ prompt: 'a plate', referenceImages: [], size: '2K' });
    const take = await s.take();
    const verdict = await takeQC({ take: { id: take.takeId, ...take }, shot: s.shot, keyframe: null, plates: s.plates, style: s.style, rubrics: s.rubrics, policy: s.policy, client: s.client, journal: s.journal })
      .catch((err) => ({ refused: err.message }));
    assert.equal(verdict.refused, undefined, `agents/director/qc.js files findings with evidence as an object and no runId; agents/journal.js FINDING_SCHEMA needs an evidence array — ${verdict.refused}`);
    assert.equal(verdict.pass, false);
    assert.ok(s.journal.errors().some((r) => r.code === 'E-RUBRIC-FAIL' && r.rubricId === 'take.anatomy'));
  } finally { s.wire.restore(); }
});

test('seam: every candidate still that was reserved is counted as a cost row', async () => {
  const s = await seam();
  s.wire.install();
  try {
    const reserved = [];
    await generateCandidates({ shot: s.shot, plates: s.plates, k: 2, attempt: 1, client: s.client, journal: s.journal, reserve: async (r) => { const record = { id: `res_${reserved.length + 1}`, ...r }; reserved.push(record); return record; } });
    assert.equal(reserved.length, 2);
    assert.equal(s.journal.costs().length, 2, 'every reserved candidate still is a cost row');
    assert.ok(s.journal.costs().every((c) => c.kind === 'still' && c.disposition === 'kept' && c.nodeId === 'keyframe:s1' && c.attempt === 1 && c.candidateId));
    assert.deepEqual(s.journal.costs().map((c) => c.reservationId), ['res_1', 'res_2'], 'every candidate cost row names the reservation it spent from');
    await assert.rejects(
      () => generateCandidates({ shot: s.shot, plates: s.plates, k: 1, attempt: 2, client: s.client, journal: s.journal, reserve: async () => {} }),
      /E-RESERVE-NO-ID.*keyframe:s1/,
      'a reserve that returns no record cannot be spent from',
    );
  } finally { s.wire.restore(); }
});

test('seam: the invalidation cost row the schedule writes is a lawful cost row', () => {
  const row = { nodeId: 'shoot:s2', kind: 'take', units: 1, disposition: 'wasted', code: 'E-WASTE-INVALIDATED-SUCCESSOR', shotId: 's2', takeId: 'take_1', reservationId: 'res_1', detail: 'shot s1 regenerated (same-keyframe after E-RUBRIC-FAIL)' };
  assert.deepEqual(validateCost(row), [], 'agents/director/schedule.js regenerate() and settle() write the invalidation cause in the detail column agents/journal.js COST_SCHEMA names');
  assert.ok(validateCost({ ...row, detail: undefined, cause: row.detail }).length, 'a cause column is not a lawful cost column');
});

test('seam: a second keyframe attempt yields candidates with new ids and new media names', async () => {
  const s = await seam();
  s.wire.install();
  try {
    await s.client.generateImage({ prompt: 'a plate', referenceImages: [], size: '2K' });
    let reservations = 0;
    const reserve = async (r) => ({ id: `res_${(reservations += 1)}`, ...r });
    const first = await generateCandidates({ shot: s.shot, plates: s.plates, k: 2, attempt: 1, client: s.client, journal: s.journal, reserve });
    const second = await generateCandidates({ shot: s.shot, plates: s.plates, k: 2, attempt: 2, client: s.client, journal: s.journal, reserve });
    assert.ok(second.every((c) => !first.some((f) => f.id === c.id)), 'candidate ids are unique across attempts');
    assert.equal(s.journal.entries('candidate').length, 4, 'both attempts record every still');
    const media = s.journal.entries('media').map((m) => m.data);
    assert.equal(media.filter((m) => m.name.startsWith('candidate-')).length, 4);
    assert.ok(media.every((m) => fs.existsSync(m.path)));
    assert.equal(s.journal.costs().filter((c) => c.kind === 'still' && c.candidateId).length, 4);
  } finally { s.wire.restore(); }
});

test('seam: the keyframe node counts every fresh candidate still against the run\'s spentRenders', async () => {
  const s = await seam();
  s.wire.install();
  try {
    const shot = { ...s.shot, keyframe: { needed: true, reason: 'cut head' } };
    const fresh3 = [1, 2, 3].map((i) => ({ id: `s1-a1-c${i}`, shotId: 's1', url: s.plates[0].url, path: null, attempt: 1, index: i }));
    let run = { spentRenders: 7, takes: {} };
    const nodes = { 'plate:FIGURE-1': { value: { url: s.plates[0].url, assetId: null } }, 'keyframe:s1': { attempts: 1 } };
    const ctx = {
      policy: s.policy, concurrency: s.policy.concurrency, client: s.client, journal: s.journal, reserve: async (r) => ({ id: 'res_1', ...r }), style: s.style, rubrics: s.rubrics, runId: 'run-seam',
      plan: { shots: [shot] }, manifest: { plates: [{ entity: 'FIGURE-1', role: 'character' }] },
      node: (id) => nodes[id] || {}, setNode: (id, patch) => { nodes[id] = { ...nodes[id], ...patch }; }, run: () => run, patchRun: (f) => { run = { ...run, ...f(run) }; },
      stages: {
        generateCandidates: async () => fresh3,
        scoreCandidate: async ({ candidate }) => ({ score: 0.9, deterministic: { score: 1 }, rubric: { score: 0.8 } }),
        selectCandidate: async ({ candidates }) => ({ winner: candidates[0], ranked: candidates, shortfall: null }),
      },
    };
    await NODES.keyframe(ctx, 'keyframe:s1');
    assert.equal(run.spentRenders, 7 + fresh3.length, 'agents/director/nodes.js keyframe() adds every fresh candidate still to run.spentRenders, the number iteration.cost.renders reports');
  } finally { s.wire.restore(); }
});

test('seam: a re-admitted assemble writes the slice beside the earlier admission\'s instead of meeting journal.media\'s refusal to overwrite', async () => {
  const s = await seam();
  s.wire.install();
  try {
    const tk = await s.take();
    const nodes = { 'shoot:s1': { status: 'done', value: tk }, assemble: {} };
    const ctx = {
      manifest: { targetSeconds: 5, shots: [s.shot] }, node: (id) => nodes[id] || {}, seqId: 'seq_1', journal: s.journal,
    };
    await assert.rejects(() => NODES.assemble(ctx), /no admission count/, 'docs/PIPELINE.md: the schedule numbers every run of a node; a missing admission refuses by name');
    nodes.assemble = { attempts: 1 };
    const first = await NODES.assemble(ctx);
    nodes.assemble = { attempts: 2 };
    const second = await NODES.assemble(ctx);
    assert.deepEqual([first.value.media, second.value.media], ['slice-a1.mp4', 'slice-a2.mp4']);
    assert.deepEqual([first.value.admission, second.value.admission], [1, 2]);
    const steps = data(s.journal, 'assemble');
    assert.deepEqual(steps.map((a) => [a.media, a.admission, a.url]), [['slice-a1.mp4', 1, first.value.url], ['slice-a2.mp4', 2, second.value.url]], 'the assemble step names its media so complete, the report and resume read the path from the journal');
    const media = data(s.journal, 'media').filter((m) => m.name.startsWith('slice-'));
    assert.deepEqual(media.map((m) => m.name), ['slice-a1.mp4', 'slice-a2.mp4']);
    assert.ok(media.every((m) => fs.existsSync(m.path)), 'both admissions keep their evidence on disk');
  } finally { s.wire.restore(); }
});

test('seam: journal.intent resolves to the id and every node awaits it before the wire', async () => {
  const journal = await openJournal({ dir: fresh() });
  const pending = journal.intent('render.image', { nodeId: 'plate:FIGURE-1' });
  assert.ok(pending instanceof Promise, 'docs/PIPELINE.md: intent resolves to the id; the executor, the schedule and the stages await it');
  const id = await pending;
  assert.equal(typeof id, 'string');
  await journal.result(id, { url: '/x.png' });
  await journal.close();
  const nodes = fs.readFileSync('agents/director/nodes.js', 'utf8');
  const bare = [...nodes.matchAll(/(?<!await )journal\.intent\(/g)];
  assert.deepEqual(bare.map((m) => m.index), [], 'agents/director/nodes.js must await every journal.intent — a bare call hands journal.result a promise, not an id');
});
