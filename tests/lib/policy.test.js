import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRulebook } from '../../agents/director/rulebook.js';
import { CHECKS } from '../../agents/director/gates.js';
import {
  POLICY_CHECKS, loadPolicyValues, policyProblems, approveManifest, makeReserve, makeLedger,
  decideKeyframe, chainsOf, regenerateMode, completionDecision, explainCompletion,
  promotionDecision, recurrenceDecision, reservationIdOf, runPolicyGate, JUDGE_PROTOCOL, filmSegmentsOf,
} from '../../agents/director/policy.js';
import { validateCost } from '../../agents/journal.js';
import { journalPolicyGates } from '../../cli/bravo.js';

const seedRule = (id, klass, appliesTo) => ({
  id, title: id, statement: `${id} holds.`, class: klass, appliesTo, blocking: true, failureKind: 'deterministic', provenance: { origin: 'seed' }, status: 'active',
});

const books = () => ({
  cinematic: { version: 1, rules: [seedRule('CIN-001', 'plan', 'shotplan')] },
  screenwriting: { version: 1, rules: [seedRule('SCR-001', 'plan', 'screenplay')] },
  metrics: { metrics: [] },
  policy: JSON.parse(fs.readFileSync('rules/policy.json', 'utf8')),
});

const policyBook = () => loadRulebook(books(), { checks: CHECKS, policyChecks: POLICY_CHECKS });
const values = () => loadPolicyValues('policy/default.json').values;
const withBudget = (patch) => { const p = values(); p.budget = { ...p.budget, ...patch }; return p; };

const manifest = () => ({
  plates: [{ entity: 'FIGURE-1', role: 'character', prompt: 'a plate' }, { entity: 'PLACE-1', role: 'location', prompt: 'a plate' }],
  shots: [
    { id: 's1', seconds: 6, join: null, subject: 'FIGURE-1', location: 'PLACE-1' },
    { id: 's2', seconds: 6, join: 'cut', subject: 'FIGURE-1', location: 'PLACE-1' },
    { id: 's3', seconds: 8, join: 'continuous', subject: 'FIGURE-1', location: 'PLACE-1' },
  ],
});
const fresh = () => ({ stills: 0, takes: 0, videoSeconds: 0, judgeCalls: 0, usd: 0, iterations: 0 });

const memoryJournal = () => {
  const entries = [];
  return { entries, write: async (kind, data) => { entries.push({ kind, data }); return { step: entries.length, at: 'now' }; } };
};

test('the policy book loads under the same loader: fourteen rules, each with a check, a statement and provenance', () => {
  const rb = policyBook();
  const policy = rb.rulesFor('run', 'policy');
  assert.equal(policy.length, 14);
  assert.deepEqual(policy.map((r) => r.id), Array.from({ length: 14 }, (_, i) => `POL-${String(i).padStart(3, '0')}`));
  for (const r of policy) {
    assert.equal(typeof POLICY_CHECKS[r.id], 'function', `${r.id} has a check`);
    assert.ok(r.statement.length > 40 && r.provenance.origin === 'seed' && r.book === 'policy');
  }
  const decrees = policy.filter((r) => r.provenance.decree).map((r) => r.id);
  assert.deepEqual(decrees, ['POL-004', 'POL-007', 'POL-011', 'POL-012']);
  assert.equal(rb.rules.length, 16);
  assert.ok(rb.doctrine().includes('[POL-011]'));
});

