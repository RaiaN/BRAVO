import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { loadRulebook } from '../../agents/director/rulebook.js';
import { CHECKS, runPlanGates, runMeasureGates } from '../../agents/director/gates.js';
import { feasibility, feasibleKs, validatePartition } from '../../agents/director/partition.js';
import { appendMessage, latchThread, makeProject, makeSequence, sequenceById, touch } from '../../state/project.js';

const STUB_POLICY = `export const decideKeyframe = (shot, prevShot) => {
  if (!prevShot) return { needed: true, reason: 'first shot: identity and setup anchor on a keyframe from the plates' };
  if (shot.join === 'cut') return { needed: true, reason: 'cut: the image changes, a keyframe anchors it' };
  return { needed: false, reason: 'continuous: the first frame is the previous take\\'s recorded last frame' };
};`;
const STUB_LOADER = `import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const STUB = ${JSON.stringify(STUB_POLICY)};
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('/director/policy.js') && context.parentURL && !fs.existsSync(fileURLToPath(new URL(specifier, context.parentURL)))) {
    return { url: 'data:text/javascript,' + encodeURIComponent(STUB), shortCircuit: true };
  }
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(STUB_LOADER)}`);
const { breakdown, brief } = await import('../../agents/tools/director.js');

const books = () => ({
  cinematic: JSON.parse(fs.readFileSync('rules/cinematic.json', 'utf8')),
  screenwriting: JSON.parse(fs.readFileSync('rules/screenwriting.json', 'utf8')),
  metrics: JSON.parse(fs.readFileSync('rules/metrics.json', 'utf8')),
});
const policyValues = () => JSON.parse(fs.readFileSync('policy/default.json', 'utf8'));
const rb = () => loadRulebook(books(), { checks: CHECKS });
const ctx = { maxSeconds: () => 30, policy: policyValues() };

const K = 20;
const shotAt = (i) => ({
  id: `sh${i + 1}`,
  sceneId: 's1',
  beatId: `b${i + 1}`,
  subject: [1, 7, 13].includes(i) ? 'B' : 'A',
  force: [3, 11].includes(i) ? 'none' : 'B blocks the way, square in frame',
  change: 'closer -> blocked',
  setup: i === 0 ? 'Wide Establisher' : (i % 3 === 0 ? 'Medium Shot' : 'Close-Up'),
  side: 'L',
  seconds: 5,
  location: 'PLACE-1',
  join: i === 0 ? null : (i === 5 ? 'continuous' : 'cut'),
  prompt: i === 0 ? 'A moves. {Step aside.}' : `Shot ${i + 1} holds.`,
  flags: [],
});

const validPlan = () => ({
  slot: 'seedance25',
  brief: {
    logline: 'A wants X but B stands in the way.',
    targetSeconds: K * 5,
    format: { fps: 24 },
    cast: [{ name: 'A', bibleEntryId: 'bib_a' }, { name: 'B', bibleEntryId: 'new' }],
    locations: [{ name: 'PLACE-1', bibleEntryId: 'bib_p' }],
    dramatis: { protagonist: 'A', want: 'X', opposition: 'B' },
  },
  screenplay: {
    scenes: [{
      id: 's1',
      slug: { intExt: 'INT', location: 'PLACE-1', time: 'NIGHT' },
      action: ['A moves toward X.', 'B blocks the way.'],
      dialogue: [{ character: 'A', line: 'Step aside.' }],
      turn: { from: 'hopeful', to: 'cornered' },
      side: 'L',
      antagonism: true,
    }],
  },
  beats: Array.from({ length: K }, (_, i) => ({ id: `b${i + 1}`, text: `beat ${i + 1}` })),
  shots: Array.from({ length: K }, (_, i) => shotAt(i)),
  plates: [{ entity: 'B', prompt: 'a neutral plate' }],
});

test('the shipped rulebooks load, and every blocking rule has a check', () => {
  const book = rb();
  assert.equal(book.rules.length, 25);
  assert.ok(book.version.length === 8);
  assert.ok(book.rulesFor('screenplay', 'plan').length >= 4);
  assert.equal(book.ruleById('SCR-013').blocking, true);
});

