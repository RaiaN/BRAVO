import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExtend, shotWindow } from '../../agents/extend.js';
import { loadFilmRules } from '../../agents/film-qc.js';
import { applyDeployModels } from '../../utils/film/suiteConfig.js';

applyDeployModels({ seedance25: 'test-sd25', seedance: 'test-sd', seedream: 'test-sr', seedreamPro: 'test-srp', reasoner: 'test-r' });
const rules = () => loadFilmRules('rules/film.json');
const style = () => ({ look: { style: 's', grade: 'g' }, constraints: [], doctrine: [], audio: false, format: { resolution: '720p', ratio: '16:9' } });
const policy = () => ({ attempts: { shot: 3, fault: 2 }, resume: { backoffMs: 1 }, shots: { min: 20, max: 30, secondsMin: 20, secondsMax: 30 } });

const journalStub = () => {
  const entries = []; let n = 0;
  return {
    entries,
    write: async (kind, data) => { n += 1; entries.push({ step: n, kind, data }); return { step: n }; },
    intent: async (kind, data) => { n += 1; entries.push({ step: n, kind: 'intent', data: { intentId: `int_${n}`, call: kind, ...data } }); return `int_${n}`; },
    result: async (intentId, data) => { n += 1; entries.push({ step: n, kind: 'result', data: { intentId, ...data } }); return { step: n }; },
    cost: async (row) => { n += 1; entries.push({ step: n, kind: 'cost', data: row }); return { step: n }; },
    finding: async (row) => { n += 1; entries.push({ step: n, kind: 'finding', data: row }); return { step: n }; },
    media: async (name) => { n += 1; entries.push({ step: n, kind: 'media', data: { name } }); return name; },
  };
};

const lawfulPlan = () => ({ logline: 'A keeps a secret.', shots: [1, 2, 3, 4].map((i) => ({ id: `s${i}`, subject: 'A', force: 'the doubt', change: 'a -> b', setup: 'Medium Shot', seconds: 30, prompt: `Shot ${i}.` })) });

const harness = ({ qcFails = {}, judgments = [], constraintOnExtend = false }) => {
  const calls = { animate: [], preserve: 0, stitch: 0 };
  let taskN = 0; let assetN = 0;
  const qcSeen = {};
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes('/api/film/preserve')) { calls.preserve += 1; assetN += 1; return new Response(JSON.stringify({ url: body.url, assetId: `vid-${assetN}` }), { status: 200 }); }
    if (u.includes('/api/film/stitch')) { calls.stitch += 1; return new Response(JSON.stringify({ url: '/m/slice.mp4' }), { status: 200 }); }
    if (u.includes('/api/film/measure')) return new Response(JSON.stringify({ duration: body.url.includes('slice') ? 120.1 : 30.04, fps: 24 }), { status: 200 });
    if (u.includes('/api/film/frames')) return new Response(JSON.stringify({ frames: body.timestamps.map((t, i) => ({ t, url: `/f/${i}.jpg` })) }), { status: 200 });
    if (u.includes('/api/film/image-stats')) { const i = Number((/\/f\/(\d+)/.exec(body.url) || [])[1] || 0); return new Response(JSON.stringify({ width: 512, height: 288, meanLuma: 90, blur: 1, dhash: `h${i}` }), { status: 200 }); }
    throw new Error(`unexpected fetch ${u}`);
  };
  const client = {
    reason: async (args) => {
      if (args.nodeId === 'plan') return { content: JSON.stringify(lawfulPlan()) };
      if (args.systemPrompt.includes('QC judge for one rendered take')) {
        const shotId = (/shot:(s\d+)/.exec(args.nodeId) || [])[1];
        qcSeen[shotId] = (qcSeen[shotId] || 0) + 1;
        const ok = qcSeen[shotId] > (qcFails[shotId] || 0);
        const a = (yes) => ({ yes, frame: 1, note: yes ? 'seen' : 'not seen' });
        return { content: JSON.stringify({ clean: a(ok), change: a(true), force: a(true), hold: a(true) }) };
      }
      if (args.systemPrompt.includes('director judging')) return { content: JSON.stringify(judgments.shift() || { decision: 'keep', instruction: '', reason: 'fine' }) };
      return { content: JSON.stringify({ prompt: 'rewritten' }) };
    },
    startVideo: async (args) => {
      calls.animate.push(args);
      if (constraintOnExtend && args.content.some((c) => c.type === 'video_url') && args.duration !== undefined) throw new Error('InvalidParameter.TaskTypeConstraint: duration is locked to the source clip');
      taskN += 1; return { taskId: `task${taskN}` };
    },
    pollVideo: async ({ taskId }) => ({ videoUrl: `/m/${taskId}.mp4`, videoCacheUrl: `/api/film/media?key=${taskId}.mp4`, lastFrameUrl: null }),
  };
  const reserve = async (r) => { if (!r.nodeId) throw new Error('E-RESERVE-NO-NODE'); return { id: `res_${r.nodeId}_${r.kind}` }; };
  return { calls, client, reserve, restore: () => { globalThis.fetch = real; } };
};
const run = (h, extra = {}) => runExtend({ idea: 'a story', style: style(), seconds: 120, policy: policy(), rules: rules(), client: h.client, journal: extra.journal || journalStub(), reserve: h.reserve, runId: 'run_t', slot: 'seedance25', onPlan: async () => {}, ...extra });

