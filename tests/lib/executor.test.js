import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendMessage, latchThread, makeProject, makeSequence, sequenceById, touch } from '../../state/project.js';
import { runSequence, manifestOf, fnv1a } from '../../agents/director/execute.js';
import { applyDeployModels } from '../../utils/film/suiteConfig.js';
import { loadRulebook } from '../../agents/director/rulebook.js';
import { CHECKS } from '../../agents/director/gates.js';
import fs from 'node:fs';

applyDeployModels({ seedance25: 'test-sd25', seedance: 'test-sd', seedream: 'test-sr', seedreamPro: 'test-srp', reasoner: 'test-r' });

const RULES = {
  cinematic: JSON.parse(fs.readFileSync('rules/cinematic.json', 'utf8')),
  screenwriting: JSON.parse(fs.readFileSync('rules/screenwriting.json', 'utf8')),
  metrics: JSON.parse(fs.readFileSync('rules/metrics.json', 'utf8')),
};
const RULEBOOK = loadRulebook(RULES, { checks: CHECKS });

const plan = () => ({
  slot: 'seedance25',
  shots: [
    { id: 's1', sceneId: 'sc1', beatId: 'b1', setup: 'Wide Establisher', side: 'L', seconds: 6, location: 'PLACE-1', prompt: 'The first moment holds.', flags: [] },
    { id: 's2', sceneId: 'sc1', beatId: 'b2', setup: 'Close-Up', side: 'L', seconds: 6, location: 'PLACE-1', join: 'continuous', prompt: 'The second moment lands.', flags: [] },
  ],
  plates: [{ entity: 'FIGURE-1', role: 'character', prompt: 'A neutral plate of the figure.', model: 'seedream' }],
});

const seedProject = () => {
  let p = makeProject();
  const seq = makeSequence({
    brief: {
      logline: 'A figure crosses a threshold.', targetSeconds: 12,
      format: { fps: 24, resolution: '720p', ratio: 'adaptive', audio: true },
      cast: [{ name: 'FIGURE-1', bibleEntryId: 'new' }], locations: [{ name: 'PLACE-1', bibleEntryId: 'bib_p' }],
      dramatis: { protagonist: 'FIGURE-1', want: 'through', opposition: 'the threshold' },
      seed: 7,
    },
    plan: plan(),
    rulebookVersion: 'testver',
    status: 'planned',
  });
  p = touch({ ...p, sequences: [seq] });
  const threadId = p.threads[0].id;
  p = latchThread(p, threadId, 'director', { subjectId: seq.id, title: 't' }).project;
  p = appendMessage(p, threadId, {
    role: 'tool', text: '',
    tool: { name: 'sequence', input: {}, card: { tool: 'sequence', manifest: manifestOf(seq, RULEBOOK), manifestHash: fnv1a(JSON.stringify(manifestOf(seq, RULEBOOK))) }, output: null, approved: true, cost: 0 },
  });
  const messageId = p.threads[0].messages.at(-1).id;
  return { p, threadId, messageId, seqId: seq.id };
};

const makeWire = (opts = {}) => {
  const calls = { animate: [], measure: [], stitch: [], imagine: [], polls: [] };
  let taskN = 0;
  const durations = { ...opts.durations };
  const fpsFor = { ...opts.fps };
  const real = globalThis.fetch;
  const stub = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/api/rules')) return json(RULES);
    if (u.includes('/api/film/imagine')) {
      calls.imagine.push(body);
      return json({ url: 'https://x.test/raw.jpg', cacheUrl: `/api/film/media?key=plate${calls.imagine.length}.jpg`, assetId: 'asset-p1' });
    }
    if (u.includes('/api/seedance-status')) {
      const id = new URL(u, 'http://t').searchParams.get('taskId');
      calls.polls.push(id);
      return json({ status: 'succeeded', video_url: `https://x.test/${id}.mp4`, video_cache_url: `/api/film/media?key=${id}.mp4`, last_frame_url: `https://x.test/${id}.jpg`, last_frame_cache_url: `/api/film/media?key=${id}.jpg` });
    }
    if (u.includes('/api/seedance')) {
      calls.animate.push(body);
      taskN += 1;
      return json({ id: `task${taskN}` });
    }
    if (u.includes('/api/film/measure')) {
      calls.measure.push(body);
      const key = body.url;
      const n = calls.measure.length;
      const requested = durations[key] !== undefined ? durations[key] : (key.includes('slice') ? 12.08 : 6.04);
      return json({
        duration: requested,
        nbReadFrames: Math.round(requested * 24),
        fps: fpsFor[key] !== undefined ? fpsFor[key] : 24,
        width: 1280, height: 720, hasAudio: true,
        firstHash: `${'10'.repeat(32)}`.slice(0, 64),
        lastHash: `${'10'.repeat(32)}`.slice(0, 64),
      });
    }
    if (u.includes('/api/film/stitch')) {
      calls.stitch.push(body);
      return json({ url: 'https://x.test/slice.mp4', cacheUrl: '/api/film/media?key=slice.mp4' });
    }
    return real(url, init);
  };
  return { calls, install: () => { globalThis.fetch = stub; }, restore: () => { globalThis.fetch = real; } };
};

const client = () => ({
  async generateImage(args) {
    const res = await fetch('/api/film/imagine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    return res.json();
  },
  async startVideo(args) {
    const res = await fetch('/api/seedance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const d = await res.json();
    return { taskId: d.id };
  },
  async pollVideo({ taskId }) {
    const res = await fetch(`/api/seedance-status?taskId=${taskId}`);
    const d = await res.json();
    return { videoUrl: d.video_url, videoCacheUrl: d.video_cache_url, lastFrameUrl: d.last_frame_url, lastFrameCacheUrl: d.last_frame_cache_url };
  },
});

const drive = async ({ p, threadId, messageId }, wire) => {
  wire.install();
  let state = p;
  try {
    await runSequence({ client: client(), threadId, messageId, get: () => state, apply: (fn) => { state = fn(state) || state; } });
  } finally {
    wire.restore();
  }
  return state;
};

test('the full DAG runs to assembled: plates, chained shoots, measures, joins, stitch, final gate, record', async () => {
  const seeded = seedProject();
  const wire = makeWire();
  const state = await drive(seeded, wire);
  const seq = sequenceById(state, seeded.seqId);

  assert.equal(seq.status, 'assembled');
  assert.equal(wire.calls.imagine.length, 1, 'one plate rendered');
  assert.equal(wire.calls.animate.length, 2, 'two takes rendered');
  assert.equal(wire.calls.animate[0].content.some((c) => c.role === 'first_frame'), false, 'shot 1 is unchained');
  assert.ok(wire.calls.animate[1].content.some((c) => c.role === 'first_frame'), 'shot 2 chains from shot 1');
  assert.equal(wire.calls.animate[1].content.find((c) => c.role === 'first_frame').image_url.url, '/api/film/media?key=task1.jpg', 'the chain uses the recorded durable last frame');
  assert.ok(wire.calls.animate.every((b) => !('ratio' in b) || b.ratio), 'wire bodies well formed');

  assert.equal(seq.shotIds.length, 2);
  const shots = seq.shotIds.map((id) => state.film.shots.find((s) => s.id === id));
  assert.ok(shots.every((s) => s.ownedBy === seq.id && s.takes.length === 1));
  assert.equal(shots[0].takes[0].promptUsed, 'The first moment holds.', 'the prompt is the prompt');

  assert.equal(state.bible.at(-1).name, 'FIGURE-1');
  assert.equal(state.bible.at(-1).assetId, 'asset-p1');

  assert.equal(seq.iterations.length, 1);
  const it = seq.iterations[0];
  assert.equal(it.status, 'assembled');
  assert.equal(it.cost.renders, 3);
  assert.equal(it.measurements.perShot.length, 2);
  assert.equal(it.measurements.joins.length, 1);
  assert.equal(typeof it.measurements.joins[0].distance, 'number');
  assert.ok(it.gates.some((g) => g.ruleId === 'CIN-008' && g.pass));
  assert.equal(it.inputs.prompts.length, 2);
});

test('a short take consumes the retry pool and re-renders; exhaustion halts at the named node', async () => {
  const seeded = seedProject();
  const wire = makeWire({ durations: { '/api/film/media?key=task1.mp4': 5.0 } });
  let fixed = false;
  const origInstall = wire.install;
  wire.install = () => {
    origInstall();
    const cur = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/api/film/measure') && !fixed) {
        const body = JSON.parse(init.body);
        if (body.url === '/api/film/media?key=task2.mp4') fixed = true;
      }
      return cur(url, init);
    };
  };
  const state = await drive(seeded, wire);
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));
  assert.equal(wire.calls.animate.length, 3, 'shot 1 re-rendered once');
  assert.equal(seq.run.retryPoolLeft, 1);
  assert.equal(seq.iterations[0].cost.retriesUsed, 1);
});