test('the loader refuses a policy rule without a check, a policy book without checks, and policy outside its class', () => {
  const b = books();
  b.policy.rules.push(seedRule('POL-999', 'policy', 'run'));
  assert.throws(() => loadRulebook(b, { checks: CHECKS, policyChecks: POLICY_CHECKS }), /POL-999 is an active policy rule with no check in POLICY_CHECKS.*escape hatch/);
  assert.throws(() => loadRulebook(books(), { checks: CHECKS }), /policy book was given without POLICY_CHECKS/);
  const noBook = books();
  delete noBook.policy;
  assert.throws(() => loadRulebook(noBook, { checks: CHECKS, policyChecks: POLICY_CHECKS }), /no policy book/);
  assert.equal(loadRulebook(noBook, { checks: CHECKS }).rules.length, 2);
  const wrongApplies = books();
  wrongApplies.policy.rules[0].appliesTo = 'shotplan';
  assert.throws(() => loadRulebook(wrongApplies, { checks: CHECKS, policyChecks: POLICY_CHECKS }), /policy rules apply to the run/);
  const planOnRun = books();
  planOnRun.cinematic.rules[0].appliesTo = 'run';
  assert.throws(() => loadRulebook(planOnRun, { checks: CHECKS, policyChecks: POLICY_CHECKS }), /only policy rules do/);
  const calibrating = books();
  calibrating.policy.rules[0].status = 'calibrating';
  assert.throws(() => loadRulebook(calibrating, { checks: CHECKS, policyChecks: POLICY_CHECKS }), /calibrating rule cannot block/);
  const soft = books();
  soft.policy.rules[0].blocking = false;
  assert.throws(() => loadRulebook(soft, { checks: CHECKS, policyChecks: POLICY_CHECKS }), /policy rules block/);
  const misfiled = books();
  misfiled.cinematic.rules.push(seedRule('POL-998', 'policy', 'run'));
  assert.throws(() => loadRulebook(misfiled, { checks: CHECKS, policyChecks: POLICY_CHECKS }), /policy rules live in the policy book/);
});