test('the loader refuses half a rulebook, duplicates, and contradictions', () => {
  const b = books();
  assert.throws(() => loadRulebook({ cinematic: b.cinematic }), /half a rulebook/);
  const dup = JSON.parse(JSON.stringify(b));
  dup.screenwriting.rules.push({ ...dup.cinematic.rules[0] });
  assert.throws(() => loadRulebook(dup), /duplicate rule id/);
  const cal = JSON.parse(JSON.stringify(b));
  cal.cinematic.rules[0].status = 'calibrating';
  assert.throws(() => loadRulebook(cal), /calibrating rule cannot block/);
  const jb = JSON.parse(JSON.stringify(b));
  const judge = jb.cinematic.rules.find((r) => r.class === 'judgment');
  judge.blocking = true;
  assert.throws(() => loadRulebook(jb), /judgment rules never block/);
  const learned = JSON.parse(JSON.stringify(b));
  learned.cinematic.rules[0].provenance = { origin: 'note' };
  assert.throws(() => loadRulebook(learned), /names the iteration and note/);
});

test('an active blocking rule without a check refuses to load; a calibrating one may wait', () => {
  const b = books();
  b.cinematic.rules.push({
    id: 'CIN-999', title: 'x', statement: 'x', class: 'plan', appliesTo: 'shotplan',
    blocking: true, provenance: { origin: 'seed' }, status: 'active',
  });
  assert.throws(() => loadRulebook(b, { checks: CHECKS }), /no check implementation.*escape hatch/);
  const c = books();
  c.cinematic.rules.push({
    id: 'CIN-998', title: 'learned', statement: 'x', class: 'measure', appliesTo: 'joins',
    blocking: false, provenance: { origin: 'note', iteration: 'it1', note: 'n1' }, status: 'calibrating',
  });
  const loaded = loadRulebook(c, { checks: CHECKS });
  assert.ok(loaded.ruleById('CIN-998'));
});

test('feasibility partition: bounds, refusals with arithmetic, remainder spread', () => {
  const w = { kMin: 2, kMax: 4, dMin: 3, dMax: 30 };
  assert.deepEqual(feasibility(12, w).partition, [6, 6]);
  assert.deepEqual(feasibility(13, w).partition, [7, 6]);
  assert.equal(feasibility(5, w).ok, false);
  assert.match(feasibility(5, w).reason, /outside \[6, 120\]/);
  assert.equal(feasibility(121, w).ok, false);
  assert.equal(feasibility(10.5, w).ok, false);
  assert.equal(validatePartition(12, [6, 6], w).ok, true);
  assert.match(validatePartition(12, [5, 6], w).reason, /sum to 11/);
  assert.match(validatePartition(12, [2, 10], w).reason, /out of \[3, 30\]/);
});

test('a valid plan passes every plan gate', () => {
  const r = runPlanGates(rb(), validPlan(), ctx);
  assert.equal(r.pass, true, JSON.stringify(r.blockers));
});

test('narrative first: a screenplay failure halts before any cinematic gate runs', () => {
  const p = validPlan();
  p.screenplay.scenes[0].turn = { from: 'same', to: 'same' };
  p.shots[0].setup = 'not a real setup';
  const r = runPlanGates(rb(), p, ctx);
  assert.equal(r.pass, false);
  assert.equal(r.haltedAt, 'screenplay');
  assert.ok(r.blockers.every((b) => b.ruleId.startsWith('SCR')));
  assert.ok(!r.results.some((x) => x.ruleId === 'CIN-001'));
});

