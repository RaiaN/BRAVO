import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadRulebook } from '../../agents/director/rulebook.js';
import { CHECKS } from '../../agents/director/gates.js';
import { loadRubrics, readRubricBooks } from '../../agents/director/rubrics.js';
import { frozenSegments, exposureFrames, judge, takeQC, joinQC, filmQC, plateQC } from '../../agents/director/qc.js';
import { generateCandidates, scoreCandidate, selectCandidate } from '../../agents/director/candidates.js';
import { runNode } from '../../agents/director/nodes.js';
import { makeProject } from '../../state/project.js';
import { applyDeployModels } from '../../utils/film/suiteConfig.js';
import { validateCost, validateFinding } from '../../agents/journal.js';
import { JUDGE_PROTOCOL } from '../../agents/director/policy.js';

applyDeployModels({ seedance25: 'test-sd25', seedance: 'test-sd', seedream: 'test-sr', seedreamPro: 'test-srp', reasoner: 'test-r' });

const withIteration = (book) => ({
  ...book,
  rules: book.rules.map((r) => (r.provenance?.origin === 'note' && !r.provenance.iteration ? { ...r, provenance: { ...r.provenance, iteration: 'creator-decree-2026-08-31' } } : r)),
});
const books = () => ({
  cinematic: withIteration(JSON.parse(fs.readFileSync('rules/cinematic.json', 'utf8'))),
  screenwriting: withIteration(JSON.parse(fs.readFileSync('rules/screenwriting.json', 'utf8'))),
  metrics: JSON.parse(fs.readFileSync('rules/metrics.json', 'utf8')),
});
const rulebook = () => loadRulebook(books(), { checks: CHECKS });
const rubrics = () => loadRubrics(rulebook(), readRubricBooks());
const policy = (over = {}) => ({ ...JSON.parse(fs.readFileSync('policy/default.json', 'utf8')), ...over });
const style = () => ({ look: { style: 'a declared style', grade: 'a declared grade' } });
const shot = (over = {}) => ({ id: 's1', subject: 'FIGURE-1', force: 'the door stays shut', change: 'outside -> inside', setup: 'Wide Establisher', side: 'L', seconds: 6, location: 'PLACE-1', prompt: 'The first moment holds.', join: 'cut', beatId: 'b1', ...over });
const plates = () => [{ entity: 'FIGURE-1', role: 'character', url: '/api/film/media?key=aaaaaaaaaaaaaaaa.png' }];

const flatHash = '0'.repeat(64);
const hashAt = (n) => `${'1'.repeat(n)}${'0'.repeat(64 - n)}`;

const makeJournal = () => {
  const steps = [];
  const findings = [];
  let n = 0;
  return {
    steps,
    findings,
    async write(kind, data) { n += 1; steps.push({ step: n, kind, data }); return { step: n, at: new Date().toISOString() }; },
    intent(kind, data) { const intentId = `int${n + 1}`; this.write('intent', { intentId, intent: kind, ...data }); return intentId; },
    result(intentId, data) { return this.write('result', { intentId, ...data }); },
    async finding(row) { for (const k of ['finding_id', 'at', 'family', 'stage', 'severity', 'code', 'detail', 'evidence']) assert.ok(row[k] !== undefined, `finding lacks ${k}`); findings.push(row); },
    async media(name, url) { if (steps.some((s) => s.kind === 'media' && s.data.name === name)) throw new Error(`journal.media refuses to overwrite "${name}"`); steps.push({ step: (n += 1), kind: 'media', data: { name, url } }); return `media/${name}`; },
    async cost(row) { assert.deepEqual(validateCost(row), []); steps.push({ step: (n += 1), kind: 'cost', data: row }); },
    entries: (kind) => steps.filter((s) => !kind || s.kind === kind),
  };
};

const makeWire = ({ durations = {}, fps = {}, stats = () => ({}) } = {}) => {
  const calls = { measure: [], frames: [], stats: [], imagine: [] };
  const real = globalThis.fetch;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const stub = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes('/api/film/measure')) {
      calls.measure.push(body);
      const d = durations[body.url] !== undefined ? durations[body.url] : 6.04;
      return json({ duration: d, nbReadFrames: Math.round(d * 24), fps: fps[body.url] !== undefined ? fps[body.url] : 24, width: 1280, height: 720, hasAudio: true, firstHash: flatHash, lastHash: flatHash });
    }
    if (u.includes('/api/film/frames')) {
      calls.frames.push(body);
      return json({ frames: body.timestamps.map((t) => ({ t, url: `frame:${body.url}@${t}` })) });
    }
    if (u.includes('/api/film/image-stats')) {
      calls.stats.push(body.url);
      return json({ width: 2560, height: 1440, meanLuma: 120, blur: 40, dhash: flatHash, ...stats(body.url) });
    }
    if (u.includes('/api/film/imagine')) {
      calls.imagine.push(body);
      return json({ url: `https://x.test/c${calls.imagine.length}.png`, cacheUrl: `/api/film/media?key=${'c'.repeat(15)}${calls.imagine.length}.png` });
    }
    return real(url, init);
  };
  return { calls, install: () => { globalThis.fetch = stub; }, restore: () => { globalThis.fetch = real; } };
};