test('the values loader accepts the shipped file, hashes it, and refuses unknown or missing keys by name', () => {
  const loaded = loadPolicyValues('policy/default.json');
  assert.match(loaded.hash, /^[0-9a-f]{64}$/);
  assert.equal(loaded.values.budget.maxUsd, null);
  assert.deepEqual(policyProblems(loaded.values), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bravo-policy-'));
  const write = (name, obj) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  const unknown = values();
  unknown.budget.maxRetries = 3;
  assert.throws(() => loadPolicyValues(write('unknown.json', unknown)), /E-POLICY-SCHEMA.*unknown key budget\.maxRetries/);
  const missing = values();
  delete missing.judge.minInstances;
  assert.throws(() => loadPolicyValues(write('missing.json', missing)), /missing key judge\.minInstances/);
  const stringy = values();
  stringy.budget.maxStills = '40';
  assert.throws(() => loadPolicyValues(write('stringy.json', stringy)), /budget\.maxStills is a ceiling.*got "40"/);
  const order = values();
  order.shots.regenerateOrder = ['same-keyframe', 'same-keyframe'];
  assert.throws(() => loadPolicyValues(write('order.json', order)), /shots\.regenerateOrder/);
  assert.throws(() => loadPolicyValues(path.join(dir, 'absent.json')), /E-POLICY-FILE: no policy values file/);
  assert.throws(() => loadPolicyValues(''), /E-POLICY-FILE/);
});

test('approveManifest is arithmetic: plates, candidates times k, takes, and the attempt pools', () => {
  const r = approveManifest({ manifest: manifest(), policy: values(), spent: fresh() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.refusals, []);
  const a = r.arithmetic;
  assert.deepEqual(a.plates, { count: 2, attempts: 5, max: 10 });
  assert.deepEqual(a.candidates, { shots: 2, perShot: 3, count: 6, attempts: 5, max: 30 });
  assert.deepEqual(a.takes, { count: 3, attempts: 5, max: 15 });
  assert.deepEqual(a.stills, { base: 8, max: 40 });
  assert.deepEqual(a.renders, { base: 11, max: 55 });
  assert.deepEqual(a.videoSeconds, { base: 20, max: 100 });
  assert.deepEqual(a.judgeCalls.perItem, JUDGE_PROTOCOL.callsPerItem);
  assert.deepEqual(a.judgeCalls.judged, { plates: { base: 2, max: 10 }, candidates: { base: 6, max: 30 }, takes: { base: 3, max: 15 }, joins: { base: 2, max: 2 }, film: { segments: 1, base: 2, max: 2 } });
  assert.deepEqual(a.judgeCalls.items, { base: 2 + 6 + 3 + 2 + 2, max: 10 + 30 + 15 + 2 + 2 });
  assert.deepEqual([a.judgeCalls.base, a.judgeCalls.max], [15 * 2, 59 * 5], 'judge calls are judged items times the protocol calls per item, the way the reserving client counts them');
  assert.equal(filmSegmentsOf([{ id: 'a', seconds: 20 }, { id: 'b', seconds: 20 }, { id: 'c', seconds: 15 }], { fps: 1, maxFramesPerCall: 30 }), 3, 'segments pack greedily under the frame cap, as filmQC flushes');
  assert.equal(a.wallMinutes.enforcedAt, 'reservation');
  assert.equal(a.checks.find((c) => c.ceiling === 'budget.maxIterations').total, 1);
  assert.throws(() => approveManifest({ manifest: manifest(), policy: values(), spent: { stills: 0 } }), /spent\.takes must be a finite number/);
  const priced = withBudget({ maxUsd: 10 });
  assert.throws(() => approveManifest({ manifest: manifest(), policy: priced, spent: fresh() }), /estimate\.usd from the dated price file/);
  const withEstimate = { ...manifest(), estimate: { usd: 12.5 } };
  const over = approveManifest({ manifest: withEstimate, policy: priced, spent: fresh() });
  assert.deepEqual(over.refusals.map((x) => [x.code, x.limit, x.need]), [['E-BUDGET-MAXUSD', 10, 12.5]]);
});

test('a null ceiling never refuses; a non-null ceiling refuses with the numbers', async () => {
  const big = manifest();
  big.shots = Array.from({ length: 30 }, (_, i) => ({ id: `s${i + 1}`, seconds: 10, join: i ? 'cut' : null, subject: 'FIGURE-1', location: 'PLACE-1' }));
  const open = approveManifest({ manifest: big, policy: values(), spent: { ...fresh(), stills: 5000, takes: 5000, videoSeconds: 9e6, judgeCalls: 1e6 } });
  assert.equal(open.ok, true);
  assert.deepEqual(open.arithmetic.checks.filter((c) => c.limit === null).map((c) => c.ceiling), ['budget.maxStills', 'budget.maxRenders', 'budget.maxVideoSeconds', 'budget.maxJudgeCalls', 'plates.max']);

  const tight = approveManifest({ manifest: manifest(), policy: withBudget({ maxStills: 12, maxRenders: 50 }), spent: { ...fresh(), stills: 3 } });
  assert.equal(tight.ok, false);
  assert.deepEqual(tight.refusals.map((x) => x.code), ['E-BUDGET-MAXSTILLS', 'E-BUDGET-MAXRENDERS']);
  const stills = tight.refusals[0];
  assert.deepEqual([stills.ceiling, stills.limit, stills.spent, stills.need, stills.total], ['budget.maxStills', 12, 3, 40, 43]);
  assert.match(stills.detail, /budget\.maxStills is 12; 3 spent \+ 40 needed = 43/);
  const platesCap = approveManifest({ manifest: manifest(), policy: { ...values(), plates: { max: 1 } }, spent: fresh() });
  assert.deepEqual(platesCap.refusals.map((x) => x.code), ['E-BUDGET-PLATES-MAX']);

  const journal = memoryJournal();
  const ledger = makeLedger({ iterations: 0, startedAt: new Date().toISOString() });
  const reserve = makeReserve({ policy: withBudget({ maxRenders: 2 }), journal, ledger, clock: Date.now });
  await reserve({ nodeId: 'plate:FIGURE-1', kind: 'still', units: 1, justification: 'identity plate' });
  await reserve({ nodeId: 'shoot:s1', kind: 'take', units: 6, justification: 'first take' });
  await assert.rejects(reserve({ nodeId: 'shoot:s2', kind: 'take', units: 6, justification: 'second take' }), (err) => {
    assert.equal(err.code, 'E-BUDGET-MAXRENDERS');
    assert.match(err.message, /budget\.maxRenders is 2; take 6 for shoot:s2 would make 3/);
    return true;
  });
  const refused = journal.entries.at(-1);
  assert.equal(refused.kind, 'reservation.refused');
  assert.equal(refused.data.code, 'E-BUDGET-MAXRENDERS');
  assert.deepEqual([refused.data.before.renders, refused.data.after.renders], [2, 3]);
  assert.equal(ledger.takes, 1, 'a refused reservation spends nothing');

  const unbounded = makeReserve({ policy: values(), journal: memoryJournal(), ledger: makeLedger({ iterations: 0, startedAt: new Date().toISOString() }), clock: Date.now });
  for (let i = 0; i < 200; i += 1) await unbounded({ nodeId: `shoot:s${i}`, kind: 'take', units: 30, justification: 'unbounded by declaration' });
});

test('reserve refuses without a plan node, journals every reservation with before and after, and enforces every ceiling', async () => {
  const journal = memoryJournal();
  const ledger = makeLedger({ iterations: 0, startedAt: new Date().toISOString() });
  const reserve = makeReserve({ policy: values(), journal, ledger, clock: Date.now });
  await assert.rejects(reserve({ kind: 'still', units: 1, justification: 'x' }), (err) => err.code === 'E-RESERVE-NO-NODE');
  assert.equal(journal.entries[0].kind, 'reservation.refused');
  assert.equal(journal.entries[0].data.code, 'E-RESERVE-NO-NODE');
  await assert.rejects(reserve({ nodeId: 'shoot:s1', kind: 'render', units: 1, justification: 'x' }), (err) => err.code === 'E-RESERVE-KIND');
  await assert.rejects(reserve({ nodeId: 'shoot:s1', kind: 'take', units: 0, justification: 'x' }), (err) => err.code === 'E-RESERVE-UNITS');
  await assert.rejects(reserve({ nodeId: 'shoot:s1', kind: 'take', units: 6, justification: '' }), (err) => err.code === 'E-RESERVE-JUSTIFICATION');

  const first = await reserve({ nodeId: 'keyframe:s1', kind: 'still', units: 3, justification: 'three keyframe candidates' });
  const second = await reserve({ nodeId: 'qc:s1', kind: 'judge', units: 2, justification: 'both question orders' });
  assert.equal(first.id, 'res_1');
  assert.deepEqual([first.before.stills, first.after.stills], [0, 3]);
  assert.deepEqual([second.before.judgeCalls, second.after.judgeCalls], [0, 2]);
  assert.equal(second.before.stills, 3);
  const written = journal.entries.filter((e) => e.kind === 'reservation');
  assert.equal(written.length, 2);
  assert.equal(written[1].data, second);
  assert.equal(ledger.reservations.length, 2);

  const priced = makeReserve({ policy: withBudget({ maxUsd: 1 }), journal: memoryJournal(), ledger: makeLedger({ iterations: 0, startedAt: new Date().toISOString() }), clock: Date.now });
  await assert.rejects(priced({ nodeId: 'shoot:s1', kind: 'take', units: 6, justification: 'x' }), (err) => err.code === 'E-RESERVE-NO-PRICE');
  await priced({ nodeId: 'shoot:s1', kind: 'take', units: 6, usd: 0.7, justification: 'x' });
  await assert.rejects(priced({ nodeId: 'shoot:s2', kind: 'take', units: 6, usd: 0.7, justification: 'x' }), (err) => err.code === 'E-BUDGET-MAXUSD');

  const stale = makeLedger({ iterations: 0, startedAt: new Date(Date.now() - 61 * 60000).toISOString() });
  const timed = makeReserve({ policy: withBudget({ maxWallMinutes: 60 }), journal: memoryJournal(), ledger: stale, clock: Date.now });
  const frozen = makeLedger({ iterations: 0, startedAt: new Date(1000).toISOString() });
  const virtual = makeReserve({ policy: withBudget({ maxWallMinutes: 1 }), journal: memoryJournal(), ledger: frozen, clock: () => 1000 + 59 * 1000 });
  await virtual({ nodeId: 'shoot:s1', kind: 'take', units: 6, justification: 'the clock the reserve reads is the one it was handed' });
  await assert.rejects(timed({ nodeId: 'shoot:s1', kind: 'take', units: 6, justification: 'x' }), (err) => err.code === 'E-BUDGET-MAXWALLMINUTES');

  assert.throws(() => makeReserve({ policy: values(), journal: {}, ledger: makeLedger({ iterations: 0, startedAt: new Date().toISOString() }), clock: Date.now }), /E-RESERVE-JOURNAL/);
  assert.throws(() => makeLedger({}), /E-LEDGER-ITERATIONS/);
  assert.throws(() => makeLedger({ iterations: 0 }), /E-LEDGER-STARTED-AT/);
  assert.throws(() => makeReserve({ policy: values(), journal: memoryJournal(), ledger: makeLedger({ iterations: 0, startedAt: new Date().toISOString() }) }), /E-RESERVE-CLOCK/);
});

test('POL-003 reads journaled reservations and cost rows: a cost row names the reservation it spent from, and one without a reservation blocks', async () => {
  const rb = policyBook();
  const journal = memoryJournal();
  const reserve = makeReserve({ policy: values(), journal, ledger: makeLedger({ iterations: 0, startedAt: new Date().toISOString() }), clock: Date.now });
  const plate = await reserve({ nodeId: 'plate:FIGURE-1', kind: 'still', units: 1, justification: 'identity plate' });
  const judge = await reserve({ nodeId: 'qc:s1', kind: 'judge', units: 1, justification: 'take QC' });
  const reason = await reserve({ nodeId: 'breakdown', kind: 'reason', units: 1, justification: 'structure call' });
  assert.deepEqual([plate.id, judge.id, reason.id], ['res_1', 'res_2', 'res_3']);
  assert.equal(reservationIdOf(plate, 'plate:FIGURE-1'), 'res_1');
  assert.throws(() => reservationIdOf(undefined, 'plate:FIGURE-1'), /E-RESERVE-NO-ID.*plate:FIGURE-1/);
  assert.throws(() => reservationIdOf({ nodeId: 'x' }, 'x'), /E-RESERVE-NO-ID/);
  const later = new Date(Date.parse(reason.at) + 1000).toISOString();
  const costs = [
    { kind: 'still', units: 1, disposition: 'kept', nodeId: 'plate:FIGURE-1', reservationId: plate.id, at: later },
    { kind: 'judge', units: 1, disposition: 'kept', nodeId: 'qc:s1', reservationId: judge.id, at: later },
    { kind: 'reason', units: 1, disposition: 'kept', nodeId: 'breakdown', reservationId: reason.id, at: later },
  ];
  for (const c of costs) assert.deepEqual(validateCost(c), [], `the ${c.kind} cost row is lawful with its reservationId`);
  const reservations = journal.entries.filter((e) => e.kind === 'reservation').map((e) => e.data);
  const clean = runPolicyGate(rb, 'POL-003', { reservations, costs });
  assert.equal(clean.pass, true, JSON.stringify(clean.blockers));
  assert.equal(clean.results.length, 3);
  const orphan = runPolicyGate(rb, 'POL-003', { reservations, costs: [...costs, { kind: 'still', units: 1, disposition: 'kept', nodeId: 'keyframe:s1', at: later }] });
  assert.equal(orphan.pass, false);
  assert.match(orphan.blockers[0].detail, /no reservation named/);
  const early = runPolicyGate(rb, 'POL-003', { reservations, costs: [{ ...costs[0], at: new Date(Date.parse(plate.at) - 1000).toISOString() }] });
  assert.equal(early.pass, false);
  assert.match(early.blockers[0].detail, /reservation came after the spend/);
});

test('decideKeyframe: the first shot and a cut need one, a continuous shot does not, and everything else is refused by name', () => {
  const [s1, s2, s3] = manifest().shots;
  assert.deepEqual(decideKeyframe(s1, null), { needed: true, reason: 'shot s1 is the first shot: identity and setup are anchored by a keyframe generated from the plates' });
  const cut = decideKeyframe(s2, s1);
  assert.equal(cut.needed, true);
  assert.match(cut.reason, /cuts from s1/);
  const cont = decideKeyframe(s3, s2);
  assert.equal(cont.needed, false);
  assert.match(cont.reason, /recorded last frame of the previous take/);
  assert.throws(() => decideKeyframe({ id: 's2' }, s1), /E-KEYFRAME-JOIN.*declares join null/);
  assert.throws(() => decideKeyframe({ id: 's1', join: 'continuous' }, null), /first shot and declares a continuous join/);
  assert.throws(() => decideKeyframe({ ...s3, location: 'PLACE-2' }, s2), /E-KEYFRAME-CONTINUOUS-MISMATCH.*location differ/);
  assert.throws(() => decideKeyframe({ ...s3, subject: 'FIGURE-2' }, s2), /subject differ/);
  assert.deepEqual(chainsOf(manifest().shots), [{ head: 's1', shotIds: ['s1'], length: 1 }, { head: 's2', shotIds: ['s2', 's3'], length: 2 }]);
});

test('completionDecision follows the policy for an exhausted shot and for the render ceiling, and refuses an open shot', () => {
  const policy = values();
  const shot = { id: 's4' };
  const five = [1, 2, 3, 4, 5].map((n) => ({ attempt: n, score: n === 3 ? 0.71 : 0.4 }));
  assert.equal(completionDecision({ policy, shot, attempts: five }), 'promote-best');
  const why = explainCompletion({ policy, shot, attempts: five });
  assert.deepEqual([why.cause, why.budget, why.attempts, why.best], ['exhausted-shot', 5, 5, { attempt: 3, score: 0.71 }]);
  const ceiling = [{ attempt: 1, score: 0.5 }, { attempt: 2, refused: 'E-BUDGET-MAXRENDERS' }];
  assert.equal(completionDecision({ policy, shot, attempts: ceiling }), 'still-hold');
  assert.equal(explainCompletion({ policy, shot, attempts: ceiling }).refused, 'E-BUDGET-MAXRENDERS');
  assert.throws(() => completionDecision({ policy, shot, attempts: five.slice(0, 2) }), /E-COMPLETION-OPEN.*2 of 5 attempts/);
  const flipped = { ...policy, completion: { onExhaustedShot: 'still-hold', onRenderCeiling: 'promote-best' } };
  assert.equal(completionDecision({ policy: flipped, shot, attempts: five }), 'still-hold');
  assert.equal(completionDecision({ policy: flipped, shot, attempts: ceiling }), 'promote-best');
  assert.throws(() => completionDecision({ policy: flipped, shot, attempts: [{ attempt: 1, refused: 'E-BUDGET-MAXRENDERS' }] }), /E-COMPLETION-NO-TAKE/);
});

test('regeneration order, promotion and recurrence read their numbers from the policy', () => {
  const policy = values();
  assert.deepEqual([1, 2, 3, 4].map((n) => regenerateMode(policy, n)), ['same-keyframe', 'new-candidate', 'new-candidate', 'new-candidate']);
  assert.throws(() => regenerateMode(policy, 0), /E-REGENERATE-N/);
  assert.equal(promotionDecision({ policy, rubricId: 'force-visible', instances: 20, precision: 0.8 }).promote, true);
  assert.equal(promotionDecision({ policy, rubricId: 'force-visible', instances: 19, precision: 0.95 }).promote, false);
  assert.match(promotionDecision({ policy, rubricId: 'force-visible', instances: 25, precision: 0.5 }).reason, /precision 0.5 vs minimum 0.8 \(short\)/);
  assert.equal(recurrenceDecision({ policy, signature: 'qc/frozen', runs: 3, ideas: 2 }).propose, true);
  assert.equal(recurrenceDecision({ policy, signature: 'qc/frozen', runs: 5, ideas: 1 }).propose, false);
  assert.throws(() => promotionDecision({ policy, rubricId: 'x', instances: 3, precision: 2 }), /E-PROMOTION-PRECISION/);
});

test('the policy module rides into the browser bundle: no static Node imports, and only the file loader needs Node', () => {
  const source = fs.readFileSync('agents/director/policy.js', 'utf8');
  assert.ok(!/^import\s/m.test(source), 'policy.js imports nothing at the top level');
  const policy = values();
  const saved = process.getBuiltinModule;
  process.getBuiltinModule = undefined;
  try {
    assert.throws(() => loadPolicyValues('policy/default.json'), /E-POLICY-RUNTIME.*node:fs/);
    assert.equal(decideKeyframe({ id: 'a' }, null).needed, true);
    assert.equal(approveManifest({ manifest: manifest(), policy, spent: fresh() }).ok, true);
  } finally {
    process.getBuiltinModule = saved;
  }
});

test('every policy check passes a lawful payload and catches its own violation', () => {
  const rb = policyBook();
  const policy = values();
  const shots = manifest().shots.map((sh, i, all) => ({ ...sh, keyframe: decideKeyframe(sh, i ? all[i - 1] : null) }));
  const lawful = {
    'POL-000': () => ({ intake: { audio: true, slots: { video: 'seedance25', image: 'seedreamPro', reason: 'reasoner', audioJudge: 'judge-audio' }, tos: true, priceFileDate: '2026-09-01', style: { look: { style: 'x', grade: 'y' } }, policyValues: policy } }),
    'POL-001': () => ({ briefInput: { logline: { value: 'x', derived: true, from: 'ideate', reason: 'from the idea' }, cast: { value: [], derived: true, from: 'ideate', reason: 'from the idea' } } }),
    'POL-002': () => ({ manifest: manifest(), policy, spent: fresh() }),
    'POL-003': () => ({ reservations: [{ id: 'res_1', at: '2026-09-01T00:00:00Z' }], costs: [{ id: 'c1', reservationId: 'res_1', at: '2026-09-01T00:00:01Z' }] }),
    'POL-004': () => ({ policy, attempts: [{ kind: 'shot', subject: 's1', used: 5 }, { kind: 'plate', subject: 'FIGURE-1', used: 1 }] }),
    'POL-005': () => ({ policy, regenerations: [{ shotId: 's1', n: 1, mode: 'same-keyframe' }, { shotId: 's1', n: 2, mode: 'new-candidate' }] }),
    'POL-006': () => ({ policy, shots: manifest().shots }),
    'POL-007': () => ({ policy, completions: [{ shot: { id: 's1' }, attempts: [1, 2, 3, 4, 5].map((n) => ({ attempt: n, score: 0.3 })), decision: 'promote-best' }] }),
    'POL-008': () => ({ policy, verdicts: [{ id: 'v1', rubricId: 'take.anatomy', action: 'regenerate' }, { id: 'v2', rubricId: 'take.force-visible', action: 'witness' }] }),
    'POL-009': () => ({ policy, calibrations: [{ rubricId: 'force-visible', instances: 20, precision: 0.9, promoted: true }, { rubricId: 'change-visible', instances: 4, precision: 1, promoted: false }] }),
    'POL-010': () => ({ policy, recurrences: [{ signature: 'qc/frozen', runs: 3, ideas: 2, proposed: true }, { signature: 'qc/black', runs: 1, ideas: 1, proposed: false }] }),
    'POL-011': () => ({ policy }),
    'POL-012': () => ({ shots }),
    'POL-013': () => ({ policy, selections: [{ shotId: 's1', candidates: 3, winnerScore: 0.7, shortfall: null }, { shotId: 's2', candidates: 6, winnerScore: 0.4, shortfall: 'best of six under the floor after two candidate attempts' }] }),
  };
  const breakers = {
    'POL-000': (p) => { delete p.intake.slots.audioJudge; },
    'POL-001': (p) => { p.briefInput.questions = ['which look?']; },
    'POL-002': (p) => { p.policy = withBudget({ maxStills: 1 }); },
    'POL-003': (p) => { p.costs[0].reservationId = 'res_9'; },
    'POL-004': (p) => { p.attempts[0].used = 6; },
    'POL-005': (p) => { p.regenerations[0].mode = 'new-candidate'; },
    'POL-006': (p) => { p.shots = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, join: i ? 'continuous' : null, subject: 'A', location: 'P' })); },
    'POL-007': (p) => { p.completions[0].decision = 'still-hold'; },
    'POL-008': (p) => { p.verdicts[1].action = 'regenerate'; },
    'POL-009': (p) => { p.calibrations[1].promoted = true; },
    'POL-010': (p) => { p.recurrences[1].proposed = true; },
    'POL-011': (p) => { p.policy = { ...policy, budget: { ...policy.budget, maxUsd: 'lots' } }; },
    'POL-012': (p) => { p.shots[1].keyframe = { needed: false, reason: 'skipped' }; },
    'POL-013': (p) => { p.selections[1].shortfall = null; },
  };
  for (const id of Object.keys(POLICY_CHECKS)) {
    const clean = runPolicyGate(rb, id, lawful[id]());
    assert.equal(clean.pass, true, `${id} lawful: ${JSON.stringify(clean.blockers)}`);
    assert.ok(clean.results.every((r) => r.class === 'policy' && r.blocking === true));
    const broken = lawful[id]();
    breakers[id](broken);
    const r = runPolicyGate(rb, id, broken);
    assert.equal(r.pass, false, `${id}: expected a block`);
    assert.ok(r.blockers.every((b) => b.ruleId === id));
  }
  assert.throws(() => runPolicyGate(rb, 'POL-003', { reservations: [] }), /E-POLICY-PAYLOAD: POL-003 checks payload\.costs/);
  assert.throws(() => runPolicyGate(rb, 'CIN-001', {}), /E-POLICY-RULE/);
  const off = runPolicyGate(rb, 'POL-000', { intake: { audio: false, slots: { video: 'v', image: 'i', reason: 'r' }, tos: true, priceFileDate: '2026-09-01', style: { look: {} }, policyValues: policy } });
  assert.equal(off.pass, true, 'audio off needs no audio judge slot');
  const named = runPolicyGate(rb, 'POL-000', { intake: { audio: false, slots: { video: 'v', image: 'i' }, tos: true, priceFileDate: 'yesterday', style: { look: {} }, policyValues: policy } });
  assert.deepEqual(named.blockers.map((b) => b.subject), ['slots.reason', 'priceFileDate']);
});