test('each seed plan rule catches its own violation', () => {
  const book = rb();
  const breakers = {
    'SCR-001': (p) => { p.screenplay.scenes[0].slug.location = ''; },
    'SCR-002': (p) => { delete p.brief.dramatis.opposition; },
    'SCR-003': (p) => { p.screenplay.scenes[0].antagonism = false; p.screenplay.scenes[0].action = ['A moves toward X.']; p.screenplay.scenes[0].dialogue = []; },
    'SCR-004': (p) => { delete p.screenplay.scenes[0].turn; },
    'SCR-005': (p) => { p.shots[1].beatId = 'b1'; },
    'SCR-006': (p) => { p.shots[0].prompt = 'A moves.'; },
    'SCR-007': (p) => { p.plates = []; },
    'SCR-013': (p) => { p.shots[2].subject = 'C'; },
    'CIN-001': (p) => { p.shots[1].setup = 'Selfie'; },
    'CIN-002': (p) => { p.shots[1].side = 'R'; },
    'CIN-005': (p) => { p.shots[1].seconds = 7; },
    'CIN-006': (p) => { p.shots.reverse(); },
  };
  for (const [ruleId, wreck] of Object.entries(breakers)) {
    const p = validPlan();
    wreck(p);
    const r = runPlanGates(book, p, ctx);
    assert.equal(r.pass, false, `${ruleId}: expected a block`);
    assert.ok(r.blockers.some((b) => b.ruleId === ruleId), `${ruleId}: blocked by ${r.blockers.map((b) => b.ruleId).join(',')}`);
  }
});

test('CIN-006 honors a declared override, and records it', () => {
  const p = validPlan();
  p.shots.reverse();
  p.shots[0].flags = ['no-establish'];
  const r = runPlanGates(rb(), p, ctx);
  assert.equal(r.pass, true, JSON.stringify(r.blockers));
});

test('measure gates: short take retryable, wrong fps deterministic, timeline tolerance', () => {
  const book = rb();
  const payload = {
    brief: { targetSeconds: 12 },
    perShot: [
      { shotId: 'sh1', requested: 6, measured: 6.04, fps: 24 },
      { shotId: 'sh2', requested: 6, measured: 5.2, fps: 25 },
    ],
    joins: [{ from: 'sh1', to: 'sh2', distance: 9, joinType: 'continuous' }],
    timeline: { totalMeasured: 11.24 },
  };
  const r = runMeasureGates(book, payload, ctx);
  assert.equal(r.pass, false);
  const short = r.blockers.find((b) => b.ruleId === 'CIN-007');
  assert.equal(short.failureKind, 'retryable');
  const fps = r.blockers.find((b) => b.ruleId === 'CIN-004');
  assert.equal(fps.failureKind, 'deterministic');
  assert.ok(r.blockers.some((b) => b.ruleId === 'CIN-008'));
});

test('uncalibrated rules record but can never block', () => {
  const book = rb();
  const payload = {
    brief: { targetSeconds: 12 },
    perShot: [{ shotId: 'sh1', requested: 6, measured: 6.01, fps: 24, blackFraction: 0.9 }],
    joins: [{ from: 'sh1', to: 'sh2', distance: 64, joinType: 'continuous' }],
    timeline: { totalMeasured: 12.01 },
  };
  const r = runMeasureGates(book, payload, ctx);
  assert.equal(r.pass, true);
  const chain = r.results.find((x) => x.ruleId === 'CIN-003');
  assert.equal(chain.value, 64);
  assert.equal(chain.blocking, false);
});

test('beat count and shot count are one number: feasible ks and the preferred partition', () => {
  const w = { kMin: 2, kMax: 4, dMin: 3, dMax: 30 };
  assert.deepEqual(feasibleKs(12, w), [2, 3, 4]);
  assert.deepEqual(feasibleKs(7, w), [2]);
  assert.deepEqual(feasibleKs(105, w), [4]);
  assert.deepEqual(feasibility(12, w, 3).partition, [4, 4, 4]);
  assert.deepEqual(feasibility(12, w, 7).partition, [6, 6]);
});

const scr013 = (p, c = ctx) => CHECKS['SCR-013'](p, { noForce: 'none' }, c);
const failures = (rows) => rows.filter((r) => !r.pass);

test('SCR-013: the subject is a cast name, canon-matched; a stranger in frame is refused', () => {
  const p = validPlan();
  p.shots[0].subject = ' a ';
  p.shots[2].subject = 'C';
  delete p.shots[6].subject;
  const bad = failures(scr013(p));
  assert.deepEqual(bad.map((r) => r.subject), ['shot sh3', 'shot sh7']);
  assert.match(bad[0].detail, /"C" is not the name of anyone in the cast/);
  assert.match(bad[1].detail, /null is not the name/);
});