const PASS_NO = ['take.garbled-writing', 'take.stillness-seen', 'take.black-seen'];
const makeClient = (answers = {}) => {
  const calls = [];
  return {
    calls,
    async reason({ prompt, systemPrompt, images, nodeId }) {
      calls.push({ prompt, systemPrompt, images, nodeId });
      const fals = [...prompt.matchAll(/^\d+\. \[([^\]]+)\] .* Your answer: (.*)$/gm)];
      if (fals.length) return { content: JSON.stringify({ falsifications: fals.map((m) => ({ id: m[1], seen: true, frame: 0, note: 'seen here' })) }) };
      const qs = [...prompt.matchAll(/^\d+\. \[([^\]]+)\] .* Answer with one of: (.*)$/gm)];
      const out = qs.map((m) => {
        const id = m[1];
        const base = id.split(':')[0];
        const options = m[2].split(' | ');
        const pick = typeof answers[base] === 'function' ? answers[base](prompt) : answers[base];
        const answer = pick !== undefined ? pick : (PASS_NO.includes(base) ? 'no' : options[0]);
        return { id, answer, frame: 0, note: 'because' };
      });
      return { content: `\`\`\`json\n${JSON.stringify({ answers: out })}\n\`\`\`` };
    },
    async generateImage(args) {
      const res = await fetch('/api/film/imagine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      return res.json();
    },
  };
};

test('the rubric loader loads the shipped books, refuses an unknown ruleRef, and lists doctrine-only judgment rules', () => {
  const r = rubrics();
  assert.deepEqual(Object.keys(r.sets), ['plate', 'take', 'join', 'film']);
  assert.ok(r.questions.every((q) => q.evidenceRequired === true));
  assert.deepEqual(r.doctrineOnly, ['CIN-011', 'SCR-009', 'SCR-010']);
  assert.equal(r.version.length, 8);
  const bad = readRubricBooks();
  bad.take.questions[0].ruleRef = 'CIN-999';
  assert.throws(() => loadRubrics(rulebook(), bad), /ruleRef "CIN-999" is not a rule/);
  const loose = readRubricBooks();
  loose.plate.questions[0].evidenceRequired = false;
  assert.throws(() => loadRubrics(rulebook(), loose), /evidenceRequired must be true/);
  const dangling = readRubricBooks();
  dangling.take.questions[0].text = 'Is {subject} visible beside {entity}?';
  assert.throws(() => loadRubrics(rulebook(), dangling), /not a declared anchor/);
  const blank = readRubricBooks();
  delete blank.take.params.frozen.maxBits;
  assert.throws(() => loadRubrics(rulebook(), blank), /frozen.maxBits must be a finite number/);
});

test('candidates: a reservation precedes every still, each still is journaled and saved, the model is the default image slot', async () => {
  const wire = makeWire();
  const journal = makeJournal();
  const events = [];
  const reserve = async (r) => { events.push(`reserve:${r.kind}:${r.nodeId}`); assert.equal(r.units, 1); assert.ok(r.justification); return { id: `res_${events.length}`, ...r }; };
  const client = makeClient();
  const origImagine = client.generateImage;
  client.generateImage = async (args) => { events.push('imagine'); return origImagine(args); };
  wire.install();
  try {
    const made = await generateCandidates({ shot: shot(), plates: plates(), k: 3, attempt: 1, client, journal, reserve });
    assert.equal(made.length, 3);
    assert.deepEqual(events, ['reserve:still:keyframe:s1', 'imagine', 'reserve:still:keyframe:s1', 'imagine', 'reserve:still:keyframe:s1', 'imagine']);
    assert.ok(wire.calls.imagine.every((b) => b.model === 'test-srp' && b.size === '2560x1440' && b.referenceImages.length === 1));
    assert.equal(journal.entries('candidate').length, 3);
    assert.equal(journal.entries('media').length, 3);
    assert.equal(journal.entries('cost').length, 3, 'every paid still is a cost row');
    assert.ok(journal.entries('cost').every((c) => c.data.kind === 'still' && c.data.disposition === 'kept' && c.data.nodeId === 'keyframe:s1' && c.data.attempt === 1 && made.some((m) => m.id === c.data.candidateId)));
    assert.deepEqual(made.map((c) => c.id), ['s1-a1-c1', 's1-a1-c2', 's1-a1-c3']);
    assert.ok(made.every((c) => c.path === `media/candidate-${c.id}.png` && c.attempt === 1));
  } finally { wire.restore(); }
  const refusing = async () => { const err = new Error('E-BUDGET-MAXSTILLS'); err.code = 'E-BUDGET-MAXSTILLS'; throw err; };
  wire.install();
  try {
    await assert.rejects(() => generateCandidates({ shot: shot(), plates: plates(), k: 2, attempt: 1, client: makeClient(), journal: makeJournal(), reserve: refusing }), /E-BUDGET-MAXSTILLS/);
    assert.equal(wire.calls.imagine.length, 3, 'a refused reservation renders nothing');
  } finally { wire.restore(); }
  await assert.rejects(() => generateCandidates({ shot: shot(), plates: plates(), k: 2, client: makeClient(), journal: makeJournal(), reserve: async () => {} }), /attempt must be a positive integer/);
});

