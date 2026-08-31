import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadRulebook } from '../../agents/director/rulebook.js';
import { CHECKS, runPlanGates, runMeasureGates } from '../../agents/director/gates.js';
import { feasibility, feasibleKs, validatePartition } from '../../agents/director/partition.js';

const books = () => ({
  cinematic: JSON.parse(fs.readFileSync('rules/cinematic.json', 'utf8')),
  screenwriting: JSON.parse(fs.readFileSync('rules/screenwriting.json', 'utf8')),
  metrics: JSON.parse(fs.readFileSync('rules/metrics.json', 'utf8')),
});
const rb = () => loadRulebook(books(), { checks: CHECKS });
const ctx = { maxSeconds: () => 30 };

const validPlan = () => ({
  slot: 'seedance25',
  brief: {
    logline: 'A wants X but B stands in the way.',
    targetSeconds: 12,
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
  beats: [{ id: 'b1', text: 'A tries' }, { id: 'b2', text: 'B answers' }],
  shots: [
    { id: 'sh1', sceneId: 's1', beatId: 'b1', setup: 'Wide Establisher', side: 'L', seconds: 6, location: 'PLACE-1', prompt: 'A moves. {Step aside.}', flags: [] },
    { id: 'sh2', sceneId: 's1', beatId: 'b2', setup: 'Close-Up', side: 'L', seconds: 6, location: 'PLACE-1', prompt: 'B does not move.', flags: [] },
  ],
  plates: [{ entity: 'B', prompt: 'a neutral plate' }],
});

test('the shipped rulebooks load, and every blocking rule has a check', () => {
  const book = rb();
  assert.equal(book.rules.length, 22);
  assert.ok(book.version.length === 8);
  assert.ok(book.rulesFor('screenplay', 'plan').length >= 4);
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
    joins: [{ from: 'sh1', to: 'sh2', distance: 9 }],
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
    joins: [{ from: 'sh1', to: 'sh2', distance: 64 }],
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