test('SCR-013: force and change are required on every shot; the literal none is a named force', () => {
  const p = validPlan();
  p.shots[1].force = '';
  p.shots[2].force = 'None';
  delete p.shots[3].change;
  p.shots[8].change = '   ';
  const bad = failures(scr013(p));
  assert.deepEqual(bad.map((r) => [r.subject, r.detail]), [
    ['shot sh2', 'no force named'],
    ['shot sh4', 'no change named'],
    ['shot sh9', 'no change named'],
  ]);
  const share = scr013(p).find((r) => r.subject === 'shotplan');
  assert.equal(share.value, '3/20 shots without a force (0.15)');
});

test('SCR-013: the share of shots without a force is bounded by the policy, and the threshold names it', () => {
  const tight = { ...ctx, policy: { antagonism: { maxShareWithoutForce: 0.25 } } };
  const under = validPlan();
  [0, 2, 4].forEach((i) => { under.shots[i].force = 'none'; });
  const okRow = scr013(under, tight).find((r) => r.subject === 'shotplan');
  assert.equal(okRow.pass, true);
  assert.equal(okRow.value, '5/20 shots without a force (0.25)');
  assert.equal(okRow.threshold, '<= 0.25 (policy.antagonism.maxShareWithoutForce)');
  const over = validPlan();
  [0, 2, 4, 6].forEach((i) => { over.shots[i].force = 'none'; });
  const badRow = scr013(over, tight).find((r) => r.subject === 'shotplan');
  assert.equal(badRow.pass, false);
  assert.equal(badRow.value, '6/20 shots without a force (0.30)');
  const gate = runPlanGates(rb(), over, tight);
  assert.equal(gate.pass, false);
  assert.equal(gate.haltedAt, 'shotplan');
  assert.ok(gate.blockers.some((b) => b.ruleId === 'SCR-013' && b.subject === 'shotplan'));
});

test('SCR-013: a continuous join keeps its subject and its location; a change of either is refused', () => {
  const same = validPlan();
  assert.equal(failures(scr013(same)).length, 0);
  const subjectSwap = validPlan();
  subjectSwap.shots[5].subject = 'B';
  const s = failures(scr013(subjectSwap));
  assert.equal(s.length, 1);
  assert.equal(s[0].subject, 'join sh5->sh6');
  assert.match(s[0].detail, /changed its subject — that is a cut/);
  const locationSwap = validPlan();
  locationSwap.shots[5].location = 'PLACE-2';
  const l = failures(scr013(locationSwap));
  assert.equal(l.length, 1);
  assert.match(l[0].detail, /changed its location/);
  const both = validPlan();
  both.shots[5].subject = 'B';
  both.shots[5].location = 'PLACE-2';
  assert.match(failures(scr013(both))[0].detail, /subject and location/);
  const asCut = validPlan();
  asCut.shots[5].join = 'cut';
  asCut.shots[5].subject = 'B';
  asCut.shots[5].location = 'PLACE-2';
  assert.equal(failures(scr013(asCut)).length, 0);
});

test('SCR-013: a gate without its policy throws by name instead of assuming a ceiling', () => {
  const p = validPlan();
  assert.throws(() => scr013(p, { maxSeconds: () => 30 }), /SCR-013: ctx\.policy is missing/);
  assert.throws(() => CHECKS['SCR-013'](p, { noForce: 'none' }, undefined), /SCR-013: ctx\.policy is missing/);
  assert.throws(() => scr013(p, { policy: { antagonism: {} } }), /maxShareWithoutForce must be a number — got null/);
  assert.throws(() => scr013(p, { policy: { antagonism: { maxShareWithoutForce: '0.25' } } }), /must be a number — got "0.25"/);
  assert.throws(() => CHECKS['SCR-013'](p, {}, ctx), /params\.noForce/);
  assert.throws(() => runPlanGates(rb(), p, { maxSeconds: () => 30 }), /SCR-013: ctx\.policy is missing/);
});