test('candidates: a second keyframe attempt for the same shot pays for stills the journal records — ids and media names carry the attempt', async () => {
  const wire = makeWire();
  const journal = makeJournal();
  const client = makeClient();
  let reservations = 0;
  const reserve = async (r) => ({ id: `res_${(reservations += 1)}`, ...r });
  wire.install();
  try {
    const first = await generateCandidates({ shot: shot(), plates: plates(), k: 2, attempt: 1, client, journal, reserve });
    const second = await generateCandidates({ shot: shot(), plates: plates(), k: 2, attempt: 2, client, journal, reserve });
    assert.equal(wire.calls.imagine.length, 4);
    assert.equal(journal.entries('candidate').length, 4, 'every paid still has its candidate step');
    assert.equal(journal.entries('media').length, 4);
    assert.equal(journal.entries('cost').length, 4);
    assert.deepEqual(second.map((c) => c.id), ['s1-a2-c1', 's1-a2-c2']);
    assert.ok(second.every((c) => c.attempt === 2 && !first.some((f) => f.id === c.id || f.path === c.path)));
    assert.equal(new Set(journal.entries('media').map((m) => m.data.name)).size, 4);
    await assert.rejects(() => generateCandidates({ shot: shot(), plates: plates(), k: 1, attempt: 2, client, journal, reserve }), /refuses to overwrite/);
  } finally { wire.restore(); }
});

test('scoring: near-duplicates among siblings, plate similarity and the frame rubric fold into one score', async () => {
  const wire = makeWire({ stats: (url) => (url.includes('c2') ? { dhash: hashAt(3) } : (url.includes('aaaa') ? { dhash: hashAt(32) } : {})) });
  const journal = makeJournal();
  const cands = [{ id: 's1-c1', url: '/api/film/media?key=cccccccccccccccc1.png' }, { id: 's1-c2', url: '/api/film/media?key=cccccccccccccccc2.png' }];
  wire.install();
  try {
    const client = makeClient();
    const r = await scoreCandidate({ candidate: cands[0], siblings: cands, shot: shot(), plates: plates(), style: style(), rubrics: rubrics(), policy: policy(), client, journal });
    assert.ok(client.calls.every((c) => c.nodeId === 'keyframe:s1'), 'every judge call names the keyframe node that spends it');
    assert.deepEqual(r.deterministic.duplicateOf, ['s1-c2']);
    assert.equal(r.deterministic.plateSimilarity, 0.5);
    assert.equal(r.rubric.asked, 6, 'frame-evidence questions only');
    assert.equal(r.rubric.score, 1);
    assert.equal(r.score, 0.5 * ((1 + 1 + 1 + 0 + 0.5) / 5) + 0.5);
    assert.equal(journal.entries('score').length, 1);
    assert.equal(journal.entries('judge').length, 2, 'both question orders');
  } finally { wire.restore(); }
});

test('selection: the best candidate wins with its reason journaled; a best under the floor is a journaled shortfall', async () => {
  const journal = makeJournal();
  const pol = policy();
  const scored = [{ id: 'a', url: 'u', score: 0.4 }, { id: 'b', url: 'u', score: 0.55 }, { id: 'c', url: 'u', score: 0.1 }];
  const r = await selectCandidate({ shot: shot(), candidates: scored, policy: pol, journal });
  assert.equal(r.winner.id, 'b');
  assert.deepEqual(r.ranked.map((c) => c.id), ['b', 'a', 'c']);
  assert.equal(r.shortfall.code, 'E-SELECT-FLOOR');
  assert.equal(journal.findings.length, 1);
  assert.equal(journal.findings[0].family, 'shortfall');
  assert.equal(journal.findings[0].candidateId, 'b');
  assert.equal(journal.entries('select')[0].data.ranked.length, 3);
  const ok = await selectCandidate({ shot: shot(), candidates: [{ id: 'a', url: 'u', score: 0.9 }], policy: pol, journal: makeJournal() });
  assert.equal(ok.shortfall, null);
  await assert.rejects(() => selectCandidate({ shot: shot(), candidates: [{ id: 'x', url: 'u' }], policy: pol, journal }), /carries no score/);
});