test('a wrong frame rate is deterministic: halts immediately, burns no retries', async () => {
  const seeded = seedProject();
  const wire = makeWire({ fps: { '/api/film/media?key=task1.mp4': 25 } });
  const state = await drive(seeded, wire);
  const seq = sequenceById(state, seeded.seqId);
  assert.notEqual(seq.status, 'assembled');
  assert.equal(seq.run.halted.ruleId, 'CIN-004');
  assert.equal(seq.run.retryPoolLeft, 2, 'no retry burned on a model property');
  assert.equal(wire.calls.animate.length, 1, 'no re-render attempted');
  assert.equal(seq.iterations.length, 1);
  assert.deepEqual(seq.iterations[0].status, { halted: { node: 'measure:s1', ruleId: 'CIN-004', reason: seq.run.halted.reason } });
});

test('resume skips done nodes: a rerun after interruption renders only what is missing', async () => {
  const seeded = seedProject();
  const wire = makeWire();
  wire.install();
  let state = seeded.p;
  const apply = (fn) => { state = fn(state) || state; };
  const get = () => state;
  const c = client();
  const origPoll = c.pollVideo.bind(c);
  let polls = 0;
  c.pollVideo = async (args) => {
    polls += 1;
    if (polls === 2) throw new Error('tab closed');
    return origPoll(args);
  };
  await runSequence({ client: c, threadId: seeded.threadId, messageId: seeded.messageId, get, apply });
  wire.restore();
  let seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'halted');
  const animatesBefore = wire.calls.animate.length;

  apply((prev) => {
    const q = sequenceById(prev, seeded.seqId);
    const nodes = { ...q.run.nodes };
    delete nodes['shoot:s2'];
    return {
      ...prev,
      sequences: prev.sequences.map((x) => (x.id === seeded.seqId ? { ...x, status: 'executing', run: { ...q.run, halted: null, nodes } } : x)),
    };
  });
  wire.install();
  await runSequence({ client: client(), threadId: seeded.threadId, messageId: seeded.messageId, get, apply });
  wire.restore();
  seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled');
  assert.equal(wire.calls.animate.length, animatesBefore + 1, 'only the missing shot re-rendered');
  assert.equal(wire.calls.imagine.length, 1, 'the plate was NOT re-rendered on resume');
});

test('a changed plan after approval halts at the manifest, before any money', async () => {
  const seeded = seedProject();
  let state = seeded.p;
  state = {
    ...state,
    sequences: state.sequences.map((q) => (q.id === seeded.seqId
      ? { ...q, run: { manifestHash: 'stale123', messageId: seeded.messageId, threadId: seeded.threadId, startedAt: 'x', nodes: {}, spentRenders: 0, retryPoolLeft: 2, silentShots: [], runs: [], gateResults: [] } }
      : q)),
  };
  const wire = makeWire();
  const out = await drive({ p: state, threadId: seeded.threadId, messageId: seeded.messageId }, wire);
  const seq = sequenceById(out, seeded.seqId);
  assert.equal(seq.status, 'halted');
  assert.match(seq.run.halted.reason, /changed after approval/);
  assert.equal(wire.calls.animate.length, 0);
  assert.equal(wire.calls.imagine.length, 0);
});

test('a plan whose shot ids are not the node strings halts by name, before any shoot', async () => {
  let p = makeProject();
  const numericPlan = plan();
  numericPlan.shots = numericPlan.shots.map((sh, i) => ({ ...sh, id: i + 1 }));
  numericPlan.plates = [];
  const seq = makeSequence({
    brief: {
      logline: 'A figure crosses a threshold.', targetSeconds: 12,
      format: { fps: 24, resolution: '720p', ratio: 'adaptive', audio: true },
      cast: [{ name: 'FIGURE-1', bibleEntryId: 'new' }], locations: [{ name: 'PLACE-1', bibleEntryId: 'bib_p' }],
      dramatis: { protagonist: 'FIGURE-1', want: 'through', opposition: 'the threshold' },
      seed: 7,
    },
    plan: numericPlan,
    rulebookVersion: 'testver',
    status: 'planned',
  });
  p = touch({ ...p, sequences: [seq] });
  const threadId = p.threads[0].id;
  p = latchThread(p, threadId, 'director', { subjectId: seq.id, title: 't' }).project;
  p = appendMessage(p, threadId, {
    role: 'tool', text: '',
    tool: { name: 'sequence', input: {}, card: { tool: 'sequence', manifest: manifestOf(seq, RULEBOOK), manifestHash: fnv1a(JSON.stringify(manifestOf(seq, RULEBOOK))) }, output: null, approved: true, cost: 0 },
  });
  const messageId = p.threads[0].messages.at(-1).id;
  const wire = makeWire({});
  const state = await drive({ p, threadId, messageId, seqId: seq.id }, wire);
  const q = sequenceById(state, seq.id);
  assert.notEqual(q.status, 'assembled');
  assert.match(q.run.halted.reason, /not in the manifest.*named for/s);
  assert.equal(wire.calls.animate.length, 0, 'no render money was spent on a broken plan');
});

const POLICY = JSON.parse(fs.readFileSync('policy/default.json', 'utf8'));