const withRulesWire = async (fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/rules')) throw new Error('the director tools take the pass rulebook from ctx and never fetch /api/rules');
    return real(url, init);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

const structuralShots = (mutate = () => {}) => {
  const shots = Array.from({ length: K }, (_, i) => ({
    id: `sh${i + 1}`,
    sceneId: 's1',
    beatId: `b${i + 1}`,
    subject: 'A',
    force: i === 2 ? 'none' : 'B stands in the way, in frame',
    change: 'closer -> blocked',
    setup: i === 0 ? 'Wide Establisher' : 'Medium Shot',
    side: 'L',
    seconds: 5,
    location: 'PLACE-1',
    join: i === 0 ? undefined : (i === 5 ? 'continuous' : 'cut'),
    moment: `moment ${i + 1}`,
    dialogue: i === 0 ? ['Step aside.'] : [],
  }));
  mutate(shots);
  return shots;
};

const reasoner = (structures) => {
  const calls = [];
  let structural = 0;
  const client = {
    reason: async ({ prompt, systemPrompt }) => {
      calls.push({ prompt, systemPrompt });
      if (systemPrompt.includes('shot plan')) {
        const shots = structures[Math.min(structural, structures.length - 1)];
        structural += 1;
        return { content: JSON.stringify({ shots }) };
      }
      const lines = [...prompt.matchAll(/^ {2}\{(.*)\}$/gm)].map((m) => `{${m[1]}}`);
      return { content: ['The moment plays out.', ...lines].join(' ') };
    },
  };
  return { calls, client };
};

const plannedProject = () => {
  const base = validPlan();
  let p = makeProject();
  p = touch({ ...p, look: { style: 'grain', grade: 'cold', notes: '' } });
  const seq = makeSequence({
    brief: { ...base.brief, format: { fps: 24, resolution: '720p', ratio: 'adaptive', audio: true }, world: '', look: { style: 'grain', grade: 'cold' }, constraints: [], seed: null },
    screenplay: base.screenplay,
    beats: base.beats,
    rulebookVersion: 'testver',
    status: 'written',
  });
  p = touch({ ...p, sequences: [seq] });
  const threadId = p.threads[0].id;
  p = latchThread(p, threadId, 'director', { subjectId: seq.id, title: 't' }).project;
  p = appendMessage(p, threadId, { role: 'user', text: 'break it down' });
  return { p, thread: p.threads[0], seqId: seq.id };
};

const memoryJournal = () => { const writes = []; return { writes, write: async (kind, data) => { writes.push({ kind, data }); return { step: writes.length }; } }; };

const runBreakdown = async ({ structures, policy = policyValues(), rulebook = rb(), journal = memoryJournal(), input = {} }) => {
  const { p, thread, seqId } = plannedProject();
  const { calls, client } = reasoner(structures);
  const ctxIn = { client, modelId: null, requireSkillLine: async () => 'THE SKILL LINE' };
  if (policy !== null) ctxIn.policy = policy;
  if (rulebook !== null) ctxIn.rulebook = rulebook;
  if (journal !== null) ctxIn.journal = journal;
  const result = await withRulesWire(() => breakdown.run({ input, project: p, thread, ctx: ctxIn }));
  return { result, calls, journal, seq: sequenceById(result.project, seqId) };
};

test('breakdown records a keyframe decision on every plan shot: first and cut shots need one, continuous shots chain', async () => {
  const { result, seq } = await runBreakdown({ structures: [structuralShots()] });
  assert.equal(result.output.kind, 'plan', result.output.error);
  assert.equal(seq.plan.shots.length, K);
  for (const sh of seq.plan.shots) {
    assert.equal(typeof sh.keyframe.needed, 'boolean', `${sh.id} has no keyframe decision`);
    assert.ok(String(sh.keyframe.reason).trim(), `${sh.id} has a keyframe decision with no reason`);
  }
  assert.equal(seq.plan.shots[0].keyframe.needed, true);
  assert.equal(seq.plan.shots[1].keyframe.needed, true);
  assert.equal(seq.plan.shots[5].join, 'continuous');
  assert.equal(seq.plan.shots[5].keyframe.needed, false);
  assert.ok(result.output.shots.every((sh) => sh.keyframe && typeof sh.keyframe.needed === 'boolean' && sh.keyframe.reason), 'the journaled output carries every keyframe decision');
});

test('breakdown carries subject, force and change into the structural spec, the doctrine and every compose note', async () => {
  const { result, calls, seq } = await runBreakdown({ structures: [structuralShots()] });
  assert.equal(result.output.kind, 'plan', result.output.error);
  const structural = calls.filter((c) => c.systemPrompt.includes('shot plan'));
  assert.equal(structural.length, 1);
  for (const key of ['"subject"', '"force"', '"change"']) assert.ok(structural[0].systemPrompt.includes(key), `structural spec lacks ${key}`);
  assert.ok(structural[0].systemPrompt.includes('SUBJECT, FORCE, CHANGE'));
  assert.ok(structural[0].systemPrompt.includes(`at most ${Math.round(policyValues().antagonism.maxShareWithoutForce * 100)}% of the shots may carry "none"`));
  assert.ok(structural[0].systemPrompt.includes('[SCR-013]'), 'the rulebook doctrine names SCR-013');
  const composes = calls.filter((c) => c.prompt.includes('THE SHOT: moment '));
  assert.equal(composes.length, K);
  for (const c of composes) {
    assert.match(c.prompt, /SUBJECT: A\. FORCE: .+\. CHANGE: closer -> blocked\./);
    assert.ok(c.systemPrompt.includes('makes the FORCE visible'));
  }
  assert.ok(composes.some((c) => c.prompt.includes('FORCE: none.')));
  for (const sh of seq.plan.shots) {
    assert.equal(sh.subject, 'A');
    assert.ok(sh.force && sh.change);
  }
  assert.deepEqual(Object.keys(result.output.shots[0]), ['id', 'beatId', 'subject', 'force', 'change', 'setup', 'side', 'seconds', 'location', 'join', 'keyframe', 'prompt']);
});

test('breakdown rejects a structure that fails SCR-013 and tells the reasoner why; the corrected structure lands', async () => {
  const first = structuralShots((shots) => { shots[4].subject = 'C'; shots[7].force = ''; });
  const { result, calls, seq } = await runBreakdown({ structures: [first, structuralShots()] });
  assert.equal(result.output.kind, 'plan', result.output.error);
  const structural = calls.filter((c) => c.systemPrompt.includes('shot plan'));
  assert.equal(structural.length, 2);
  assert.match(structural[1].prompt, /YOUR LAST ATTEMPT WAS REJECTED/);
  assert.match(structural[1].prompt, /\[SCR-013\] shot sh5: subject "C" is not the name of anyone in the cast/);
  assert.match(structural[1].prompt, /\[SCR-013\] shot sh8: no force named/);
  assert.equal(seq.plan.shots.length, K);
  assert.equal(result.output.attempts.length, 1);
  assert.equal(result.output.attempts[0].attempt, 1);
  assert.deepEqual(result.output.attempts[0].blockers.map((b) => [b.ruleId, b.subject, b.detail]), [
    ['SCR-013', 'shot sh5', 'subject "C" is not the name of anyone in the cast'],
    ['SCR-013', 'join sh5->sh6', 'a continuous join changed its subject — that is a cut, and it is declared as one'],
    ['SCR-013', 'shot sh8', 'no force named'],
  ]);
  assert.match(result.output.attempts[0].reason, /\[SCR-013\] shot sh5/);
});

test('breakdown returns the full gate report: every SCR-013 verdict per shot, the share against the policy, every continuous join', async () => {
  const { result } = await runBreakdown({ structures: [structuralShots()] });
  assert.equal(result.output.kind, 'plan', result.output.error);
  assert.deepEqual(result.output.attempts, []);
  assert.ok(result.output.gates.every((r) => r.pass && typeof r.blocking === 'boolean' && r.class === 'plan'));
  const scr013 = result.output.gates.filter((r) => r.ruleId === 'SCR-013');
  for (const sh of result.output.shots) {
    assert.deepEqual(scr013.filter((r) => r.subject === `shot ${sh.id}`).map((r) => r.value), [sh.subject, sh.force, sh.change], `${sh.id} carries its subject, force and change verdicts`);
  }
  assert.equal(scr013.find((r) => r.subject === 'shotplan').value, '1/20 shots without a force (0.05)');
  assert.deepEqual(scr013.filter((r) => r.subject.startsWith('join ')).map((r) => r.subject), ['join sh5->sh6']);
  assert.deepEqual([...new Set(result.output.gates.map((r) => r.ruleId))].sort(), result.output.gatesPassed.slice().sort());
});

test('a structure refused twice keeps both rejected attempts with their gate rows on the error output', async () => {
  const moved = structuralShots((shots) => { shots[5].location = 'PLACE-2'; });
  const swapped = structuralShots((shots) => { shots[5].subject = 'B'; });
  const { result } = await runBreakdown({ structures: [moved, swapped] });
  assert.equal(result.output.kind, 'error');
  assert.deepEqual(result.output.gates, []);
  assert.deepEqual(result.output.attempts.map((a) => a.attempt), [1, 2]);
  assert.match(result.output.attempts[0].blockers[0].detail, /changed its location/);
  assert.match(result.output.attempts[1].blockers[0].detail, /changed its subject/);
});

test('breakdown refuses a continuous shot that changes location or subject, and saves nothing', async () => {
  const moved = structuralShots((shots) => { shots[5].location = 'PLACE-2'; });
  const swapped = structuralShots((shots) => { shots[5].subject = 'B'; });
  const { result, seq } = await runBreakdown({ structures: [moved, swapped] });
  assert.equal(result.output.kind, 'error');
  assert.match(result.output.error, /failed its gates twice and was NOT saved/);
  assert.match(result.output.error, /\[SCR-013\] join sh5->sh6: a continuous join changed its subject — that is a cut/);
  assert.equal(seq.plan, null);
  assert.equal(result.cost, 2);
});

test('breakdown refuses a plan where the opposition is absent past the policy share', async () => {
  const absent = structuralShots((shots) => { [0, 1, 2, 3, 4, 5].forEach((i) => { shots[i].force = 'none'; }); });
  const { result, seq } = await runBreakdown({ structures: [absent, absent] });
  assert.equal(result.output.kind, 'error');
  assert.match(result.output.error, /\[SCR-013\] shotplan: the opposition is absent from too much of the film/);
  assert.equal(seq.plan, null);
});

test('breakdown takes the pass rulebook and journal from ctx, refuses without them by name, journals every gate run as gate.attempt, and carries a policy rejection into its prompt', async () => {
  await assert.rejects(runBreakdown({ structures: [structuralShots()], rulebook: null }), /E-TOOL-RULEBOOK/);
  await assert.rejects(runBreakdown({ structures: [structuralShots()], journal: null }), /E-TOOL-JOURNAL/);
  const clean = await runBreakdown({ structures: [structuralShots()] });
  assert.equal(clean.result.output.kind, 'plan', clean.result.output.error);
  assert.deepEqual(clean.journal.writes.map((w) => `${w.data.tool}:${w.data.phase}:${w.data.attempt}:${w.data.pass}`), ['breakdown:structure:1:true', 'breakdown:plan:1:true']);
  assert.ok(clean.journal.writes.every((w) => w.kind === 'gate.attempt' && w.data.results.length > 0 && w.data.blockers.length === 0 && w.data.reason === null));
  const bad = structuralShots((shots) => { shots[5].location = 'PLACE-2'; });
  const refused = await runBreakdown({ structures: [bad, bad] });
  assert.equal(refused.result.output.kind, 'error');
  assert.deepEqual(refused.journal.writes.map((w) => `${w.data.phase}:${w.data.attempt}:${w.data.pass}:${w.data.blockers.length}`), ['structure:1:false:1', 'structure:2:false:1']);
  assert.match(refused.journal.writes[0].data.reason, /\[SCR-013\]/);
  const told = await runBreakdown({ structures: [structuralShots()], input: { rejected: ['[POL-006] chain sh1: chain of 7 exceeds the policy length'] } });
  assert.equal(told.result.output.kind, 'plan', told.result.output.error);
  assert.match(told.calls[0].prompt, /REFUSED BY POLICY[\s\S]*\[POL-006\] chain sh1/);
  assert.match(breakdown.validate({ rejected: [] }), /"rejected"/);
  assert.equal(breakdown.validate({}), null);
});

test('breakdown without ctx.policy throws by name before any reasoning call', async () => {
  const { p, thread } = plannedProject();
  const { calls, client } = reasoner([structuralShots()]);
  await assert.rejects(
    withRulesWire(() => breakdown.run({ input: {}, project: p, thread, ctx: { client, modelId: null, requireSkillLine: async () => 'THE SKILL LINE' } })),
    /director: ctx\.policy is missing/,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    runBreakdown({ structures: [structuralShots()], policy: { antagonism: {} } }),
    /breakdown: policy\.antagonism\.maxShareWithoutForce must be a number/,
  );
});

test('decideKeyframe honors the amendment: first and cut shots need a keyframe, continuous shots chain, every decision has a reason', async () => {
  const { decideKeyframe } = await import('../../agents/director/policy.js');
  const shots = structuralShots();
  const first = decideKeyframe(shots[0], null);
  const cut = decideKeyframe(shots[1], shots[0]);
  const continuous = decideKeyframe(shots[5], shots[4]);
  assert.deepEqual([first.needed, cut.needed, continuous.needed], [true, true, false]);
  for (const d of [first, cut, continuous]) assert.ok(String(d.reason).trim(), 'a keyframe decision names its reason');
});

test('the brief tool records the format the caller declared under the rulebook\'s fps, and refuses a brief without one by name', async () => {
  const draft = () => {
    let p = makeProject();
    const seq = makeSequence({ status: 'drafting' });
    p = touch({ ...p, look: { style: 'grain', grade: 'cold', notes: '' }, sequences: [seq] });
    const threadId = p.threads[0].id;
    p = latchThread(p, threadId, 'director', { subjectId: seq.id, title: 't' }).project;
    return { p, thread: p.threads[0], seqId: seq.id };
  };
  const input = (format) => ({
    logline: 'A wants X but B stands in the way.',
    targetSeconds: 100,
    world: '',
    cast: [{ name: 'A', role: 'character', bibleEntryId: 'new' }],
    locations: [{ name: 'PLACE-1', bibleEntryId: 'new' }],
    dramatis: { protagonist: 'A', want: 'X', opposition: 'B' },
    ...(format === undefined ? {} : { format }),
  });
  const refusals = [
    [undefined, /needs "format"/],
    [{ resolution: '720p', ratio: 'adaptive' }, /format is missing audio/],
    [{ fps: 24, resolution: '720p', ratio: 'adaptive', audio: true }, /unknown key\(s\) fps/],
    [{ resolution: '8K', ratio: 'adaptive', audio: true }, /format\.resolution must be one of/],
    [{ resolution: '720p', ratio: '', audio: true }, /format\.ratio must be a non-empty string/],
    [{ resolution: '720p', ratio: 'adaptive', audio: 'yes' }, /format\.audio must be true or false/],
  ];
  for (const [format, re] of refusals) assert.match(brief.validate(input(format)), re, JSON.stringify(format));

  const journal = memoryJournal();
  const { p, thread, seqId } = draft();
  const declared = { resolution: '1080p', ratio: '16:9', audio: false };
  const result = await brief.run({ input: input(declared), project: p, thread, ctx: { client: {}, modelId: null, requireSkillLine: async () => '', policy: policyValues(), rulebook: rb(), journal } });
  assert.equal(result.output.kind, 'brief', result.output.error);
  assert.deepEqual(sequenceById(result.project, seqId).brief.format, { fps: rb().ruleById('SCR-008').params.fps, ...declared });
  assert.equal(journal.writes[0].kind, 'gate.attempt');
  assert.ok(journal.writes[0].data.results.some((r) => r.ruleId === 'SCR-008' && r.pass));

  const noFps = books();
  noFps.screenwriting.rules.find((r) => r.id === 'SCR-008').params = {};
  const second = draft();
  await assert.rejects(
    () => brief.run({ input: input(declared), project: second.p, thread: second.thread, ctx: { client: {}, modelId: null, requireSkillLine: async () => '', policy: policyValues(), rulebook: loadRulebook(noFps, { checks: CHECKS }), journal: memoryJournal() } }),
    /E-TOOL-FPS/,
  );
});
