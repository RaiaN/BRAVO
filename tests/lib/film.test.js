import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runFilm } from '../../agents/film.js';
import { loadFilmRules } from '../../agents/film-qc.js';
import { applyDeployModels } from '../../utils/film/suiteConfig.js';

applyDeployModels({ seedance25: 'test-sd25', seedance: 'test-sd', seedream: 'test-sr', seedreamPro: 'test-srp', reasoner: 'test-r' });
const rules = () => loadFilmRules('rules/film.json');
const window = () => ({ kMin: 20, kMax: 30, dMin: 20, dMax: 30 });

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

const style = () => ({ look: { style: 's', grade: 'g' }, constraints: [], doctrine: [], audio: false, format: { resolution: '720p', ratio: '16:9' } });
const policy = () => ({ attempts: { shot: 3, fault: 2, plate: 2 }, concurrency: { chains: 4 }, resume: { backoffMs: 1 }, shots: { min: 20, max: 30, secondsMin: 20, secondsMax: 30 } });

const lawfulPlan = (seconds) => {
  const w = window();
  const k = w.kMin;
  const each = Math.floor(seconds / k);
  const shots = Array.from({ length: k }, (_, i) => ({ id: `s${i + 1}`, subject: 'A', force: 'the lock holds', change: 'closed -> open', setup: 'Close-Up', seconds: each + (i === 0 ? seconds - each * k : 0), prompt: `Shot ${i + 1}.` }));
  return { logline: 'A opens a lock.', references: [{ name: 'A', role: 'character', prompt: 'sheet of A' }, { name: 'ROOM', role: 'location', prompt: 'wide of ROOM' }], shots };
};

const harness = ({ seconds, qcFails = {}, judgments = [] }) => {
  const calls = { animate: [], images: 0, preserve: 0, stitch: 0, reason: [] };
  let taskN = 0; let assetN = 0;
  const qcSeen = {};
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes('/api/film/preserve')) { calls.preserve += 1; assetN += 1; return new Response(JSON.stringify({ url: body.url, assetId: `vid-asset-${assetN}` }), { status: 200 }); }
    if (u.includes('/api/film/stitch')) { calls.stitch += 1; return new Response(JSON.stringify({ url: '/m/slice.mp4' }), { status: 200 }); }
    if (u.includes('/api/film/measure')) return new Response(JSON.stringify({ duration: 25.04, fps: 24 }), { status: 200 });
    if (u.includes('/api/film/frames')) return new Response(JSON.stringify({ frames: body.timestamps.map((t, i) => ({ t, url: `/f/${i}.jpg` })) }), { status: 200 });
    if (u.includes('/api/film/image-stats')) { const i = Number((/\/f\/(\d+)/.exec(body.url) || [])[1] || 0); return new Response(JSON.stringify({ width: 512, height: 288, meanLuma: 90, blur: 1, dhash: `h${i}` }), { status: 200 }); }
    throw new Error(`unexpected fetch ${u}`);
  };
  const client = {
    reason: async (args) => {
      calls.reason.push(args);
      if (args.nodeId === 'plan') return { content: JSON.stringify(lawfulPlan(seconds)) };
      if (args.nodeId === 'judge') return { content: JSON.stringify({ decisions: judgments.shift() || [] }) };
      if (args.nodeId?.startsWith('reference:')) return { content: JSON.stringify({ matches: { yes: true, note: 'ok' }, clean: { yes: true, note: 'ok' } }) };
      if (args.systemPrompt.includes('QC judge for one rendered take')) {
        const shotId = (/\"subject\"/.test(args.prompt) && /shot:(s\d+)/.exec(args.nodeId) || [])[1];
        qcSeen[shotId] = (qcSeen[shotId] || 0) + 1;
        const fails = qcFails[shotId] || 0;
        const ok = qcSeen[shotId] > fails;
        const a = (yes) => ({ yes, frame: 2, note: yes ? 'seen' : 'not seen' });
        return { content: JSON.stringify({ clean: a(ok), change: a(true), force: a(true), hold: a(true) }) };
      }
      return { content: JSON.stringify({ prompt: 'rewritten' }) };
    },
    generateImage: async () => { calls.images += 1; return { url: `/img/${calls.images}.jpg`, cacheUrl: `/api/film/media?key=r${calls.images}.jpg` }; },
    startVideo: async (args) => { taskN += 1; calls.animate.push(args); return { taskId: `task${taskN}` }; },
    pollVideo: async ({ taskId }) => ({ videoUrl: `/m/${taskId}.mp4`, videoCacheUrl: `/api/film/media?key=${taskId}.mp4`, lastFrameUrl: null }),
  };
  const reserve = async (r) => { if (!r.nodeId) throw new Error('E-RESERVE-NO-NODE'); return { id: `res_${r.nodeId}_${r.kind}` }; };
  return { calls, client, reserve, restore: () => { globalThis.fetch = real; } };
};

const run = (h, seconds, extra = {}) => runFilm({ idea: 'an idea', style: style(), seconds, policy: policy(), rules: rules(), client: h.client, journal: extra.journal || journalStub(), reserve: h.reserve, runId: 'run_t', refs: [], slot: 'seedance25', onPlan: async () => {}, ...extra });