test('the window derives the shot count from the target: 120 seconds is four to six shots of 20-30 seconds', () => {
  assert.deepEqual(shotWindow({ seconds: 120, secondsMin: 20, secondsMax: 30 }), { kMin: 4, kMax: 6, dMin: 20, dMax: 30 });
  assert.throws(() => shotWindow({ seconds: 10, secondsMin: 20, secondsMax: 30 }), /E-EXTEND-SECONDS/);
});

test('shot one renders from the prompt; every later shot extends from the previous take\'s video asset', async () => {
  const h = harness({});
  const journal = journalStub();
  try {
    const out = await run(h, { journal });
    assert.equal(out.shots.length, 4);
    assert.ok(!h.calls.animate[0].content.some((c) => c.type === 'video_url'), 'shot one has no source video');
    for (let i = 1; i < 4; i += 1) {
      const src = h.calls.animate[i].content.find((c) => c.type === 'video_url');
      assert.equal(src.video_url.url, `asset://${out.shots[i - 1].assetId}`, `shot ${i + 1} extends shot ${i}`);
    }
    assert.equal(h.calls.stitch, 1);
    assert.equal(out.slice.totalMeasured, 120.1);
    const kinds = new Set(journal.entries.map((e) => e.kind));
    for (const k of ['window', 'plan', 'node', 'intent', 'result', 'render.done', 'qc.take', 'final', 'cost', 'media']) assert.ok(kinds.has(k), `journal has ${k}`);
  } finally { h.restore(); }
});

test('a provider duration constraint on an extension is journaled and the request is re-sent locked to the source', async () => {
  const h = harness({ constraintOnExtend: true });
  const journal = journalStub();
  try {
    const out = await run(h, { journal });
    assert.equal(out.shots.length, 4);
    const faults = journal.entries.filter((e) => e.kind === 'fault' && e.data.kind === 'constraint');
    assert.equal(faults.length, 3, 'one constraint fault per extension');
    const relaxed = h.calls.animate.filter((a) => a.content.some((c) => c.type === 'video_url') && a.duration === undefined);
    assert.equal(relaxed.length, 3);
  } finally { h.restore(); }
});

test('a failing take is judged and edited from its own asset; the next shot extends from what shipped', async () => {
  const h = harness({ qcFails: { s2: 1 }, judgments: [{ decision: 'edit', instruction: 'Fix the hands.', reason: 'one artifact' }] });
  const journal = journalStub();
  try {
    const out = await run(h, { journal });
    const s2 = out.shots.find((s) => s.shotId === 's2');
    assert.equal(s2.attempts, 2); assert.equal(s2.shipped, 'passed');
    const edit = h.calls.animate.find((a) => a.content.some((c) => c.type === 'video_url' && c.video_url.url === `asset://${out.shots[0].assetId}`) === false && a.content.some((c) => c.type === 'video_url'));
    assert.ok(edit, 'an edit was issued from a take asset');
    const s3 = h.calls.animate.filter((a) => a.content.some((c) => c.type === 'video_url')).at(-2);
    assert.equal(s3.content.find((c) => c.type === 'video_url').video_url.url, `asset://${s2.assetId}`, 'shot 3 extends the edited take');
    assert.ok(journal.entries.some((e) => e.kind === 'regeneration' && e.data.mode === 'edit'));
  } finally { h.restore(); }
});

test('a shot failing every attempt ships its best take and the chain continues from it', async () => {
  const h = harness({ qcFails: { s1: 9 }, judgments: [{ decision: 'regenerate', instruction: 'New.', reason: 'wrong' }, { decision: 'edit', instruction: 'Fix.', reason: 'close' }] });
  const journal = journalStub();
  try {
    const out = await run(h, { journal });
    assert.equal(out.shots[0].shipped, 'promote-best'); assert.equal(out.shots[0].attempts, 3);
    assert.ok(journal.entries.some((e) => e.kind === 'finding' && e.data.code === 'E-SHOT-EXHAUSTED'));
    assert.equal(out.shots[1].shipped, 'passed');
    const s2 = h.calls.animate.filter((a) => a.content.some((c) => c.type === 'video_url')).find((a) => a.content.find((c) => c.type === 'video_url').video_url.url === `asset://${out.shots[0].assetId}`);
    assert.ok(s2, 'shot 2 extends from the best take of shot 1');
  } finally { h.restore(); }
});