test('frozen segments come from consecutive dHash deltas; black and blown frames from luminance', () => {
  const frames = [
    { t: 0, dhash: hashAt(10) }, { t: 1, dhash: hashAt(11) }, { t: 2, dhash: hashAt(11) }, { t: 3, dhash: hashAt(12) },
    { t: 4, dhash: hashAt(40) }, { t: 5, dhash: hashAt(41) }, { t: 6, dhash: hashAt(60) },
  ];
  const segs = frozenSegments(frames, { maxBits: 2, minSeconds: 1 });
  assert.deepEqual(segs.map((s) => [s.from, s.to, s.seconds]), [[0, 3, 3], [4, 5, 1]]);
  assert.deepEqual(frozenSegments(frames, { maxBits: 2, minSeconds: 2 }).map((s) => [s.from, s.to]), [[0, 3]]);
  assert.deepEqual(frozenSegments(frames, { maxBits: 0, minSeconds: 1 }).map((s) => [s.from, s.to]), [[1, 2]]);
  const ex = exposureFrames([{ t: 0, meanLuma: 3 }, { t: 1, meanLuma: 128 }, { t: 2, meanLuma: 250 }], { black: { maxLuma: 16 }, blown: { minLuma: 240 } });
  assert.deepEqual(ex, { black: [0], blown: [2] });
  assert.throws(() => frozenSegments(frames, { maxBits: 2 }), /minSeconds/);
});

test('takeQC: black frames are detected and recorded; a moving take with clean rubric answers passes', async () => {
  const wire = makeWire({ stats: (url) => (url.includes('@') ? { dhash: hashAt(Number(url.split('@')[1]) * 8), ...(url.endsWith('@2') || url.endsWith('@3') ? { meanLuma: 4 } : {}) } : { dhash: hashAt(5) }) });
  const journal = makeJournal();
  const client = makeClient();
  wire.install();
  try {
    const r = await takeQC({ take: { id: 'tk1', url: 'take1.mp4' }, shot: shot(), keyframe: { url: '/api/film/media?key=kkkkkkkkkkkkkkkk.png' }, plates: plates(), style: style(), rubrics: rubrics(), policy: policy(), client, journal });
    assert.equal(r.pass, true);
    const black = r.findings.filter((f) => f.code === 'E-TAKE-BLACK');
    assert.equal(black.length, 1);
    assert.equal(black[0].severity, 'note', 'CIN-009 is calibrating: recorded, never blocking');
    assert.match(black[0].detail, /2 black frame\(s\) at 2, 3s/);
    assert.equal(r.deterministic.frozen.length, 0);
    assert.equal(r.deterministic.blackFraction, 0.286);
    assert.equal(r.deterministic.keyframeDistance, 5);
    assert.equal(client.calls.length, JUDGE_PROTOCOL.callsPerItem.base, 'both orders, nothing failed, no second offset — the protocol base the approval counts');
    assert.ok(client.calls.every((c) => c.nodeId === 'qc:s1'), 'every judge call names the qc node that spends it');
    assert.ok(client.calls.every((c) => c.images.length === 1 + 7), 'one plate reference plus seven frames at 1 fps across 6.04s');
    assert.equal(journal.entries('qc').length, 1);
    assert.ok(r.score > 0.5 && r.score < 1);
  } finally { wire.restore(); }
});