test('idea to slice: one plan call, references as assets, every shot rendered with asset references, stitched and measured', async () => {
  const seconds = window().kMin * 25;
  const h = harness({ seconds });
  const journal = journalStub();
  try {
    const out = await run(h, seconds, { journal });
    assert.equal(out.shots.length, window().kMin);
    assert.equal(h.calls.images, 2, 'one still per reference');
    assert.equal(out.references.length, 2);
    for (const a of h.calls.animate) assert.ok(a.content.some((c) => c.type === 'image_asset_id'), 'references ride as asset ids');
    assert.equal(h.calls.preserve, window().kMin + 2, 'every take and every reference is registered as an asset');
    assert.equal(h.calls.stitch, 1);
    const kinds = new Set(journal.entries.map((e) => e.kind));
    for (const k of ['plan', 'reference', 'qc.reference', 'references', 'round', 'intent', 'result', 'render.done', 'qc.take', 'node', 'final', 'cost', 'media']) assert.ok(kinds.has(k), `journal has ${k}`);
  } finally { h.restore(); }
});

test('a failing take is judged in the next round and edited from its video asset with the instruction; the edit sends no duration or ratio', async () => {
  const seconds = window().kMin * 25;
  const h = harness({ seconds, qcFails: { s1: 1 }, judgments: [[{ id: 's1', decision: 'edit', instruction: 'Remove the extra hand.', reason: 'one artifact' }]] });
  const journal = journalStub();
  try {
    const out = await run(h, seconds, { journal });
    const s1 = out.shots.find((s) => s.shotId === 's1');
    assert.equal(s1.attempts, 2);
    assert.equal(s1.shipped, 'passed');
    const edit = h.calls.animate.find((a) => a.content.some((c) => c.type === 'video_url'));
    assert.ok(edit, 'an edit was sent');
    assert.match(edit.content.find((c) => c.type === 'video_url').video_url.url, /^asset:\/\/vid-asset-/, 'the input video is an asset id');
    assert.equal(edit.duration, undefined); assert.equal(edit.ratio, undefined);
    const reg = journal.entries.find((e) => e.kind === 'regeneration');
    assert.equal(reg.data.mode, 'edit'); assert.match(reg.data.instruction, /extra hand/);
    assert.ok(journal.entries.some((e) => e.kind === 'judgment'));
  } finally { h.restore(); }
});

test('a shot failing every round ships its best take with a named shortfall; the film still assembles', async () => {
  const seconds = window().kMin * 25;
  const h = harness({ seconds, qcFails: { s2: 9 }, judgments: [[{ id: 's2', decision: 'regenerate', instruction: 'New prompt.', reason: 'wrong' }], [{ id: 's2', decision: 'edit', instruction: 'Fix.', reason: 'close' }]] });
  const journal = journalStub();
  try {
    const out = await run(h, seconds, { journal });
    const s2 = out.shots.find((s) => s.shotId === 's2');
    assert.equal(s2.attempts, 3); assert.equal(s2.shipped, 'promote-best');
    assert.ok(journal.entries.some((e) => e.kind === 'finding' && e.data.code === 'E-SHOT-EXHAUSTED' && e.data.shotId === 's2'));
    const qc = journal.entries.find((e) => e.kind === 'qc.take' && e.data.shotId === 's2');
    assert.equal(qc.data.findings[0].rule, 'FILM-002');
    assert.equal(h.calls.stitch, 1);
  } finally { h.restore(); }
});

test('an unlawful plan is rejected with its problems and re-asked; the loop refuses without a journal or reserve', async () => {
  const seconds = window().kMin * 25;
  const h = harness({ seconds });
  let first = true;
  const base = h.client.reason;
  h.client.reason = async (args) => { if (args.nodeId === 'plan' && first) { first = false; return { content: JSON.stringify({ logline: 'x', references: [], shots: [{ id: 's1', subject: 'A', force: 'f', change: 'c', setup: 'Wide', seconds: 5, prompt: 'p' }] }) }; } return base(args); };
  const journal = journalStub();
  try {
    await run(h, seconds, { journal });
    const plans = journal.entries.filter((e) => e.kind === 'plan');
    assert.equal(plans.length, 2);
    assert.ok(plans[0].data.problems.length > 0);
    assert.equal(plans[1].data.problems.length, 0);
    await assert.rejects(() => run(h, seconds, { journal: null }), /E-FILM-JOURNAL/);
    await assert.rejects(() => run(h, seconds, { reserve: null }), /E-FILM-RESERVE/);
  } finally { h.restore(); }
});

test('a provider refusal is journaled, the prompt is rewritten, and the shot renders on the next try', async () => {
  const seconds = window().kMin * 25;
  const h = harness({ seconds });
  let refuseOnce = true;
  const base = h.client.startVideo;
  h.client.startVideo = async (args) => { if (refuseOnce) { refuseOnce = false; throw new Error('The request failed because the output video may be related to copyright restrictions.'); } return base(args); };
  const journal = journalStub();
  try {
    const out = await run(h, seconds, { journal });
    assert.ok(out.shots.every((s) => s.shipped === 'passed'));
    const fault = journal.entries.find((e) => e.kind === 'fault');
    assert.equal(fault.data.kind, 'refused');
    assert.ok(journal.entries.some((e) => e.kind === 'decision' && e.data.decision === 'rewrite'));
    assert.ok(journal.entries.some((e) => e.kind === 'cost' && e.data.code === 'E-PROVIDER-REFUSED'));
  } finally { h.restore(); }
});

test('the five rules load and refuse a book that is not exactly five', () => {
  const r = rules();
  assert.deepEqual(r.rules.map((x) => x.id), ['FILM-001', 'FILM-002', 'FILM-003', 'FILM-004', 'FILM-005']);
  const tmp = `${process.cwd()}/runs/.four-rules.json`;
  fs.mkdirSync(`${process.cwd()}/runs`, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, rules: r.rules.slice(0, 4) }));
  try { assert.throws(() => loadFilmRules(tmp), /E-RULES-INCOMPLETE/); } finally { fs.unlinkSync(tmp); }
});
