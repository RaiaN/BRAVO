import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendMessage, latchThread, makeProject, makeSequence, sequenceById, touch } from '../../state/project.js';
import { runSequence, manifestOf, fnv1a } from '../../agents/director/execute.js';
import { applyDeployModels } from '../../utils/film/suiteConfig.js';
import fs from 'node:fs';

applyDeployModels({ seedance25: 'test-sd25', seedance: 'test-sd', seedream: 'test-sr', seedreamPro: 'test-srp', reasoner: 'test-r' });

const RULES = {
  cinematic: JSON.parse(fs.readFileSync('rules/cinematic.json', 'utf8')),
  screenwriting: JSON.parse(fs.readFileSync('rules/screenwriting.json', 'utf8')),
  metrics: JSON.parse(fs.readFileSync('rules/metrics.json', 'utf8')),
};

const plan = () => ({
  slot: 'seedance25',
  shots: [
    { id: 's1', sceneId: 'sc1', beatId: 'b1', setup: 'Wide Establisher', side: 'L', seconds: 6, location: 'PLACE-1', prompt: 'The first moment holds.', flags: [] },
    { id: 's2', sceneId: 'sc1', beatId: 'b2', setup: 'Close-Up', side: 'L', seconds: 6, location: 'PLACE-1', prompt: 'The second moment lands.', flags: [] },
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
    tool: { name: 'sequence', input: {}, card: { tool: 'sequence', manifest: manifestOf(seq), manifestHash: fnv1a(JSON.stringify(manifestOf(seq))) }, output: null, approved: true, cost: 0 },
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