test('takeQC: a judge that contradicts the measurement becomes a judge-reliability row, never a film finding', async () => {
  const wire = makeWire({ stats: (url) => ({ dhash: hashAt(Number(url.split('@')[1]) * 8) }) });
  const journal = makeJournal();
  const client = makeClient({ 'take.stillness-seen': 'yes' });
  wire.install();
  try {
    const r = await takeQC({ take: { id: 'tk1', url: 'take1.mp4' }, shot: shot(), keyframe: null, plates: plates(), style: style(), rubrics: rubrics(), policy: policy(), client, journal });
    const contra = r.findings.filter((f) => f.code === 'E-JUDGE-CONTRADICTS-MEASURE');
    assert.equal(contra.length, 1);
    assert.equal(contra[0].family, 'judge-reliability');
    assert.equal(contra[0].rubricId, 'take.stillness-seen');
    assert.ok(!r.findings.some((f) => f.rubricId === 'take.stillness-seen' && f.family === 'qc'));
    assert.equal(r.rubric.verdicts['take.stillness-seen'].state, 'overruled');
    assert.equal(r.pass, true);
    assert.equal(client.calls.length, JUDGE_PROTOCOL.callsPerItem.max, 'primary both orders, second offset both orders, falsification — the protocol maximum the approval counts');
    assert.ok(client.calls[2].images.some((u) => u.endsWith('@0.5')), 'the second offset shifts the sample by half a period');
  } finally { wire.restore(); }
});

test('takeQC: a held artifact failure spends (blocker, regenerate); a held story failure is witness (note)', async () => {
  const wire = makeWire({ stats: (url) => ({ dhash: hashAt(Number(url.split('@')[1]) * 8) }) });
  const client = makeClient({ 'take.anatomy': 'extra limb', 'take.force-visible': 'no' });
  wire.install();
  try {
    const r = await takeQC({ take: { id: 'tk1', url: 'take1.mp4' }, shot: shot(), keyframe: null, plates: plates(), style: style(), rubrics: rubrics(), policy: policy(), client, journal: makeJournal() });
    assert.equal(r.pass, false);
    const anatomy = r.findings.find((f) => f.rubricId === 'take.anatomy');
    assert.equal(anatomy.severity, 'blocker');
    assert.equal(anatomy.disposition, 'regenerate');
    assert.equal(anatomy.ruleId, 'CIN-009');
    const force = r.findings.find((f) => f.rubricId === 'take.force-visible');
    assert.equal(force.severity, 'note');
    assert.equal(force.disposition, 'witness');
    assert.equal(force.ruleId, 'SCR-003');
    assert.equal(r.rubric.verdicts['take.anatomy'].falsification.frame, 0);
  } finally { wire.restore(); }
  const unstable = makeClient({ 'take.anatomy': (prompt) => (/^1\. \[take\.subject-present\]/m.test(prompt) ? 'extra limb' : 'clean') });
  wire.install();
  try {
    const r = await takeQC({ take: { id: 'tk1', url: 'take1.mp4' }, shot: shot(), keyframe: null, plates: plates(), style: style(), rubrics: rubrics(), policy: policy(), client: unstable, journal: makeJournal() });
    assert.equal(r.pass, true, 'an order-dependent answer decides nothing');
    assert.equal(r.findings.filter((f) => f.code === 'E-JUDGE-UNSTABLE').length, 1);
  } finally { wire.restore(); }
});

test('takeQC: a falsification re-ask the judge answers with garbage is a parse fault, not a withdrawal — the held failure stays a blocker', async () => {
  const wire = makeWire({ stats: (url) => ({ dhash: hashAt(Number(url.split('@')[1]) * 8) }) });
  const inner = makeClient({ 'take.anatomy': 'extra limb' });
  const client = {
    calls: inner.calls,
    async reason(args) {
      if (/Your answer:/m.test(args.prompt)) { inner.calls.push(args); return { content: 'I cannot answer in JSON right now' }; }
      return inner.reason(args);
    },
  };
  const journal = makeJournal();
  wire.install();
  try {
    const r = await takeQC({ take: { id: 'tk1', url: 'take1.mp4' }, shot: shot(), keyframe: null, plates: plates(), style: style(), rubrics: rubrics(), policy: policy(), client, journal });
    assert.equal(client.calls.length, JUDGE_PROTOCOL.callsPerItem.max);
    assert.equal(r.pass, false, 'a re-ask the harness cannot read withdraws nothing');
    assert.equal(r.regenerate, true);
    const v = r.rubric.verdicts['take.anatomy'];
    assert.equal(v.state, 'stable');
    assert.equal(v.pass, false);
    assert.equal(v.falsification.pointed, false);
    assert.match(v.falsification.malformed, /no JSON object/);
    const anatomy = r.findings.find((f) => f.rubricId === 'take.anatomy' && f.code === 'E-RUBRIC-FAIL');
    assert.equal(anatomy.severity, 'blocker');
    assert.equal(anatomy.disposition, 'regenerate');
    assert.match(anatomy.detail, /falsification re-ask malformed/);
    assert.ok(!r.findings.some((f) => f.code === 'E-JUDGE-UNFALSIFIED'), 'a parse fault is never reported as a judgment');
    const malformed = r.findings.filter((f) => f.code === 'E-JUDGE-MALFORMED');
    assert.equal(malformed.length, 1);
    assert.equal(malformed[0].family, 'judge-reliability');
    assert.equal(malformed[0].evidence[0].response, 'I cannot answer in JSON right now');
    const step = journal.entries('judge').find((s) => s.data.kind === 'falsification');
    assert.match(step.data.malformed, /no JSON object/);
  } finally { wire.restore(); }
});