const policyPlan = () => ({
  slot: 'seedance25',
  shots: [
    { id: 's1', sceneId: 'sc1', beatId: 'b1', setup: 'Wide Establisher', side: 'L', seconds: 6, location: 'PLACE-1', join: null, subject: 'FIGURE-1', force: 'the threshold resists', change: 'still -> moving', prompt: 'The first moment holds.', flags: [], keyframe: { needed: true, reason: 'the first shot anchors identity and setup' } },
    { id: 's2', sceneId: 'sc1', beatId: 'b2', setup: 'Close-Up', side: 'L', seconds: 6, location: 'PLACE-1', join: 'cut', subject: 'FIGURE-1', force: 'the threshold resists', change: 'moving -> stopped', prompt: 'The second moment lands.', flags: [], keyframe: { needed: true, reason: 'a cut re-anchors identity and setup' } },
    { id: 's3', sceneId: 'sc1', beatId: 'b3', setup: 'Medium', side: 'L', seconds: 6, location: 'PLACE-1', join: 'continuous', subject: 'FIGURE-1', force: 'the threshold gives', change: 'stopped -> through', prompt: 'The third moment carries through.', flags: [], keyframe: { needed: false, reason: 'a continuous shot starts from the recorded last frame' } },
  ],
  plates: [{ entity: 'FIGURE-1', role: 'character', prompt: 'A neutral plate of the figure.', model: 'seedream' }],
});

const seedPassProject = () => {
  let p = makeProject();
  const seq = makeSequence({
    brief: {
      logline: 'A figure crosses a threshold.', targetSeconds: 18,
      format: { fps: 24, resolution: '720p', ratio: 'adaptive', audio: true },
      cast: [{ name: 'FIGURE-1', bibleEntryId: 'new' }], locations: [{ name: 'PLACE-1', bibleEntryId: 'bib_p' }],
      dramatis: { protagonist: 'FIGURE-1', want: 'through', opposition: 'the threshold' },
      seed: 7,
    },
    plan: policyPlan(),
    rulebookVersion: 'testver',
    status: 'planned',
  });
  p = touch({ ...p, sequences: [seq] });
  const threadId = p.threads[0].id;
  p = latchThread(p, threadId, 'director', { subjectId: seq.id, title: 't' }).project;
  p = appendMessage(p, threadId, {
    role: 'tool', text: '',
    tool: { name: 'sequence', input: {}, card: { tool: 'sequence', manifest: manifestOf(seq, RULEBOOK), manifestHash: fnv1a(JSON.stringify(manifestOf(seq, RULEBOOK))) }, output: null, approved: true, cost: 0 },
  });
  const messageId = p.threads[0].messages.at(-1).id;
  return { p, threadId, messageId, seqId: seq.id };
};

const memJournal = () => {
  const rows = [];
  const j = {
    rows,
    write: (kind, data) => { rows.push({ kind, ...data }); return { step: rows.length, at: 'now' }; },
    intent: (kind, data) => { const intentId = `int${rows.length + 1}`; j.write('intent', { intentId, intent: kind, ...data }); return intentId; },
    result: (intentId, data) => j.write('result', { intentId, ...data }),
    finding: (row) => j.write('finding', row),
    cost: ({ kind, ...row }) => j.write('cost', { ...row, unit: kind }),
    media: (name, url) => { j.write('media', { name, url }); return name; },
    entries: (kind) => rows.filter((r) => !kind || r.kind === kind),
  };
  return j;
};

const stubStages = ({ qcPlan = {}, platePlan = {}, selectFloor = null } = {}) => {
  const calls = { generate: [], score: [], select: [], qc: [], plateQC: [] };
  let cand = 0;
  const stages = {
    plateQC: async ({ plate, style, rubrics, policy }) => {
      const n = calls.plateQC.filter((q) => q.entity === plate.entity).length;
      calls.plateQC.push({ entity: plate.entity, url: plate.url, attempt: plate.attempt, style: !!style, rubrics: !!rubrics, policy: !!policy });
      const verdict = (platePlan[plate.entity] || [])[n] || { pass: true, score: 0.9 };
      return { ...verdict, findings: verdict.pass ? [] : [{ code: 'E-RUBRIC-FAIL', rubricId: 'PLATE-ID-1' }] };
    },
    generateCandidates: async ({ shot, plates, k, reserve }) => {
      calls.generate.push({ shot: shot.id, k, plates: plates.map((pl) => pl.url) });
      reserve({ nodeId: `keyframe:${shot.id}`, kind: 'still', units: k, justification: `${k} keyframe candidates for ${shot.id}` });
      return Array.from({ length: k }, () => { cand += 1; return { id: `cand-${cand}`, url: `/api/film/media?key=cand-${cand}.png`, path: `media/cand-${cand}.png` }; });
    },
    scoreCandidate: async ({ candidate }) => { calls.score.push(candidate.id); return { score: Number(candidate.id.slice(5)) / 100, deterministic: {}, rubric: {} }; },
    selectCandidate: async ({ shot, candidates }) => {
      calls.select.push({ shot: shot.id, candidates: candidates.map((c) => c.id) });
      const ranked = [...candidates].sort((a, b) => b.score - a.score);
      const shortfall = selectFloor !== null && ranked[0].score < selectFloor ? { code: 'E-SELECT-FLOOR', floor: selectFloor, best: ranked[0].score } : null;
      return { winner: ranked[0], ranked, shortfall };
    },
    takeQC: async ({ take, shot, keyframe }) => {
      const n = calls.qc.filter((q) => q.shot === shot.id).length;
      calls.qc.push({ shot: shot.id, takeId: take.takeId, url: take.url, attempt: take.attempt, keyframe: keyframe ? keyframe.candidateId : null });
      const verdict = (qcPlan[shot.id] || [])[n] || { pass: true, score: 0.9 };
      return { ...verdict, findings: verdict.pass ? [] : [{ code: 'E-QC-MORPHING', rubricId: 'TAKE-ART-1' }] };
    },
  };
  return { calls, stages };
};

const passFor = ({ journal, stages, policy = POLICY }) => {
  const reservations = [];
  return {
    pass: {
      policy, journal, stages, style: { look: { style: 'test', grade: 'flat' } }, rubrics: {}, rulebook: RULEBOOK, runId: 'run-test',
      reserve: (r) => { if (!r.nodeId) throw new Error('E-RESERVE-NO-NODE'); const record = { id: `res_${reservations.length + 1}`, ...r }; reservations.push(record); return record; },
    },
    reservations,
  };
};

const drivePass = async ({ p, threadId, messageId }, wire, pass) => {
  wire.install();
  let state = p;
  try {
    await runSequence({ client: client(), threadId, messageId, get: () => state, apply: (fn) => { state = fn(state) || state; }, pass });
  } finally {
    wire.restore();
  }
  return state;
};