test('POL-005 audits the regeneration number the mode was chosen for, not the shoot node’s admission count', () => {
  const rb = policyBook();
  const policy = values();
  const rows = [
    { kind: 'regeneration', data: { shotId: 's2', attempt: 2, n: 1, mode: 'same-keyframe', cause: 'E-RUBRIC-FAIL', ruleId: null, invalidatedShots: [] } },
    { kind: 'regeneration', data: { shotId: 's2', attempt: 3, n: 2, mode: 'new-candidate', cause: 'E-RUBRIC-FAIL', ruleId: null, invalidatedShots: [] } },
    { kind: 'regeneration', data: { shotId: 's2', attempt: null, n: null, mode: 'promote-best', cause: 'promoted', ruleId: null, invalidatedShots: [] } },
    { kind: 'regeneration', data: { shotId: 's3', attempt: 1, mode: 'new-candidate', cause: 'E-SELECT-FLOOR', ruleId: null, invalidatedShots: [] } },
  ];
  const journal = { entries: (kind) => rows.filter((r) => r.kind === kind).map((r, i) => ({ step: i + 1, at: 'now', data: r.data })) };
  const gates = Object.fromEntries(journalPolicyGates({ rulebook: rb, journal, policy, run: { takes: {}, nodes: {} } }));
  assert.equal(gates['POL-005'].pass, true, 'a successor invalidated once regenerates same-keyframe on its second admission because it is its first counted take');
  assert.deepEqual(gates['POL-005'].results.map((r) => r.subject), ['shot s2 regeneration 1', 'shot s2 regeneration 2'], 'rows without a regeneration number are not shot regenerations under the order');
  rows[0].data.mode = 'new-candidate';
  const broken = Object.fromEntries(journalPolicyGates({ rulebook: rb, journal, policy, run: { takes: {}, nodes: {} } }));
  assert.equal(broken['POL-005'].pass, false, 'a real out-of-order regeneration is still caught');
});