test('takeQC: a shot whose force is none skips the force question; a wrong frame rate is a blocker', async () => {
  const wire = makeWire({ fps: { 'take1.mp4': 25 }, stats: (url) => ({ dhash: hashAt(Number(url.split('@')[1]) * 8) }) });
  const client = makeClient();
  wire.install();
  try {
    const r = await takeQC({ take: { id: 'tk1', url: 'take1.mp4' }, shot: shot({ force: 'none' }), keyframe: null, plates: plates(), style: style(), rubrics: rubrics(), policy: policy(), client, journal: makeJournal() });
    assert.deepEqual(r.rubric.skipped, ['take.force-visible']);
    assert.ok(!client.calls[0].prompt.includes('take.force-visible'));
    assert.equal(r.pass, false);
    assert.equal(r.findings.find((f) => f.code === 'E-TAKE-FPS').ruleId, 'CIN-004');
  } finally { wire.restore(); }
});

test('joinQC: the harness hands the judge the boundary; join findings are witness rows', async () => {
  const wire = makeWire({ durations: { 'a.mp4': 6.04, 'b.mp4': 6.04 } });
  const client = makeClient({ 'join.direction-holds': 'no' });
  const journal = makeJournal();
  wire.install();
  try {
    const r = await joinQC({ prev: { shotId: 's1', takeId: 'tk1', url: 'a.mp4' }, next: { shotId: 's2', takeId: 'tk2', url: 'b.mp4' }, joinType: 'cut', distance: 30, rubrics: rubrics(), policy: policy(), client, journal });
    assert.equal(r.boundaryIndex, 4);
    assert.equal(r.frames.length, 8);
    assert.match(client.calls[0].prompt, /boundary sits between frame 3 and frame 4/);
    assert.ok(client.calls.every((c) => c.nodeId === 'chain:s2'), 'every judge call names the chain node that spends it');
    assert.ok(!client.calls[0].prompt.includes('join.continuity-holds'), 'continuity is asked only of continuous joins');
    const dir = r.findings.find((f) => f.rubricId === 'join.direction-holds');
    assert.equal(dir.severity, 'note');
    assert.equal(dir.disposition, 'witness');
    assert.equal(dir.joinRef, 's1->s2');
    assert.equal(r.verdicts['join.image-changes'].state, 'stable', 'CIN-012 is uncalibrated: no contradiction possible');
    assert.ok(r.findings.every((f) => f.takeId === 'tk2'), 'a judged take names itself on every join finding');
    const held = await joinQC({ prev: { shotId: 's1', takeId: 'tk1', url: 'a.mp4' }, next: { shotId: 's2', takeId: null, url: 'b.mp4' }, joinType: 'cut', distance: 30, rubrics: rubrics(), policy: policy(), client, journal });
    assert.ok(held.findings.length > 0, 'the held failure is filed');
    for (const f of held.findings) {
      assert.equal('takeId' in f, false, `a side without a take carries no takeId key: ${JSON.stringify(f)}`);
      assert.deepEqual(validateFinding({ ...f, runId: 'run' }), [], 'every join finding passes the finding schema');
    }
  } finally { wire.restore(); }
  await assert.rejects(() => joinQC({ prev: {}, next: {}, joinType: 'fade', distance: 1, rubrics: rubrics(), policy: policy(), client, journal }), /joinType must be cut or continuous/);
});

test('filmQC: segment-wise judging never hands the judge more than the policy frame cap', async () => {
  const shots = ['s1', 's2', 's3', 's4'].map((id, i) => shot({ id, beatId: `b${i + 1}`, subject: i % 2 ? 'FIGURE-2' : 'FIGURE-1' }));
  const wire = makeWire({ durations: { 'slice.mp4': 24.1 } });
  const client = makeClient();
  const journal = makeJournal();
  const pol = policy({ judge: { ...policy().judge, maxFramesPerCall: 10 } });
  const screenplay = { scenes: [], beats: [1, 2, 3, 4].map((n) => ({ id: `b${n}`, text: `beat ${n} happens` })) };
  wire.install();
  try {
    const r = await filmQC({ slice: { url: 'slice.mp4' }, manifest: { targetSeconds: 24, shots }, screenplay, style: style(), rubrics: rubrics(), policy: pol, client, journal });
    assert.ok(client.calls.length >= 6);
    assert.ok(client.calls.every((c) => c.nodeId === 'final'), 'every judge call names the final node that spends it');
    assert.ok(client.calls.every((c) => c.images.length <= 10), `frames per call: ${client.calls.map((c) => c.images.length).join(',')}`);
    assert.deepEqual(r.calls.map((c) => c.frames), [6, 6, 6, 6, 8]);
    assert.ok(Object.keys(r.verdicts).includes('film.beat-lands:s3'));
    assert.ok(Object.keys(r.verdicts).includes('film.cast-holds:FIGURE-2'));
    assert.equal(r.findings.length, 0);
    assert.equal(journal.entries('qc').length, 1);
  } finally { wire.restore(); }
  await assert.rejects(() => filmQC({ slice: { url: 'slice.mp4' }, manifest: { targetSeconds: 24, shots }, screenplay: { scenes: [] }, style: style(), rubrics: rubrics(), policy: pol, client, journal }), /screenplay.beats is required/);
});