test('a policy pass: cut shots shoot from a promoted keyframe with no references, continuous shots from the last frame, a failing QC regenerates (same keyframe, then a new candidate) and exhaustion promotes the best take', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1 } });
  const journal = memJournal();
  const { calls, stages } = stubStages({ qcPlan: { s2: [{ pass: false, score: 0.3 }, { pass: false, score: 0.7 }, { pass: false, score: 0.5 }] } });
  const { pass, reservations } = passFor({ journal, stages, policy: { ...POLICY, attempts: { ...POLICY.attempts, shot: 3 } } });
  const state = await drivePass(seeded, wire, pass);
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));

  const firstFrame = (b) => b.content.find((c) => c.role === 'first_frame')?.image_url?.url || null;
  const refs = (b) => b.content.filter((c) => c.role === 'reference_image');
  const byPrompt = (text) => wire.calls.animate.filter((b) => b.content[0].text.includes(text));
  const s1 = byPrompt('The first moment holds.');
  const s2 = byPrompt('The second moment lands.');
  const s3 = byPrompt('The third moment carries through.');
  assert.equal(s1.length, 1);
  assert.equal(s2.length, 3, 'shot 2 rendered three times within its attempt budget');
  assert.ok(s1.concat(s2).every((b) => /cand-\d+\.png/.test(firstFrame(b)) && refs(b).length === 0), 'cut shots carry the promoted keyframe as the first frame and no references');
  assert.ok(s3.every((b) => /task\d+\.jpg/.test(firstFrame(b)) && refs(b).length === 0), 'the continuous shot carries the previous take’s last frame and no references');

  assert.deepEqual(calls.generate.map((g) => g.shot).sort(), ['s1', 's2', 's2'], 'candidates once per cut shot, again for s2’s new-candidate regeneration; none for the continuous shot');
  assert.equal(calls.generate[0].shot, 's2', 'the longer chain storyboards first');
  assert.ok(calls.generate.every((g) => g.k === POLICY.candidates.perShot && g.plates.length === 1));
  const s2Selects = calls.select.filter((s) => s.shot === 's2');
  assert.equal(s2Selects.length, 2);
  const firstS2Winner = seq.run.nodes['keyframe:s2'].rejected[0];
  assert.ok(!s2Selects[1].candidates.includes(firstS2Winner), 'the rejected keyframe is not offered again');
  assert.ok(s2Selects[1].candidates.some((id) => s2Selects[0].candidates.includes(id)), 'the earlier losers stay in the pool');

  const ledger = seq.run.takes.s2;
  assert.deepEqual(ledger.map((t) => t.score), [0.3, 0.7, 0.5]);
  assert.deepEqual(ledger.map((t) => t.pass), [false, false, false]);
  const promoted = seq.run.nodes['qc:s2'].value.promoted;
  assert.equal(promoted, ledger[1].takeId, 'the best-scoring take is promoted, not the last');
  assert.equal(seq.run.nodes['shoot:s2'].value.takeId, promoted);
  assert.equal(wire.calls.stitch[0].shots[1], ledger[1].url, 'assembly uses the promoted take');
  assert.equal(firstFrame(s3.at(-1)), ledger[1].lastFrameUrl, 'the continuous successor was re-shot from the promoted take’s last frame');
  assert.equal(seq.run.takes.s3.at(-1).firstFrameUrl, ledger[1].lastFrameUrl);
  assert.ok(seq.run.takes.s3.length >= 2, 'the successor’s earlier takes were invalidated');

  const regen = journal.entries('regeneration').filter((r) => r.shotId === 's2');
  assert.deepEqual(regen.map((r) => r.mode), ['same-keyframe', 'new-candidate', 'promote-best']);
  assert.ok(regen.slice(0, 2).every((r) => r.cause === 'E-QC-MORPHING' && r.invalidatedShots[0] === 's3'));
  const decision = journal.entries('completionDecision').find((d) => d.shotId === 's2');
  assert.equal(decision.decision, 'promote-best');
  assert.equal(decision.takes.length, 3);
  assert.ok(journal.entries('finding').some((f) => f.code === 'E-SHOT-ATTEMPTS-EXHAUSTED' && f.shotId === 's2' && f.takeId === promoted && f.runId === 'run-test'));
  assert.ok(journal.entries('keyframe').some((k) => k.shotId === 's3' && k.needed === false && /last frame/.test(k.reason)));
  const costs = journal.entries('cost');
  const takeRows = costs.filter((c) => c.unit === 'take');
  const keptTakes = takeRows.filter((c) => c.disposition === 'kept');
  const wastedTakes = takeRows.filter((c) => c.disposition === 'wasted');
  assert.ok(wastedTakes.some((c) => c.code === 'E-WASTE-INVALIDATED-SUCCESSOR'), 'invalidated successor takes are counted as waste');
  assert.deepEqual(wastedTakes.filter((c) => c.shotId === 's2').map((c) => [c.code, c.takeId]), [['E-WASTE-NOT-PROMOTED', ledger[0].takeId], ['E-WASTE-NOT-PROMOTED', ledger[2].takeId]], 'every take that lost to the promoted best is coded');
  assert.ok(!wastedTakes.some((c) => c.takeId === promoted), 'the promoted take is never waste');
  assert.ok(wastedTakes.every((c) => c.code && c.takeId && c.nodeId.startsWith('shoot:')), 'every wasted take row is coded and names its take');
  assert.equal(keptTakes.length, wire.calls.animate.length, 'every rendered take is a kept row');
  assert.equal(keptTakes.length - wastedTakes.length, 3, 'kept minus wasted is the one take per shot in the film');
  assert.deepEqual(costs.filter((c) => c.unit === 'still' && c.disposition === 'wasted').map((c) => [c.code, c.candidateId, c.nodeId]), [['E-WASTE-KEYFRAME-REJECTED', firstS2Winner, 'keyframe:s2']], 'the keyframe a new-candidate regeneration retires is coded');
  assert.equal(reservations.filter((r) => r.kind === 'take').length, wire.calls.animate.length, 'every take was reserved before the wire');
  assert.equal(journal.entries('intent').filter((i) => i.intent === 'render.start').length, wire.calls.animate.length, 'every render start was journaled as an intent');
  assert.equal(journal.entries('result').length, journal.entries('intent').length, 'every intent has its result');
  assert.equal(wire.calls.imagine.length, 1);
  assert.equal(seq.iterations[0].status, 'assembled');
  const candidateStills = calls.generate.reduce((n, g) => n + g.k, 0);
  assert.equal(seq.iterations[0].cost.renders, 1 + candidateStills + wire.calls.animate.length, 'renders count the plate, every keyframe candidate still and every take the same way');
});