const plateNodeContext = ({ wire, journal, policy: pol, flow = 'policy' }) => {
  const reservations = [];
  let project = makeProject();
  let run = { spentRenders: 0, takes: {} };
  const nodes = { 'plate:FIGURE-1': { status: 'running', attempts: 1, value: null } };
  const client = makeClient({ 'plate.integrity': () => (wire.calls.imagine.length === 1 ? 'distorted anatomy' : 'clean') });
  const ctx = {
    flow, policy: pol, concurrency: pol.concurrency, poll: pol.poll, plan: { shots: [] }, seqId: 'seq1', brief: {}, threadId: 't1', messageId: 'm1', runId: 'run-test', client, rulebook: rulebook(), style: style(), rubrics: rubrics(),
    manifest: { plates: [{ entity: 'FIGURE-1', role: 'character', prompt: 'A neutral plate of the figure.', model: 'seedream' }], shots: [] },
    stages: { plateQC, generateCandidates, scoreCandidate, selectCandidate, takeQC },
    project: () => project, apply: (fn) => { project = fn(project) || project; }, run: () => run, node: (id) => nodes[id], setNode: (id, patch) => { nodes[id] = { ...nodes[id], ...patch }; }, patchRun: (fn) => { run = { ...run, ...fn(run) }; }, recordGates: () => {}, say: () => {},
    journal, reserve: (r) => { const record = { id: `res_${reservations.length + 1}`, ...r }; reservations.push(record); return record; },
  };
  return { ctx, client, reservations, project: () => project };
};

test('the plate node: a plate whose artifact question fails is re-rendered within policy.attempts.plate; both verdicts, the regeneration, the waste and the promoted plate are journaled', async () => {
  const wire = makeWire();
  const journal = makeJournal();
  const { ctx, client, reservations, project } = plateNodeContext({ wire, journal, policy: policy() });
  wire.install();
  let out;
  try { out = await runNode(ctx, 'plate:FIGURE-1'); } finally { wire.restore(); }
  assert.equal(wire.calls.imagine.length, 2, 'the failing plate was rendered again once');
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every((r) => r.nodeId === 'plate:FIGURE-1' && r.kind === 'still'));
  assert.ok(client.calls.length > 0 && client.calls.every((c) => c.nodeId === 'plate:FIGURE-1'), 'every judge call names the plate node');
  const verdicts = journal.entries('qc').map((s) => s.data);
  assert.deepEqual(verdicts.map((v) => [v.kind, v.entity, v.pass]), [['plate', 'FIGURE-1', false], ['plate', 'FIGURE-1', true]]);
  assert.deepEqual(journal.entries('plate').map((s) => [s.data.attempt, s.data.pass]), [[1, false], [2, true]]);
  const failed = journal.findings.find((f) => f.code === 'E-RUBRIC-FAIL' && f.rubricId === 'plate.integrity');
  assert.ok(failed && failed.stage === 'plate' && failed.severity === 'blocker' && failed.disposition === 'regenerate');
  assert.deepEqual(journal.entries('regeneration').map((s) => [s.data.entity, s.data.attempt, s.data.mode]), [['FIGURE-1', 1, 'plate-rerender']]);
  const costs = journal.entries('cost').map((s) => s.data).filter((c) => c.kind === 'still');
  assert.deepEqual(costs.map((c) => [c.disposition, c.code || null, c.attempt]), [['kept', null, 1], ['kept', null, 2], ['wasted', 'E-WASTE-QC-REGENERATED', 1]]);
  assert.deepEqual(journal.entries('media').map((s) => s.data.name), ['plate-FIGURE_1-a1-attempt1.png', 'plate-FIGURE_1-a1-attempt2.png', 'plate-FIGURE_1.png']);
  assert.deepEqual({ attempt: out.value.attempt, pass: out.value.pass, url: out.value.url }, { attempt: 2, pass: true, url: `/api/film/media?key=${'c'.repeat(15)}2.png` });
  assert.equal(project().bible.at(-1).plateUrl, out.value.url);
  assert.equal(journal.entries('completionDecision').length, 0);
});

test('the plate node: a plate that fails on every attempt exhausts policy.attempts.plate, journals the completion decision and a named shortfall, and promotes the best score', async () => {
  const wire = makeWire();
  const journal = makeJournal();
  const { ctx } = plateNodeContext({ wire, journal, policy: policy({ attempts: { ...policy().attempts, plate: 2 } }) });
  ctx.client = makeClient({ 'plate.integrity': 'garbled writing' });
  wire.install();
  let out;
  try { out = await runNode(ctx, 'plate:FIGURE-1'); } finally { wire.restore(); }
  assert.equal(wire.calls.imagine.length, 2);
  const decision = journal.entries('completionDecision').map((s) => s.data);
  assert.deepEqual(decision.map((d) => [d.entity, d.decision, d.cause, d.attempts, d.budget]), [['FIGURE-1', 'promote-best', 'exhausted-plate', 2, 2]]);
  const shortfall = journal.findings.find((f) => f.code === 'E-PLATE-ATTEMPTS-EXHAUSTED');
  assert.ok(shortfall && shortfall.stage === 'plate' && shortfall.family === 'shortfall' && shortfall.severity === 'blocker' && shortfall.attempt === 2);
  const wasted = journal.entries('cost').map((s) => s.data).filter((c) => c.disposition === 'wasted');
  assert.deepEqual(wasted.map((c) => [c.code, c.attempt]), [['E-WASTE-NOT-PROMOTED', 2]]);
  assert.deepEqual({ attempt: out.value.attempt, pass: out.value.pass }, { attempt: 1, pass: false });
});

test('the plate node: the approved-card flow renders without a judge and journals that the verdict was skipped', async () => {
  const wire = makeWire();
  const journal = makeJournal();
  const { ctx } = plateNodeContext({ wire, journal, policy: policy(), flow: 'card' });
  wire.install();
  let out;
  try { out = await runNode(ctx, 'plate:FIGURE-1'); } finally { wire.restore(); }
  assert.equal(wire.calls.imagine.length, 1);
  assert.equal(journal.entries('qc').length, 0);
  const steps = journal.entries('plate').map((s) => s.data);
  assert.equal(steps.length, 1);
  assert.ok(typeof steps[0].skipped === 'string' && steps[0].skipped.length > 0 && steps[0].pass === null);
  assert.deepEqual({ attempt: out.value.attempt, pass: out.value.pass }, { attempt: 1, pass: null });
});

test('judge: a call without a plan node id throws by name before any model call', async () => {
  const client = makeClient();
  const questions = rubrics().forSet('plate');
  await assert.rejects(() => judge({ client, journal: makeJournal(), rubrics: rubrics(), questions, frames: [{ t: 0, url: 'x.png' }], references: [], context: 'c', label: 'l', frameRate: 0, offsetFrames: async () => [], finding: {} }), /E-JUDGE-NO-NODE/);
  assert.equal(client.calls.length, 0);
});

test('image-stats: concurrent gray decodes at the same dimensions never share a scratch file, and a decode without a scratch dir refuses by name', async () => {
  const { createRequire } = await import('node:module');
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const { grayFrame, scratchDir, lumaAndBlur } = await import('../../pages/api/film/image-stats.js');
  const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
  const dirs = [scratchDir(), scratchDir()];
  const sources = ['black', 'white'].map((color, i) => {
    const file = path.join(dirs[i], `source.png`);
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=32x32`, '-frames:v', '1', '-y', file]);
    return file;
  });
  try {
    assert.notEqual(dirs[0], dirs[1]);
    assert.ok(dirs.every((d) => d.startsWith(path.join(os.tmpdir(), 'bravo-image-stats-'))));
    const rounds = await Promise.all([0, 1, 2, 3].map(async () => {
      const [black, white] = await Promise.all(sources.map((file, i) => grayFrame(ffmpeg, file, 9, 8, dirs[i])));
      return [lumaAndBlur(black, 9, 8).meanLuma, lumaAndBlur(white, 9, 8).meanLuma];
    }));
    for (const [black, white] of rounds) {
      assert.ok(black < 20, `black source measured ${black}`);
      assert.ok(white > 235, `white source measured ${white}`);
    }
    await assert.rejects(() => grayFrame(ffmpeg, sources[0], 9, 8), /grayFrame 9x8 requires a scratch dir/);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