test('a policy pass renders every plate on its planned model and size, QCs it, re-renders within policy.attempts.plate and promotes the best on exhaustion', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1 } });
  const journal = memJournal();
  const { calls, stages } = stubStages({ platePlan: { 'FIGURE-1': [{ pass: false, score: 0.2 }, { pass: false, score: 0.6 }, { pass: false, score: 0.4 }] } });
  const { pass, reservations } = passFor({ journal, stages, policy: { ...POLICY, attempts: { ...POLICY.attempts, plate: 3 } } });
  const state = await drivePass(seeded, wire, pass);
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));

  assert.equal(wire.calls.imagine.length, 3, 'the plate rendered three times within its attempt budget');
  assert.ok(wire.calls.imagine.every((b) => b.model === 'test-sr' && b.size === '2848x1600'), 'every plate render names the plan’s model and that model’s keyframe size');
  assert.equal(calls.plateQC.length, 3, 'every rendered plate was QC’d');
  assert.deepEqual(calls.plateQC.map((q) => q.attempt), [1, 2, 3]);
  assert.ok(calls.plateQC.every((q) => q.style && q.rubrics && q.policy));
  assert.equal(reservations.filter((r) => r.nodeId === 'plate:FIGURE-1').length, 3, 'every plate render was reserved before the wire');

  const value = seq.run.nodes['plate:FIGURE-1'].value;
  assert.equal(value.attempt, 2, 'the best-scoring plate is promoted, not the last');
  assert.equal(value.url, '/api/film/media?key=plate2.jpg');
  assert.equal(value.score, 0.6);
  assert.equal(state.bible.at(-1).plateUrl, value.url, 'the bible carries the promoted plate');
  assert.ok(calls.generate.every((g) => g.plates[0] === value.url), 'keyframes reference the promoted plate');

  assert.deepEqual(journal.entries('plate').map((p) => [p.attempt, p.pass, p.score]), [[1, false, 0.2], [2, false, 0.6], [3, false, 0.4]]);
  assert.deepEqual(journal.entries('regeneration').filter((r) => r.entity === 'FIGURE-1').map((r) => [r.attempt, r.mode, r.cause]), [[1, 'plate-rerender', 'E-RUBRIC-FAIL'], [2, 'plate-rerender', 'E-RUBRIC-FAIL']]);
  const decision = journal.entries('completionDecision').find((d) => d.entity === 'FIGURE-1');
  assert.deepEqual({ decision: decision.decision, cause: decision.cause, attempts: decision.attempts, budget: decision.budget }, { decision: 'promote-best', cause: 'exhausted-plate', attempts: 3, budget: 3 });
  assert.ok(journal.entries('finding').some((f) => f.code === 'E-PLATE-ATTEMPTS-EXHAUSTED' && f.stage === 'plate' && f.severity === 'blocker' && f.attempt === 3 && f.runId === 'run-test'));
  const stills = journal.entries('cost').filter((c) => c.unit === 'still' && c.nodeId === 'plate:FIGURE-1');
  assert.equal(stills.filter((c) => c.disposition === 'kept').length, 3);
  assert.deepEqual(stills.filter((c) => c.disposition === 'wasted').map((c) => [c.code, c.attempt]), [['E-WASTE-NOT-PROMOTED', 1], ['E-WASTE-NOT-PROMOTED', 3]]);
  assert.ok(journal.entries('media').some((m) => m.name === 'plate-FIGURE_1.jpg' && m.url === value.url));
  assert.equal(seq.iterations[0].artifacts.plates[0], value.url);
});

test('a plate that passes QC on a re-render codes the rejected render as waste and never renders again', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1 } });
  const journal = memJournal();
  const { calls, stages } = stubStages({ platePlan: { 'FIGURE-1': [{ pass: false, score: 0.3 }] } });
  const { pass } = passFor({ journal, stages });
  const state = await drivePass(seeded, wire, pass);
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));
  assert.equal(wire.calls.imagine.length, 2);
  assert.equal(calls.plateQC.length, 2);
  const value = seq.run.nodes['plate:FIGURE-1'].value;
  assert.deepEqual({ attempt: value.attempt, pass: value.pass, score: value.score }, { attempt: 2, pass: true, score: 0.9 });
  const stills = journal.entries('cost').filter((c) => c.unit === 'still' && c.nodeId === 'plate:FIGURE-1');
  assert.deepEqual(stills.filter((c) => c.disposition === 'wasted').map((c) => [c.code, c.attempt]), [['E-WASTE-QC-REGENERATED', 1]]);
  assert.equal(journal.entries('completionDecision').filter((d) => d.entity === 'FIGURE-1').length, 0);
  assert.ok(!journal.entries('finding').some((f) => f.code === 'E-PLATE-ATTEMPTS-EXHAUSTED'));
});

test('a take rejected by QC is coded as waste once a later take of its shot passes; the passing take is not', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1 } });
  const journal = memJournal();
  const { stages } = stubStages({ qcPlan: { s1: [{ pass: false, score: 0.2 }] } });
  const { pass } = passFor({ journal, stages });
  const state = await drivePass(seeded, wire, pass);
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));
  const ledger = seq.run.takes.s1;
  assert.deepEqual(ledger.map((t) => t.pass), [false, true]);
  const wasted = journal.entries('cost').filter((c) => c.disposition === 'wasted');
  assert.deepEqual(wasted.map((c) => [c.code, c.takeId, c.nodeId, c.attempt]), [['E-WASTE-QC-REGENERATED', ledger[0].takeId, 'shoot:s1', 1]]);
  assert.match(wasted[0].detail, /rejected by take QC \(score 0\.2\) and re-shot; attempt 2/);
  const kept = journal.entries('cost').filter((c) => c.unit === 'take' && c.disposition === 'kept');
  assert.equal(kept.length, wire.calls.animate.length);
  assert.equal(kept.length - wasted.length, 3, 'one take per shot survives');
  assert.ok(journal.entries('cost').some((c) => c.disposition === 'kept' && c.takeId === ledger[1].takeId) && !wasted.some((c) => c.takeId === ledger[1].takeId));
});

test('a policy pass never halts on a measure violation: a wrong frame rate becomes a finding and the pass still assembles; a short take regenerates without a retry pool', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1, '/api/film/media?key=task1.mp4': 5.0 }, fps: { '/api/film/media?key=task2.mp4': 25 } });
  const journal = memJournal();
  const { stages } = stubStages();
  const { pass } = passFor({ journal, stages });
  const state = await drivePass(seeded, wire, pass);
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));
  const findings = journal.entries('finding');
  assert.ok(findings.some((f) => f.code === 'E-MEASURE-CIN-007' && f.family === 'gate' && f.stage === 'measure'));
  assert.ok(findings.some((f) => f.code === 'E-MEASURE-CIN-004'));
  const regen = journal.entries('regeneration');
  assert.equal(regen.filter((r) => r.ruleId === 'CIN-007').length, 1, 'the short take regenerated once');
  assert.equal(regen.filter((r) => r.ruleId === 'CIN-004').length, 0, 'a model property is not regenerated');
  const fpsDecision = journal.entries('completionDecision').find((d) => d.ruleId === 'CIN-004');
  assert.ok(fpsDecision, 'a deterministic measure blocker journals its completion decision');
  assert.equal(fpsDecision.decision, 'accept-measured-blocker');
  assert.equal(fpsDecision.cause, 'deterministic-measure-blocker');
  const shipped = findings.filter((f) => f.code === 'E-SHOT-MEASURE-SHIPPED');
  assert.equal(shipped.length, 1);
  assert.ok(shipped[0].family === 'shortfall' && shipped[0].stage === 'measure' && shipped[0].ruleId === 'CIN-004' && shipped[0].shotId === fpsDecision.shotId);
  assert.equal(seq.run.takes[fpsDecision.shotId].at(-1).measure.fps, 25, 'the ledger carries the measurement');
  assert.deepEqual(seq.run.takes[fpsDecision.shotId].at(-1).measureBlockers, ['CIN-004']);
  assert.equal(seq.run.retryPoolLeft, 3, 'the approved-card retry pool is not the policy budget');
  assert.equal(seq.iterations[0].status, 'assembled');
});

test('a policy pass whose take is short on every attempt exhausts policy.attempts.shot at measure: the completion decision is journaled, the take closest to plan is promoted, and the shipped blocker is a named shortfall', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1 } });
  const shortByAttempt = [5.0, 5.0, 5.5, 5.0, 5.0];
  const origInstall = wire.install;
  wire.install = () => {
    origInstall();
    const cur = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/api/film/measure')) {
        const body = JSON.parse(init.body);
        const task = (body.url.match(/task(\d+)\.mp4/) || [])[1];
        const started = task ? wire.calls.animate[Number(task) - 1] : null;
        if (started && started.content[0].text.includes('The first moment holds.')) {
          const n = wire.calls.animate.filter((b) => b.content[0].text.includes('The first moment holds.')).indexOf(started);
          const duration = shortByAttempt[n];
          if (duration === undefined) throw new Error(`shot 1 rendered a sixth take (task${task})`);
          wire.calls.measure.push(body);
          return new Response(JSON.stringify({ duration, nbReadFrames: Math.round(duration * 24), fps: 24, width: 1280, height: 720, hasAudio: true, firstHash: '10'.repeat(32), lastHash: '10'.repeat(32) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }
      return cur(url, init);
    };
  };
  const journal = memJournal();
  const { stages } = stubStages();
  const { pass } = passFor({ journal, stages });
  const state = await drivePass(seeded, wire, pass);
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));
  const budget = POLICY.attempts.shot;
  assert.equal(budget, 5);
  const s1 = wire.calls.animate.filter((b) => b.content[0].text.includes('The first moment holds.'));
  assert.equal(s1.length, budget, 'shot 1 rendered once per attempt in its budget');

  const ledger = seq.run.takes.s1;
  assert.equal(ledger.length, budget);
  assert.deepEqual(ledger.map((t) => t.measure.measured), shortByAttempt, 'every take carries its measurement');
  assert.ok(ledger.every((t) => t.measureBlockers.length === 1 && t.measureBlockers[0] === 'CIN-007'));

  const findings = journal.entries('finding');
  assert.equal(findings.filter((f) => f.code === 'E-MEASURE-CIN-007' && f.shotId === 's1').length, budget);
  const regen = journal.entries('regeneration').filter((r) => r.shotId === 's1');
  assert.deepEqual(regen.map((r) => r.mode), ['same-keyframe', 'new-candidate', 'new-candidate', 'new-candidate', 'promote-best'], 'a measure blocker regenerates in policy.shots.regenerateOrder, the same as take QC');
  assert.ok(regen.slice(0, budget - 1).every((r) => r.ruleId === 'CIN-007'));
  assert.equal(journal.entries('cost').filter((c) => c.code === 'E-WASTE-KEYFRAME-REJECTED' && c.shotId === 's1').length, budget - 2, 'each new-candidate regeneration retires the keyframe it replaces');

  const decision = journal.entries('completionDecision').find((d) => d.shotId === 's1');
  assert.ok(decision, 'exhaustion at measure journals the completion decision');
  assert.equal(decision.decision, 'promote-best');
  assert.equal(decision.cause, 'exhausted-shot');
  assert.equal(decision.ruleId, 'CIN-007');
  assert.equal(decision.attempts, budget);
  assert.equal(decision.budget, budget);
  assert.deepEqual(decision.takes.map((t) => t.measured), shortByAttempt);

  const promoted = ledger[2].takeId;
  assert.equal(seq.run.nodes['shoot:s1'].value.takeId, promoted, 'the take closest to its planned seconds is promoted, not the last');
  assert.equal(seq.run.nodes['measure:s1'].value.measured, 5.5, 'the measure value describes the promoted take');
  assert.equal(wire.calls.stitch[0].shots[0], ledger[2].url, 'assembly uses the promoted take');
  const shipped = findings.filter((f) => f.code === 'E-SHOT-MEASURE-SHIPPED');
  assert.equal(shipped.length, 1);
  assert.ok(shipped[0].family === 'shortfall' && shipped[0].stage === 'measure' && shipped[0].severity === 'blocker');
  assert.ok(shipped[0].shotId === 's1' && shipped[0].ruleId === 'CIN-007' && shipped[0].takeId === promoted && shipped[0].attempt === budget && shipped[0].runId === 'run-test');
  assert.equal(shipped[0].evidence.length, budget, 'the finding carries every measured attempt');
  assert.equal(journal.entries('completionDecision').filter((d) => d.shotId === 's1').length, 1, 'qc passes the promoted take and files no second decision');
  assert.equal(seq.iterations[0].status, 'assembled');
});

test('a pass is refused by name when it lacks a field, and the approved-card flow has no stages to call', async () => {
  const seeded = seedPassProject();
  const wire = makeWire();
  const journal = memJournal();
  const { stages } = stubStages();
  const { pass } = passFor({ journal, stages });
  const { reserve, ...noReserve } = pass;
  void reserve;
  await assert.rejects(() => drivePass(seeded, wire, noReserve), /missing "reserve"/);
  const { takeQC, ...noQC } = stages;
  void takeQC;
  await assert.rejects(() => drivePass(seeded, wire, { ...pass, stages: noQC }), /stages have no "takeQC"/);
  const { plateQC, ...noPlateQC } = stages;
  void plateQC;
  await assert.rejects(() => drivePass(seeded, wire, { ...pass, stages: noPlateQC }), /stages have no "plateQC"/);
  assert.equal(wire.calls.animate.length, 0);
  assert.equal(wire.calls.imagine.length, 0);
});

test('a start refused on the output-audio policy is retaken without audio as a journaled downgrade: a shortfall finding and a silent-retake regeneration name the shot, the attempt, the refused intent and the reservation the retake spends', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1 } });
  const journal = memJournal();
  const { stages } = stubStages();
  const { pass, reservations } = passFor({ journal, stages });
  const c = client();
  const origStart = c.startVideo.bind(c);
  const refused = [];
  c.startVideo = async (args) => {
    if (args.generateAudio && args.content[0].text.includes('The first moment holds.') && !refused.length) {
      refused.push(args);
      throw new Error('Seedance refused: output audio may contain sensitive information');
    }
    return origStart(args);
  };
  wire.install();
  let state = seeded.p;
  try {
    await runSequence({ client: c, threadId: seeded.threadId, messageId: seeded.messageId, get: () => state, apply: (fn) => { state = fn(state) || state; }, pass });
  } finally {
    wire.restore();
  }
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));
  assert.equal(refused.length, 1);
  const s1 = wire.calls.animate.filter((b) => b.content[0].text.includes('The first moment holds.'));
  assert.equal(s1.length, 1, 'the refused start never reached the wire; the silent retake did');
  assert.equal(s1[0].generateAudio, false);
  assert.deepEqual(seq.run.silentShots, ['s1']);
  assert.equal(seq.run.takes.s1.length, 1);
  assert.equal(seq.run.takes.s1[0].silent, true);
  assert.equal(seq.run.nodes['shoot:s1'].value.silent, true);

  const starts = journal.entries('intent').filter((i) => i.intent === 'render.start' && i.shotId === 's1');
  assert.deepEqual(starts.map((i) => i.audio), [true, false], 'both starts are intents');
  const refusedResult = journal.entries('result').find((r) => r.intentId === starts[0].intentId);
  assert.match(refusedResult.error, /output audio may contain sensitive/);
  assert.equal(journal.entries('result').length, journal.entries('intent').length, 'every intent has its result');

  const downgrade = journal.entries('finding').filter((f) => f.code === 'E-AUDIO-POLICY-SILENT');
  assert.equal(downgrade.length, 1);
  const f = downgrade[0];
  assert.ok(f.family === 'shortfall' && f.stage === 'shoot' && f.severity === 'note' && f.disposition === 'downgrade' && f.runId === 'run-test');
  assert.ok(f.shotId === 's1' && f.attempt === 1);
  assert.match(f.detail, /output audio may contain sensitive.*without audio/);
  const reservationId = seq.run.nodes['shoot:s1'].value.reservationId;
  assert.deepEqual(f.evidence, [{ intentId: starts[0].intentId, audio: true, reservationId }]);

  const regen = journal.entries('regeneration').filter((r) => r.shotId === 's1');
  assert.deepEqual(regen.map((r) => r.mode), ['silent-retake']);
  assert.ok(regen[0].attempt === 1 && regen[0].ruleId === null && regen[0].intentId === starts[0].intentId && regen[0].reservationId === reservationId);
  assert.match(regen[0].cause, /output audio may contain sensitive/);
  assert.match(regen[0].justification, /produced no task.*spends reservation res_\d+/);
  assert.deepEqual(regen[0].invalidatedShots, []);
  const rows = journal.rows;
  assert.ok(rows.indexOf(f) < rows.indexOf(regen[0]) && rows.indexOf(regen[0]) < rows.indexOf(starts[1]), 'the downgrade is journaled before the retake is started');

  assert.equal(reservations.filter((r) => r.kind === 'take' && r.nodeId === 'shoot:s1').length, 1, 'the refused start spent nothing; the retake spends the one reservation');
  const s1Costs = journal.entries('cost').filter((c) => c.unit === 'take' && c.nodeId === 'shoot:s1');
  assert.deepEqual(s1Costs.map((c) => c.disposition), ['refused', 'kept'], 'the refused start is a coded cost row; the silent retake is the kept one');
  const refusedCost = s1Costs[0];
  assert.ok(refusedCost.code === 'E-AUDIO-POLICY' && refusedCost.shotId === 's1' && refusedCost.attempt === 1 && refusedCost.units === 6);
  assert.ok(refusedCost.intentId === starts[0].intentId && refusedCost.reservationId === reservationId);
  assert.match(refusedCost.detail, /output audio may contain sensitive.*produced no task.*spends reservation res_\d+/);
  assert.ok(rows.indexOf(f) < rows.indexOf(refusedCost) && rows.indexOf(refusedCost) < rows.indexOf(starts[1]), 'the refused cost is journaled before the retake is started');
  assert.equal(s1Costs[1].reservationId, reservationId);
  assert.equal(seq.iterations[0].status, 'assembled');
});

const ceilingReserve = ({ journal, refuseTake }) => {
  const reservations = [];
  const refusals = [];
  const reserve = async (r) => {
    if (!r.nodeId) throw new Error('E-RESERVE-NO-NODE');
    await Promise.resolve();
    const prior = reservations.filter((x) => x.kind === 'take');
    const takes = prior.length;
    if (r.kind === 'take' && refuseTake(r, prior)) {
      const code = 'E-BUDGET-MAXRENDERS';
      journal.write('reservation.refused', { code, request: r, detail: `budget.maxRenders would be crossed by ${r.nodeId}`, before: { takes }, after: { takes: takes + 1 } });
      const err = new Error(`${code}: budget.maxRenders would be crossed by ${r.nodeId}`);
      err.code = code;
      refusals.push({ code, request: r });
      throw err;
    }
    const record = { id: `res_${reservations.length + 1}`, ...r };
    reservations.push(record);
    journal.write('reservation', record);
    return record;
  };
  return { reserve, reservations, refusals };
};

test('an async reserve that refuses a take with a ceiling code never reaches the wire: the shot is held as a still for its planned seconds, the decision, the finding and the refused cost are journaled, and the pass still assembles', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1 } });
  const journal = memJournal();
  const { stages } = stubStages();
  const { reserve, refusals } = ceilingReserve({ journal, refuseTake: (r, prior) => prior.length >= 1 });
  const { pass } = passFor({ journal, stages });
  const state = await drivePass(seeded, wire, { ...pass, reserve });
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));
  assert.equal(POLICY.completion.onRenderCeiling, 'still-hold');

  assert.equal(wire.calls.animate.length, 1, 'one take was paid before the ceiling');
  assert.deepEqual(refusals.map((r) => r.request.nodeId).sort(), ['shoot:s1', 'shoot:s3']);
  const rows = journal.rows;
  const firstRefusal = rows.findIndex((r) => r.kind === 'reservation.refused');
  assert.ok(firstRefusal > 0);
  const startsAfter = rows.slice(firstRefusal).filter((r) => r.kind === 'intent' && r.intent === 'render.start');
  assert.equal(startsAfter.length, 0, 'no render.start intent follows a refused reservation');
  assert.equal(journal.entries('fault').length, 0, 'a ceiling refusal is a completion, not a fault');
  assert.equal(journal.entries('result').length, journal.entries('intent').length, 'every intent has its result');

  const decisions = journal.entries('completionDecision');
  assert.deepEqual(decisions.map((d) => d.shotId).sort(), ['s1', 's3']);
  assert.ok(decisions.every((d) => d.decision === 'still-hold' && d.cause === 'render-ceiling' && d.refused === 'E-BUDGET-MAXRENDERS'));
  const budget = journal.entries('finding').filter((f) => f.family === 'budget');
  assert.deepEqual(budget.map((f) => f.shotId).sort(), ['s1', 's3']);
  assert.ok(budget.every((f) => f.code === 'E-BUDGET-MAXRENDERS' && f.stage === 'shoot' && f.severity === 'blocker' && f.runId === 'run-test'));
  const refusedCosts = journal.entries('cost').filter((c) => c.disposition === 'refused');
  assert.deepEqual(refusedCosts.map((c) => c.nodeId).sort(), ['shoot:s1', 'shoot:s3']);
  assert.ok(refusedCosts.every((c) => c.unit === 'take' && c.code === 'E-BUDGET-MAXRENDERS'));

  const s1 = seq.run.nodes['shoot:s1'].value;
  const s2 = seq.run.nodes['shoot:s2'].value;
  const s3 = seq.run.nodes['shoot:s3'].value;
  assert.equal(s1.taskId, null);
  assert.deepEqual(s1.held, { seconds: 6 });
  assert.equal(s1.url, seq.run.nodes['keyframe:s1'].value.url, 'a cut shot holds its promoted keyframe');
  assert.equal(s3.url, s2.lastFrameUrl, 'a continuous shot holds the last frame it would have continued from');
  assert.deepEqual(s1.ceiling, { refused: 'E-BUDGET-MAXRENDERS', decision: 'still-hold' });
  assert.equal(seq.run.takes.s1, undefined, 'a held still is not a take');
  assert.equal(seq.run.nodes['measure:s1'].value.measured, 6);
  assert.deepEqual(seq.run.nodes['measure:s1'].value.held, { seconds: 6 });
  assert.equal(seq.run.nodes['qc:s1'].value.promoted, null);
  assert.ok(journal.entries('measure').some((m) => m.shotId === 's1' && m.held && m.refused === 'E-BUDGET-MAXRENDERS'));
  assert.ok(journal.entries('qc').some((q) => q.shotId === 's3' && q.held && q.takeId === null));
  assert.deepEqual(wire.calls.stitch[0].shots, [{ url: s1.url, seconds: 6 }, s2.url, { url: s3.url, seconds: 6 }], 'assembly carries held stills with their seconds');
  assert.equal(seq.iterations[0].status, 'assembled');
});

test('under promote-best on the render ceiling, a regenerating shot whose next take is refused ships its best recorded take and its QC is not re-run', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1 } });
  const journal = memJournal();
  const { calls, stages } = stubStages({ qcPlan: { s2: [{ pass: false, score: 0.3 }] } });
  const { reserve, refusals } = ceilingReserve({ journal, refuseTake: (r, prior) => r.nodeId === 'shoot:s2' && prior.some((x) => x.nodeId === 'shoot:s2') });
  const policy = { ...POLICY, completion: { ...POLICY.completion, onRenderCeiling: 'promote-best' } };
  const { pass } = passFor({ journal, stages, policy });
  const state = await drivePass(seeded, wire, { ...pass, reserve });
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));

  assert.deepEqual(refusals.map((r) => r.request.nodeId), ['shoot:s2']);
  assert.equal(wire.calls.animate.filter((b) => b.content[0].text.includes('The second moment lands.')).length, 1, 'the refused regeneration never reached the wire');
  const ledger = seq.run.takes.s2;
  assert.equal(ledger.length, 1);
  const s2 = seq.run.nodes['shoot:s2'].value;
  assert.equal(s2.takeId, ledger[0].takeId, 'the only recorded take is promoted');
  assert.deepEqual(s2.ceiling, { refused: 'E-BUDGET-MAXRENDERS', decision: 'promote-best' });
  assert.equal(s2.held, undefined);
  assert.equal(calls.qc.filter((q) => q.shot === 's2').length, 1, 'take QC ran once; the promotion under the ceiling reuses its verdict');
  const decision = journal.entries('completionDecision').find((d) => d.shotId === 's2');
  assert.equal(decision.decision, 'promote-best');
  assert.equal(decision.cause, 'render-ceiling');
  assert.deepEqual(decision.takes.map((t) => t.score), [0.3]);
  assert.ok(journal.entries('finding').some((f) => f.family === 'budget' && f.shotId === 's2' && f.takeId === ledger[0].takeId));
  assert.ok(journal.entries('qc').some((q) => q.shotId === 's2' && q.refused === 'E-BUDGET-MAXRENDERS' && q.score === 0.3));
  const regen = journal.entries('regeneration').filter((r) => r.shotId === 's2');
  assert.equal(regen.length, 1, 'one regeneration was asked for before the ceiling answered');
  assert.equal(journal.entries('fault').length, 0);
});

test('a keyframe winner under the selection floor regenerates candidates within policy.attempts.candidate: the pool survives the reset, the next attempt selects over every candidate made, and a winner over the floor ships with no shortfall', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1 } });
  const journal = memJournal();
  const { calls, stages } = stubStages({ selectFloor: 0.07 });
  const { pass } = passFor({ journal, stages });
  const state = await drivePass(seeded, wire, pass);
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));

  for (const shotId of ['s1', 's2']) {
    assert.equal(calls.generate.filter((g) => g.shot === shotId).length, 2, `${shotId} generated candidates twice`);
    const selects = calls.select.filter((s) => s.shot === shotId);
    assert.equal(selects.length, 2);
    assert.equal(selects[1].candidates.length, 6, 'the second selection ranks the earlier candidates with the fresh ones');
    assert.ok(selects[0].candidates.every((id) => selects[1].candidates.includes(id)), 'the pool survives the regeneration');
    const selections = journal.entries('selection').filter((s) => s.shotId === shotId);
    assert.deepEqual(selections.map((s) => [s.attempt, s.shortfall?.code || null]), [[1, 'E-SELECT-FLOOR'], [2, null]]);
    const regen = journal.entries('regeneration').filter((r) => r.shotId === shotId);
    assert.deepEqual(regen.map((r) => [r.mode, r.cause]), [['new-candidate', 'E-SELECT-FLOOR']]);
    const value = seq.run.nodes[`keyframe:${shotId}`].value;
    assert.equal(value.shortfall, null);
    assert.ok(value.score >= 0.07, 'the promoted keyframe clears the floor');
    assert.equal(value.candidates.length, 6);
    assert.equal(seq.run.nodes[`keyframe:${shotId}`].attempts, 2);
  }
  assert.ok(!journal.entries('finding').some((f) => f.code === 'E-KEYFRAME-FLOOR'), 'a winner over the floor is no shortfall');
  assert.ok(!journal.entries('completionDecision').some((d) => d.cause === 'exhausted-candidate'));
  assert.equal(journal.entries('cost').filter((c) => c.unit === 'still' && c.disposition === 'wasted').length, 0, 'candidates that lost selection stay kept');
  assert.equal(wire.calls.animate.length, 3, 'no shot rendered from a keyframe under the floor');
});

test('a keyframe whose every candidate attempt stays under the floor exhausts policy.attempts.candidate: the completion decision is journaled, the best candidate is promoted with E-KEYFRAME-FLOOR naming it, and the shot shoots from it', async () => {
  const seeded = seedPassProject();
  const wire = makeWire({ durations: { '/api/film/media?key=slice.mp4': 18.1 } });
  const journal = memJournal();
  const { calls, stages } = stubStages({ selectFloor: 0.99 });
  const { pass } = passFor({ journal, stages, policy: { ...POLICY, attempts: { ...POLICY.attempts, candidate: 2 } } });
  const state = await drivePass(seeded, wire, pass);
  const seq = sequenceById(state, seeded.seqId);
  assert.equal(seq.status, 'assembled', JSON.stringify(seq.run.halted || null));

  const firstFrame = (b) => b.content.find((c) => c.role === 'first_frame')?.image_url?.url || null;
  for (const shotId of ['s1', 's2']) {
    assert.equal(calls.generate.filter((g) => g.shot === shotId).length, 2, `${shotId} spent exactly its candidate budget`);
    const value = seq.run.nodes[`keyframe:${shotId}`].value;
    assert.equal(value.shortfall.code, 'E-SELECT-FLOOR');
    assert.equal(value.candidates.length, 6);
    const best = Math.max(...seq.run.nodes[`keyframe:${shotId}`].pool.map((c) => c.score));
    assert.equal(value.score, best, 'the best candidate across every attempt is promoted');
    const decision = journal.entries('completionDecision').find((d) => d.shotId === shotId && d.cause === 'exhausted-candidate');
    assert.ok(decision, 'the promotion under the floor is a journaled decision');
    assert.equal(decision.decision, 'promote-best');
    assert.deepEqual([decision.attempts, decision.budget, decision.winner], [2, 2, value.candidateId]);
    assert.equal(decision.candidates.length, 6);
    const shortfalls = journal.entries('finding').filter((f) => f.code === 'E-KEYFRAME-FLOOR' && f.shotId === shotId);
    assert.equal(shortfalls.length, 1);
    assert.ok(shortfalls[0].candidateId === value.candidateId && shortfalls[0].attempt === 2 && shortfalls[0].runId === 'run-test');
    assert.match(shortfalls[0].detail, /exhausted 2 of 2 candidate attempts under E-SELECT-FLOOR/);
    assert.deepEqual(journal.entries('regeneration').filter((r) => r.shotId === shotId).map((r) => r.mode), ['new-candidate']);
    const prompt = shotId === 's1' ? 'The first moment holds.' : 'The second moment lands.';
    const shoots = wire.calls.animate.filter((b) => b.content[0].text.includes(prompt));
    assert.equal(shoots.length, 1);
    assert.equal(firstFrame(shoots[0]), value.url, 'the shot shoots from the promoted keyframe');
  }
  assert.equal(journal.entries('cost').filter((c) => c.unit === 'still' && c.disposition === 'wasted').length, 0);
});
