import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openJournal } from '../../agents/journal.js';
import { selectCandidate } from '../../agents/director/candidates.js';
import { loadProjectFs } from '../../state/persist-fs.js';
import { addNote, intake, judgeRun, knowledgePolicyGates, loadLaw, main, passJournal, regenerateReport, replayRun, resumeRun, runFilm, styleProblems, pricesProblems, parseArgs } from '../../cli/bravo.js';
import { buildReport } from '../../cli/report.js';
import { foldKnowledge, queryKnowledge, rebuildKnowledge, signatureOf } from '../../cli/kb.js';

const made = [];
const fresh = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bravo-cli-${label}-`));
  made.push(dir);
  return dir;
};
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const ENV = { MODELARK_TOS_BUCKET: 'b', MODELARK_TOS_REGION: 'r', MODELARK_ASSET_ACCESS_KEY: 'ak', MODELARK_ASSET_SECRET_KEY: 'sk', MODELARK_MODEL_AUDIO_JUDGE: 'test-aj' };
const envBefore = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);
after(() => { for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const withIteration = (book) => ({
  ...book,
  rules: book.rules.map((r) => (r.provenance?.origin === 'note' && !r.provenance.iteration ? { ...r, provenance: { ...r.provenance, iteration: 'creator-decree-2026-08-31' } } : r)),
});
const BOOKS = {
  cinematic: withIteration(JSON.parse(fs.readFileSync('rules/cinematic.json', 'utf8'))),
  screenwriting: withIteration(JSON.parse(fs.readFileSync('rules/screenwriting.json', 'utf8'))),
  metrics: JSON.parse(fs.readFileSync('rules/metrics.json', 'utf8')),
  policy: JSON.parse(fs.readFileSync('rules/policy.json', 'utf8')),
};
const rulesFixture = () => {
  const dir = fresh('rules');
  for (const [name, book] of Object.entries(BOOKS)) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(book));
  fs.mkdirSync(path.join(dir, 'rubrics'));
  for (const f of fs.readdirSync('rules/rubrics')) fs.copyFileSync(path.join('rules/rubrics', f), path.join(dir, 'rubrics', f));
  return dir;
};
const RULES_DIR = rulesFixture();

const SKILLS = [
  { id: 'sd25-pe', name: 'sd25-pe', description: '', text: 'the seedance spec', models: ['seedance25'] },
  { id: 'plate-pe', name: 'plate-pe', description: '', text: 'the plate spec', models: ['seedreamPro', 'seedream'] },
];
const skillsFixture = () => {
  const dir = fresh('skills');
  for (const s of SKILLS) {
    fs.mkdirSync(path.join(dir, s.id));
    fs.writeFileSync(path.join(dir, s.id, 'SKILL.md'), `---\nname: ${s.name}\nmodels:\n${s.models.map((m) => `  - ${m}`).join('\n')}\n---\n${s.text}\n`);
  }
  return dir;
};

const MODELS = { reasoner: 'test-r', seedance25: 'test-sd25', seedreamPro: 'test-srp', seedream: 'test-sr' };
const POLICY = { ...JSON.parse(fs.readFileSync('policy/default.json', 'utf8')), mode: 'staged' };
const STYLE = {
  id: 'house-test',
  look: { style: 'grainy 16mm', grade: 'cold teal shadows' },
  constraints: ['no on-screen text'],
  audio: true,
  format: { resolution: '720p', ratio: 'adaptive' },
  world: 'a coastal town after the fishing fleet left',
  references: [],
  doctrine: ['the opposition is visible in the frame before it is named'],
  precedentTags: [],
  seed: null,
};
const PRICES = { date: '2026-09-01', usd: { still: 0.05, videoSecond: 0.1, judgeCall: 0.01, reasonCall: 0.02 } };

const writeJson = (dir, name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };

const inputs = (over = {}) => {
  const dir = fresh('inputs');
  return {
    idea: 'someone races the tide',
    seconds: 100,
    style: { file: writeJson(dir, 'style.json', over.style || STYLE) },
    policy: { file: writeJson(dir, 'policy.json', over.policy || POLICY) },
    prices: { file: writeJson(dir, 'prices.json', over.prices || PRICES) },
    ...over.args,
  };
};

const K = 20;
const BEATS = Array.from({ length: K }, (_, i) => ({ id: `b${i + 1}`, text: `the water climbs step ${i + 1}` }));
const PROPOSAL = {
  logline: { value: 'A figure races the tide to reach a locked door.', reason: 'the idea names a race against a rising force' },
  world: { value: 'a coastal town after the fishing fleet left', reason: 'the style declares the world' },
  cast: [{ name: 'FIGURE-1', role: 'character', reason: 'the idea centres on one person' }],
  locations: [{ name: 'THE-QUAY', reason: 'the tide needs a shore' }],
  dramatis: { protagonist: 'FIGURE-1', want: 'reach the door before the tide', opposition: 'the tide rising across the quay', reason: 'both come from the idea' },
};
const SCREENPLAY = {
  scenes: [{ id: 'sc1', slug: { intExt: 'EXT', location: 'THE-QUAY', time: 'DAY' }, action: ['FIGURE-1 runs the quay as the tide climbs the steps.'], dialogue: [], turn: { from: 'dry', to: 'flooded' }, side: 'L', antagonism: true }],
  beats: BEATS,
};
const SETUPS = ['Wide Establisher', 'Medium Shot', 'Close-Up', 'Full Shot'];
const SHOTS = {
  shots: BEATS.map((b, i) => ({
    id: `s${i + 1}`, sceneId: 'sc1', beatId: b.id, subject: 'FIGURE-1', force: 'the tide climbs the steps behind the figure', change: `step ${i} dry -> step ${i + 1} under water`,
    setup: SETUPS[i % SETUPS.length], side: 'L', seconds: 5, location: 'THE-QUAY', join: i === 0 ? undefined : (i % 3 === 0 ? 'continuous' : 'cut'), moment: `the water takes step ${i + 1}`, dialogue: [],
  })),
};

const scriptedClient = () => {
  const calls = [];
  return {
    calls,
    async reason({ prompt, systemPrompt, images, ...rest }) {
      calls.push({ prompt, systemPrompt, images: images || [], rest });
      if (systemPrompt.startsWith('You judge a take') || systemPrompt.startsWith('You judge a join') || systemPrompt.startsWith('You judge the film')) return { content: JSON.stringify({ answers: [] }) };
      if (systemPrompt.startsWith('You derive the complete brief')) return { content: JSON.stringify(PROPOSAL) };
      if (systemPrompt.startsWith('You write the screenplay')) return { content: JSON.stringify(SCREENPLAY) };
      if (systemPrompt.startsWith('You break a screenplay')) return { content: JSON.stringify(SHOTS) };
      if (systemPrompt.includes('reference PLATE')) return { content: 'A neutral plate of the subject, square in frame, plainly lit.' };
      if (systemPrompt.includes('Write the FINAL PROMPT')) return { content: 'The figure climbs the quay steps as the water follows close behind.' };
      throw new Error(`scriptedClient: no answer for a system prompt starting ${JSON.stringify(systemPrompt.slice(0, 40))}`);
    },
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
  };
};

const makeWire = (opts = {}) => {
  const calls = { config: 0, rules: 0, imagine: [], animate: [], polls: [], measure: [], stitch: [], media: [] };
  const state = { models: opts.models || MODELS, failMeasure: opts.failMeasure || null, lost: new Set() };
  let taskN = 0;
  const real = globalThis.fetch;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const stub = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes('/api/film/config')) { calls.config += 1; return json({ models: state.models, missing: [], hasServerKey: true, tosRegion: 'r' }); }
    if (u.includes('/api/rules')) { calls.rules += 1; return json({ cinematic: BOOKS.cinematic, screenwriting: BOOKS.screenwriting, metrics: BOOKS.metrics }); }
    if (u.includes('/api/film/skills')) return json({ skills: SKILLS });
    if (u.includes('/api/film/imagine')) {
      calls.imagine.push(body);
      return json({ url: `https://x.test/plate${calls.imagine.length}.png`, cacheUrl: `/api/film/media?key=plate${calls.imagine.length}.png`, assetId: `asset-p${calls.imagine.length}` });
    }
    if (u.includes('/api/seedance-status')) {
      const id = new URL(u, 'http://t').searchParams.get('taskId');
      calls.polls.push(id);
      return json({ status: 'succeeded', video_url: `https://x.test/${id}.mp4`, video_cache_url: `/api/film/media?key=${id}.mp4`, last_frame_url: `https://x.test/${id}.jpg`, last_frame_cache_url: `/api/film/media?key=${id}.jpg` });
    }
    if (u.includes('/api/seedance')) { calls.animate.push(body); taskN += 1; return json({ id: `task${taskN}` }); }
    if (u.includes('/api/film/measure')) {
      calls.measure.push(body);
      if (state.failMeasure && body.url === state.failMeasure) return json({ error: 'ffprobe crashed' }, 500);
      const d = body.url.includes('slice') ? 100.3 : 5.04;
      return json({ duration: d, nbReadFrames: Math.round(d * 24), fps: 24, width: 1280, height: 720, hasAudio: true, firstHash: '0'.repeat(64), lastHash: '0'.repeat(64) });
    }
    if (u.includes('/api/film/stitch')) { calls.stitch.push(body); return json({ url: 'https://x.test/slice.mp4', cacheUrl: '/api/film/media?key=slice.mp4' }); }
    if (u.includes('/api/film/media') || u.startsWith('https://x.test/')) {
      calls.media.push(u);
      if ([...state.lost].some((key) => u.endsWith(key))) return json({ error: 'not in the store' }, 404);
      return new Response(Buffer.from(`bytes of ${u}`), { status: 200 });
    }
    throw new Error(`unstubbed fetch: ${u}`);
  };
  return { calls, state, install: () => { globalThis.fetch = stub; }, restore: () => { globalThis.fetch = real; } };
};

const stubStages = ({ probe = null } = {}) => {
  const calls = { generate: [], score: [], qc: [], join: [], film: [], plateQC: [], probes: [] };
  let cand = 0;
  return {
    calls,
    stages: {
      plateQC: async ({ plate, journal }) => {
        calls.plateQC.push({ entity: plate.entity, url: plate.url });
        await journal.write('qc', { kind: 'plate', entity: plate.entity, pass: true, score: 0.9, findings: [] });
        return { pass: true, score: 0.9, findings: [] };
      },
      generateCandidates: async ({ shot, plates, k, journal, reserve }) => {
        calls.generate.push({ shot: shot.id, k, plates: plates.length });
        const out = [];
        for (let i = 0; i < k; i += 1) {
          await reserve({ nodeId: `keyframe:${shot.id}`, kind: 'still', units: 1, justification: `keyframe candidate ${i + 1} of ${k} for shot ${shot.id}` });
          cand += 1;
          const c = { id: `cand-${cand}`, shotId: shot.id, url: `/api/film/media?key=cand-${cand}.png`, path: `media/cand-${cand}.png`, attempt: i + 1 };
          await journal.write('candidate', { ...c, nodeId: `keyframe:${shot.id}` });
          out.push(c);
        }
        return out;
      },
      scoreCandidate: async ({ candidate, shot, siblings, journal }) => {
        calls.score.push({ id: candidate.id, siblings: siblings.length });
        const score = 0.9 - (Number(candidate.id.slice(5)) % 3) * 0.05;
        await journal.write('score', { candidateId: candidate.id, shotId: shot.id, score, deterministicScore: score, deterministic: {}, rubric: {} });
        return { score, deterministic: {}, rubric: {} };
      },
      selectCandidate,
      takeQC: async ({ take, shot, client }) => {
        calls.qc.push({ shot: shot.id, takeId: take.takeId });
        if (probe) calls.probes.push(probe({ shot: shot.id }));
        await client.reason({ prompt: `take ${take.takeId}`, systemPrompt: 'You judge a take', images: [take.url], nodeId: `qc:${shot.id}` });
        return { pass: true, score: 0.9, findings: [] };
      },
      joinQC: async ({ prev, next, joinType, distance, client, journal }) => {
        calls.join.push({ joinRef: `${prev.shotId}->${next.shotId}`, joinType, distance });
        await client.reason({ prompt: `join ${prev.shotId}->${next.shotId}`, systemPrompt: 'You judge a join', images: [prev.url, next.url], nodeId: `chain:${next.shotId}` });
        await journal.write('qc', { kind: 'join', joinRef: `${prev.shotId}->${next.shotId}`, findings: [] });
        return { findings: [] };
      },
      filmQC: async ({ slice, manifest, screenplay, client, journal }) => {
        calls.film.push({ url: slice.url, shots: manifest.shots.length, beats: screenplay.beats.length, subjects: manifest.shots.map((sh) => sh.subject) });
        await client.reason({ prompt: 'the film', systemPrompt: 'You judge the film', images: [slice.url], nodeId: 'final' });
        await journal.write('qc', { kind: 'film', findings: [] });
        return { findings: [], verdicts: {}, calls: [] };
      },
    },
  };
};

const workspace = (label) => {
  const root = fresh(label);
  return { root, runsDir: path.join(root, 'runs'), knowledgeDir: path.join(root, 'knowledge') };
};

const journalOf = async (dir) => { const j = await openJournal({ dir }); const entries = j.entries(); await j.close(); return entries; };
const kinds = (entries) => [...new Set(entries.map((e) => e.kind))];

const film = async ({ ws, wire, client, stages, runId, over = {} }) => {
  wire.install();
  try {
    return await runFilm({ ...ws, rulesDir: RULES_DIR, runId, client, stages, server: 'stub', ...inputs(over) });
  } finally {
    wire.restore();
  }
};

test('intake refuses by name, journals the refusal, and spends nothing: style keys, policy schema, the CIN-005 window, unset slots, the audio judge, the price file', async () => {
  const ws = workspace('intake');
  const cases = [
    { label: 'style-audio', over: { style: (() => { const { audio, ...rest } = STYLE; void audio; return rest; })() }, code: 'E-INTAKE-STYLE-AUDIO' },
    { label: 'style-format', over: { style: (() => { const { format, ...rest } = STYLE; void format; return rest; })() }, code: 'E-INTAKE-STYLE-FORMAT' },
    { label: 'style-format-fps', over: { style: { ...STYLE, format: { ...STYLE.format, fps: 24 } } }, code: 'E-INTAKE-STYLE-FORMAT-FPS' },
    { label: 'policy', over: { policy: { ...POLICY, extra: 1 } }, code: 'E-INTAKE-POLICY' },
    { label: 'window', over: { args: { seconds: 12 } }, code: 'E-INTAKE-WINDOW' },
    { label: 'slot', models: { reasoner: 'test-r', seedreamPro: 'test-srp' }, code: 'E-INTAKE-SLOT-SEEDANCE25' },
    { label: 'prices', over: { prices: { date: 'yesterday', usd: PRICES.usd } }, code: 'E-INTAKE-PRICES-DATE' },
    { label: 'audio-judge', env: { MODELARK_MODEL_AUDIO_JUDGE: '' }, code: 'E-INTAKE-SLOT-AUDIOJUDGE' },
    { label: 'tos', env: { MODELARK_TOS_BUCKET: '' }, code: 'E-INTAKE-TOS' },
  ];
  for (const c of cases) {
    const saved = { ...process.env };
    if (c.env) Object.assign(process.env, c.env);
    const wire = makeWire({ models: c.models });
    const client = scriptedClient();
    const { stages } = stubStages();
    let err = null;
    try {
      await film({ ws, wire, client, stages, runId: `refused-${c.label}`, over: c.over || {} });
    } catch (e) { err = e; } finally { process.env = saved; }
    assert.ok(err, `${c.label}: intake should refuse`);
    assert.equal(err.code, c.code, `${c.label}: ${err.message}`);
    const entries = await journalOf(path.join(ws.runsDir, `refused-${c.label}`));
    const refused = entries.find((e) => e.kind === 'intake.refused');
    assert.ok(refused, `${c.label}: the refusal is journaled`);
    assert.equal(refused.data.code, c.code);
    assert.ok(!entries.some((e) => e.kind === 'intake'), `${c.label}: no intake record after a refusal`);
    assert.equal(client.calls.length, 0, `${c.label}: no reasoning before intake passes`);
    assert.equal(wire.calls.imagine.length + wire.calls.animate.length, 0, `${c.label}: no money before intake passes`);
  }
  assert.deepEqual(styleProblems({ ...STYLE, references: [{ name: 'X', role: 'prop' }] }).map((p) => p.key), ['references.0']);
  assert.deepEqual(pricesProblems({ date: '2026-09-01', usd: { still: 1, videoSecond: 1, judgeCall: 1 } }).map((p) => p.key), ['usd.reasonCall']);
  assert.deepEqual(parseArgs(['film', '--idea', 'x', '--seconds', '100']), { command: 'film', positional: [], flags: { idea: 'x', seconds: '100' } });
  assert.throws(() => parseArgs(['replay', 'r', '--dry', '--dry']), /given twice/);
});

const passed = {};

test('a fully stubbed pass completes: intake, ideation, brief, screenplay, breakdown, keyframe decisions, approval, a policy schedule, join and film QC, report, complete, kb fold — every step in the journal', async () => {
  const ws = workspace('film');
  const wire = makeWire();
  const client = scriptedClient();
  const dir = path.join(ws.runsDir, 'run_full');
  const probe = () => {
    if (!fs.existsSync(path.join(dir, 'project.json'))) return { saved: false };
    const nodes = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).sequences[0].run?.nodes || {};
    return { saved: true, done: Object.values(nodes).filter((n) => n.status === 'done').length, running: Object.values(nodes).filter((n) => n.status === 'running').length };
  };
  const { calls, stages } = stubStages({ probe });
  const out = await film({ ws, wire, client, stages, runId: 'run_full' });
  assert.equal(out.status, 'complete', JSON.stringify(out));
  passed.full = { ws, dir, wire, calls };

  const entries = await journalOf(dir);
  const seen = kinds(entries);
  for (const kind of ['pass', 'intake', 'project', 'ideate.start', 'ideate.attempt', 'ideate.result', 'policy.gate', 'brief.input', 'tool', 'gate.attempt', 'gate', 'brief', 'screenplay', 'plan', 'keyframes', 'approve', 'sequence.approved', 'reservation', 'intent', 'result', 'cost', 'media', 'node', 'schedule', 'keyframe', 'candidate', 'score', 'select', 'selection', 'measure', 'join', 'qc', 'assemble', 'final', 'iteration', 'joins', 'film', 'policy.audit', 'report', 'complete', 'kb.fold']) {
    assert.ok(seen.includes(kind), `journal has a ${kind} step (has: ${seen.join(', ')})`);
  }
  assert.ok(!seen.includes('fault') && !seen.includes('pass.failed') && !seen.includes('reservation.refused') && !seen.includes('regeneration'), 'a clean pass has no faults, no failure, no refusal, no regeneration');
  assert.deepEqual(entries.map((e) => e.step), entries.map((_, i) => i + 1), 'steps are monotonic');
  assert.equal(wire.calls.rules, 0, 'the pass runs under the rulebook intake loaded — nothing fetches /api/rules');

  const policyRuns = [
    ...entries.filter((e) => e.kind === 'policy.gate').map((e) => [e.data.ruleId, e.data.stage, e.data.pass]),
    ...entries.filter((e) => e.kind === 'policy.audit').flatMap((e) => e.data.rules.map((r) => [r.ruleId, `audit:${e.data.scope}`, r.pass])),
  ];
  assert.deepEqual(policyRuns.map(([id, where]) => `${id}@${where}`), [
    'POL-001@ideate', 'POL-012@keyframes', 'POL-006@keyframes', 'POL-002@approve',
    'POL-003@audit:journal', 'POL-004@audit:journal', 'POL-005@audit:journal', 'POL-007@audit:journal', 'POL-008@audit:journal', 'POL-011@audit:journal', 'POL-013@audit:journal',
    'POL-009@audit:knowledge', 'POL-010@audit:knowledge',
  ], 'every policy rule after intake runs where its statement says, journaled');
  assert.ok(policyRuns.every(([, , pass]) => pass === true), `every policy rule held: ${JSON.stringify(policyRuns.filter(([, , p]) => !p))}`);
  const audit = entries.find((e) => e.kind === 'policy.audit' && e.data.scope === 'journal').data;
  const pol003 = audit.results.filter((r) => r.ruleId === 'POL-003');
  assert.ok(pol003.length >= 60 && pol003.every((r) => r.pass && typeof r.value === 'string' && r.value.startsWith('res_')), 'POL-003 is checked from the journal alone: every kept cost row names a reservation that preceded it');

  const intakeRec = entries.find((e) => e.kind === 'intake').data;
  assert.equal(intakeRec.policyHash.length, 64);
  assert.equal(intakeRec.slots.video.id, 'test-sd25');
  assert.equal(intakeRec.slots.audioJudge, 'test-aj');
  assert.ok(intakeRec.gate.every((r) => r.pass), 'POL-000 passed at intake');
  assert.deepEqual(intakeRec.window.feasible, { ok: true, k: 20, partition: Array(20).fill(5) });

  const plan = entries.find((e) => e.kind === 'plan').data;
  assert.equal(plan.shots.length, 20);
  assert.ok(plan.shots.every((sh) => sh.subject === 'FIGURE-1' && sh.force && sh.change && sh.prompt && typeof sh.keyframe.needed === 'boolean' && sh.keyframe.reason));
  assert.equal(plan.plates.length, 2);
  const gateSteps = entries.filter((e) => e.kind === 'gate');
  assert.deepEqual(gateSteps.map((e) => e.data.tool), ['brief', 'screenplay', 'breakdown'], 'every plan tool writes its gate report');
  const attemptSteps = entries.filter((e) => e.kind === 'gate.attempt');
  assert.deepEqual(attemptSteps.map((e) => `${e.data.tool}:${e.data.phase}:${e.data.attempt}:${e.data.pass}`), ['brief:brief:1:true', 'screenplay:screenplay:1:true', 'breakdown:structure:1:true', 'breakdown:plan:1:true'], 'the tools journal every gate run as it happens');
  for (const a of attemptSteps) {
    const toolStep = entries.find((e) => e.kind === 'tool' && e.data.name === a.data.tool);
    assert.ok(a.step < toolStep.step, `${a.data.tool}: the tool's own gate report precedes its tool step`);
    assert.ok(a.data.results.length > 0 && a.data.results.every((r) => r.ruleId && typeof r.pass === 'boolean'), `${a.data.tool}: full gate rows`);
  }
  for (const g of gateSteps) {
    assert.deepEqual(g.data.blockers, [], `${g.data.tool}: a landed stage has no blockers`);
    assert.deepEqual(g.data.attempts, [], `${g.data.tool}: a first attempt that lands records no rejection`);
    assert.ok(g.data.results.every((r) => r.ruleId && r.subject && typeof r.pass === 'boolean' && typeof r.blocking === 'boolean'), `${g.data.tool}: every row is a full gate verdict`);
    const toolStep = entries.find((e) => e.kind === 'tool' && e.data.name === g.data.tool);
    assert.ok(toolStep.step < g.step, `${g.data.tool}: the gate step follows its tool step`);
  }
  assert.deepEqual(gateSteps[0].data.results.map((r) => [r.ruleId, r.subject, r.pass]), [['SCR-008', 'brief', true]], 'the brief report carries the brief stage only');
  const briefStep = entries.find((e) => e.kind === 'brief');
  assert.deepEqual(briefStep.data.brief.format, { fps: BOOKS.screenwriting.rules.find((r) => r.id === 'SCR-008').params.fps, resolution: STYLE.format.resolution, ratio: STYLE.format.ratio, audio: STYLE.audio }, 'the brief format is the style\'s declaration under the law\'s fps');
  assert.match(briefStep.data.provenance.format.reason, /carried verbatim from style house-test format and audio/);
  assert.deepEqual(entries.find((e) => e.kind === 'brief.input').data.input.format, { resolution: STYLE.format.resolution, ratio: STYLE.format.ratio, audio: STYLE.audio }, 'the brief tool received the format it recorded');
  assert.ok(!entries.some((e) => e.kind === 'brief.audio'), 'no post-hoc patch of the brief');
  assert.ok(gateSteps[1].data.results.some((r) => r.ruleId === 'SCR-004' && r.pass));
  assert.ok(gateSteps[1].data.results.every((r) => ['brief', 'screenplay'].includes(BOOKS.screenwriting.rules.concat(BOOKS.cinematic.rules).find((x) => x.id === r.ruleId).appliesTo)), 'the screenplay report carries the brief and screenplay stages only');
  const scr013 = gateSteps[2].data.results.filter((r) => r.ruleId === 'SCR-013');
  for (const sh of plan.shots) {
    const rows = scr013.filter((r) => r.subject === `shot ${sh.id}`);
    assert.equal(rows.length, 3, `${sh.id}: a subject, a force and a change verdict are journaled`);
    assert.deepEqual(rows.map((r) => r.value), [sh.subject, sh.force, sh.change]);
  }
  const share = scr013.find((r) => r.subject === 'shotplan');
  assert.equal(share.value, '0/20 shots without a force (0.00)');
  assert.equal(share.threshold, `<= ${POLICY.antagonism.maxShareWithoutForce} (policy.antagonism.maxShareWithoutForce)`);
  assert.equal(scr013.filter((r) => r.subject.startsWith('join ')).length, 6, 'every continuous join is judged');
  const kf = entries.find((e) => e.kind === 'keyframes').data;
  assert.equal(kf.blockers.length, 0);
  assert.equal(kf.decisions.filter((d) => d.keyframe.needed).length, 14, 'the first shot and every cut need a keyframe; continuous shots do not');

  const approve = entries.find((e) => e.kind === 'approve').data;
  assert.equal(approve.ok, true);
  assert.equal(approve.arithmetic.takes.count, 20);
  assert.equal(approve.arithmetic.candidates.shots, 14);
  assert.deepEqual(approve.arithmetic.judgeCalls.judged, { plates: { base: 2, max: 10 }, candidates: { base: 42, max: 210 }, takes: { base: 20, max: 100 }, joins: { base: 19, max: 19 }, film: { segments: 4, base: 5, max: 5 } }, 'the approval counts every judged item the pass can reserve for');
  assert.deepEqual([approve.arithmetic.judgeCalls.base, approve.arithmetic.judgeCalls.max], [(2 + 42 + 20 + 19 + 5) * 2, (10 + 210 + 100 + 19 + 5) * 5], 'judge calls are counted per judged item times the protocol calls, as the reserving client counts them');
  assert.equal(approve.estimate.pricesDate, '2026-09-01');
  assert.ok(approve.spent.usd > 0, 'reasoning spend before approval is counted');
  assert.equal(entries.find((e) => e.kind === 'sequence.approved').data.decidedBy, 'policy');

  assert.equal(client.calls.length, 65, 'ideate + screenplay + breakdown + 20 shot prompts + 2 plate prompts + 20 take judgements + 19 join judgements + the film');
  assert.ok(client.calls.every((c) => !('nodeId' in c.rest)), 'the node id never reaches the wire');
  assert.equal(wire.calls.imagine.length, 2, 'two plates rendered by the wire');
  assert.equal(wire.calls.animate.length, 20, 'twenty takes rendered by the wire');
  assert.equal(calls.generate.length, 14);
  assert.equal(calls.qc.length, 20);
  assert.equal(calls.join.length, 19);
  assert.equal(calls.film.length, 1);
  assert.deepEqual(calls.film[0].subjects, Array(20).fill('FIGURE-1'), 'filmQC sees the enriched manifest');
  assert.equal(calls.film[0].beats, 20);

  const reservations = entries.filter((e) => e.kind === 'reservation').map((e) => e.data);
  assert.equal(reservations.filter((r) => r.kind === 'reason').length, 25, 'every reasoning call was reserved');
  assert.equal(reservations.filter((r) => r.kind === 'take').length, 20);
  assert.equal(reservations.filter((r) => r.kind === 'still').reduce((a, r) => a + r.units, 0), 2 + 14 * POLICY.candidates.perShot);
  assert.equal(reservations.filter((r) => r.kind === 'judge').length, 40, 'twenty take judgements, nineteen joins and the film');
  assert.ok(reservations.every((r) => typeof r.usd === 'number'), 'every reservation is priced');
  assert.ok(reservations.every((r) => r.nodeId !== 'schedule'), 'no reservation hides behind the schedule stage');
  assert.ok(reservations.every((r) => ['ideate', 'brief', 'screenplay', 'breakdown'].includes(r.nodeId) || /^(plate|keyframe|shoot|qc|chain):/.test(r.nodeId) || r.nodeId === 'final'), `every reservation names a planning stage or a plan node: ${[...new Set(reservations.map((r) => r.nodeId))].join(', ')}`);
  assert.equal(reservations.filter((r) => r.kind === 'judge' && r.nodeId.startsWith('chain:')).length, 19, 'every join judgement is reserved under its chain node by the call itself');
  assert.equal(reservations.filter((r) => r.kind === 'judge').length, entries.filter((e) => e.kind === 'cost' && e.data.kind === 'judge' && e.data.disposition === 'kept').length, 'judge reservations and judge cost rows count the same calls');
  assert.equal(new Set(reservations.filter((r) => r.kind === 'judge' && r.nodeId.startsWith('qc:')).map((r) => r.nodeId)).size, 20, 'every take judgement is reserved under its own shot');
  const intents = entries.filter((e) => e.kind === 'intent');
  const results = entries.filter((e) => e.kind === 'result');
  assert.equal(intents.length, results.length, 'every intent has its result');
  assert.equal(intents.filter((e) => e.data.call === 'startVideo').length, 20);
  for (const i of intents.filter((e) => e.data.call === 'render.start')) assert.ok(i.data.firstFrameUrl, 'every take carried a first frame');

  assert.equal(entries.find((e) => e.kind === 'final').data.gates.find((g) => g.ruleId === 'CIN-008').pass, true);
  const done = entries.find((e) => e.kind === 'complete').data;
  assert.equal(done.status, 'complete');
  assert.ok(done.guarantees.every((g) => g.met), JSON.stringify(done.guarantees.filter((g) => !g.met)));
  assert.equal(done.ledger.takes, 20);
  assert.equal(done.ledger.videoSeconds, 100, 'twenty 5s takes are one hundred video seconds, not twenty');
  const takeReservations = reservations.filter((r) => r.kind === 'take');
  assert.ok(takeReservations.every((r) => r.units === 5 && r.usd === Math.round(5 * PRICES.usd.videoSecond * 1e6) / 1e6), 'a take is reserved as its seconds and priced at seconds × usd.videoSecond');
  assert.equal(approve.arithmetic.videoSeconds.max, 100 * POLICY.attempts.shot, 'the approved video-second ceiling is what the take reservations can reach');
  assert.equal(takeReservations.at(-1).after.videoSeconds, 100, 'the last take reservation leaves the ledger at the approval\'s base video seconds');
  const assembled = entries.find((e) => e.kind === 'assemble').data;
  assert.deepEqual({ media: assembled.media, admission: assembled.admission }, { media: 'slice-a1.mp4', admission: 1 }, 'the slice is named by the assemble node\'s admission, like every other regenerable artifact');
  assert.equal(done.slicePath, path.join(dir, 'media', assembled.media), 'complete reads the slice path off the assemble step');
  assert.ok(fs.existsSync(done.slicePath));
  assert.ok(fs.existsSync(path.join(dir, 'report.md')));
  assert.ok(fs.existsSync(path.join(dir, 'errors.ndjson')));
  assert.ok(fs.readFileSync(path.join(dir, 'cost.ndjson'), 'utf8').split('\n').filter(Boolean).length >= 22);
  assert.ok(fs.existsSync(path.join(ws.knowledgeDir, 'index.json')));
  const project = await loadProjectFs(dir);
  const seq = project.sequences[0];
  assert.equal(seq.status, 'assembled');
  assert.equal(seq.iterations.length, 1);
  assert.equal(seq.iterations[0].status, 'assembled');
  assert.equal(seq.run.flow, 'policy');
  assert.equal(Object.keys(seq.run.takes).length, 20);
  const media = fs.readdirSync(path.join(dir, 'media'));
  assert.ok(media.includes('plate-FIGURE_1.png') && media.includes('shoot-s1-attempt1.mp4') && media.includes('keyframe-s1-attempt1.png'));
  assert.equal(seq.rulebookVersion, intakeRec.rulebookVersion, 'the tools pinned the rulebook intake loaded — one rulebook per pass');
  assert.ok(calls.probes.length === 20 && calls.probes.every((p) => p.saved && p.done > 0), `project.json is written through during the schedule so a killed pass has a run record: ${JSON.stringify(calls.probes[0])}`);
});

test('a plan the policy refuses (POL-006: a chain over the policy length) is regenerated with the refusal in the prompt, within policy.attempts.fault, and journaled as a regeneration', async () => {
  const ws = workspace('plan-regen');
  const wire = makeWire();
  const client = scriptedClient();
  const breakdowns = [];
  const inner = client.reason.bind(client);
  client.reason = async (args) => {
    if (args.systemPrompt.startsWith('You break a screenplay')) {
      breakdowns.push(args.prompt);
      if (breakdowns.length === 1) return { content: JSON.stringify({ shots: SHOTS.shots.map((sh, i) => ({ ...sh, join: i === 0 ? undefined : (i <= 5 ? 'continuous' : sh.join) })) }) };
    }
    return inner(args);
  };
  const { stages } = stubStages();
  const out = await film({ ws, wire, client, stages, runId: 'run_plan', over: { policy: { ...POLICY, attempts: { ...POLICY.attempts, fault: 2 } } } });
  assert.equal(out.status, 'complete', JSON.stringify(out));
  assert.equal(breakdowns.length, 2, 'the breakdown ran twice');
  assert.ok(!breakdowns[0].includes('REFUSED BY POLICY') && /REFUSED BY POLICY[\s\S]*\[POL-006\] chain s1/.test(breakdowns[1]), 'the second breakdown carries the policy refusal');
  const entries = await journalOf(path.join(ws.runsDir, 'run_plan'));
  const regen = entries.filter((e) => e.kind === 'regeneration').map((e) => e.data);
  assert.equal(regen.length, 1);
  assert.deepEqual({ stage: regen[0].stage, mode: regen[0].mode, attempt: regen[0].attempt, budget: regen[0].budget, ruleId: regen[0].ruleId }, { stage: 'plan', mode: 'plan-regenerate', attempt: 1, budget: 2, ruleId: 'POL-006' });
  assert.ok(/chain of 7 exceeds the policy length/.test(regen[0].cause), regen[0].cause);
  const keyframes = entries.filter((e) => e.kind === 'keyframes').map((e) => e.data);
  assert.deepEqual(keyframes.map((k) => [k.attempt, k.blockers.length]), [[1, 1], [2, 0]], 'both plan attempts are journaled with their gates');
  const gates = entries.filter((e) => e.kind === 'policy.gate' && e.data.ruleId === 'POL-006').map((e) => e.data.pass);
  assert.deepEqual(gates, [false, true]);
  assert.equal(entries.filter((e) => e.kind === 'plan').length, 2);
  assert.ok(!entries.some((e) => e.kind === 'fault'), 'a policy refusal of the plan is a regeneration, not a fault');
  assert.equal(entries.filter((e) => e.kind === 'intent' && e.data.call === 'startVideo').length, 20, 'the money was spent on the plan the policy accepted');
  const project = await loadProjectFs(path.join(ws.runsDir, 'run_plan'));
  assert.ok(project.sequences[0].plan.shots.slice(1).filter((sh) => sh.join === 'continuous').length === 6, 'the accepted plan is the corrected one');
});

test('a plan the policy refuses on every attempt fails the pass by name before any money', async () => {
  const ws = workspace('plan-exhausted');
  const wire = makeWire();
  const client = scriptedClient();
  const inner = client.reason.bind(client);
  client.reason = async (args) => (args.systemPrompt.startsWith('You break a screenplay')
    ? { content: JSON.stringify({ shots: SHOTS.shots.map((sh, i) => ({ ...sh, join: i === 0 ? undefined : (i <= 5 ? 'continuous' : sh.join) })) }) }
    : inner(args));
  const { stages } = stubStages();
  const out = await film({ ws, wire, client, stages, runId: 'run_plan_x', over: { policy: { ...POLICY, attempts: { ...POLICY.attempts, fault: 2 } } } });
  assert.equal(out.status, 'failed');
  assert.equal(out.code, 'E-PLAN-POLICY-EXHAUSTED');
  assert.equal(out.stage, 'keyframes');
  const entries = await journalOf(path.join(ws.runsDir, 'run_plan_x'));
  assert.equal(entries.filter((e) => e.kind === 'regeneration').length, 1, 'one regeneration within a fault budget of two');
  assert.equal(wire.calls.imagine.length + wire.calls.animate.length, 0, 'no money');
  assert.ok(fs.readFileSync(path.join(ws.runsDir, 'run_plan_x', 'report.md'), 'utf8').includes('NOT MET'));
});

test('main wires the transport bare: a throttled reasoning call is an intent with an error result, a fault row under the stage, and a fresh reservation before the retry; the policy fault budget bounds it', async () => {
  const root = fresh('main');
  fs.cpSync(RULES_DIR, path.join(root, 'rules'), { recursive: true });
  const files = inputs({ policy: { ...POLICY, attempts: { ...POLICY.attempts, fault: 2 } } });
  const wire = makeWire();
  const seed = [];
  const answer = (body, seedN) => {
    if (seedN === 1) return { status: 429, data: { error: 'too many requests' } };
    if (body.systemPrompt.startsWith('You derive the complete brief')) return { status: 200, data: { content: JSON.stringify(PROPOSAL) } };
    return { status: 400, data: { error: 'the reasoner refused the request' } };
  };
  wire.install();
  const stubbed = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (new URL(u, 'http://t').pathname === '/api/seed') {
      const body = JSON.parse(init.body);
      seed.push(body);
      const { status, data } = answer(body, seed.length);
      return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return stubbed(u, init);
  };
  const printed = [];
  let code;
  try {
    code = await main(['film', '--idea', 'someone races the tide', '--seconds', '100', '--style', files.style.file, '--policy', files.policy.file, '--prices', files.prices.file, '--server', 'http://stub.test'], { cwd: root, out: (line) => printed.push(line) });
  } finally {
    wire.restore();
  }
  assert.equal(code, 1);
  const result = JSON.parse(printed.join('\n'));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'E-PASS-EXHAUSTED-SCREENPLAY');
  assert.equal(seed.length, 4, 'ideate twice (429, then the brief), screenplay twice (refused, refused)');

  const entries = await journalOf(result.dir);
  const before = (kind) => entries.findIndex((e) => e.kind === kind);
  const ideation = entries.slice(before('ideate.start'), before('ideate.result'));
  assert.deepEqual(ideation.filter((e) => ['intent', 'result', 'fault', 'reservation'].includes(e.kind)).map((e) => `${e.kind}:${e.data.call || e.data.kind || e.data.id}`), [
    'reservation:reason', 'intent:reason', 'result:reason',
    'fault:ideate',
    'reservation:reason', 'intent:reason', 'result:reason',
  ]);
  const [throttled, answered] = ideation.filter((e) => e.kind === 'result').map((e) => e.data);
  assert.equal(throttled.error.message, 'too many requests');
  assert.equal(JSON.parse(answered.content).logline.value, PROPOSAL.logline.value);
  const fault = ideation.find((e) => e.kind === 'fault').data;
  assert.deepEqual({ id: fault.id, attempt: fault.attempt, budget: fault.budget, reason: fault.reason }, { id: 'ideate', attempt: 1, budget: 2, reason: 'too many requests' });
  assert.ok(ideation.filter((e) => e.kind === 'reservation').every((e) => e.data.nodeId === 'ideate'));

  const faults = entries.filter((e) => e.kind === 'fault').map((e) => `${e.data.id}:${e.data.attempt}/${e.data.budget}`);
  assert.deepEqual(faults, ['ideate:1/2', 'screenplay:1/2', 'screenplay:2/2']);
  assert.equal(entries.filter((e) => e.kind === 'intent').length, entries.filter((e) => e.kind === 'result').length, 'every attempt is an intent with its result');
  assert.equal(entries.filter((e) => e.kind === 'reservation' && e.data.kind === 'reason').length, 4, 'every attempt is reserved');
  assert.equal(entries.find((e) => e.kind === 'pass.failed').data.code, 'E-PASS-EXHAUSTED-SCREENPLAY');
});

test('report.md is regenerated from the journal and opens with the guarantees, met first', async () => {
  assert.ok(passed.full, 'the full pass ran');
  const { ws, dir } = passed.full;
  const before = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  const out = await regenerateReport({ runsDir: ws.runsDir, runId: 'run_full' });
  const text = fs.readFileSync(out.report, 'utf8');
  assert.equal(out.summary.status, 'complete');
  assert.equal(out.summary.guarantees.length, 8);
  assert.ok(out.summary.guarantees.every((g) => g.met));
  assert.ok(text.startsWith('# Pass run_full — complete'));
  const guaranteesAt = text.indexOf('## Guarantees');
  assert.ok(guaranteesAt > 0 && guaranteesAt < text.indexOf('## Regenerations'), 'guarantees come first');
  assert.ok(/\| A film and a journal, every pass \| met \|/.test(text));
  assert.ok(text.includes('## Shortfalls') && text.includes('## The judge\'s open findings') && text.includes('## Cost'));
  const stable = (t) => t.split('\n').slice(2).join('\n').replace(/\d+ (journal )?steps[^\n|]*/g, 'N steps');
  assert.equal(stable(before), stable(text), 'the regenerated report says the same as the pass wrote');
  const entries = await journalOf(dir);
  assert.equal(entries.filter((e) => e.kind === 'report').length, 2, 'the regeneration is journaled');

  const failedSummary = buildReport({ entries: [{ step: 1, at: 'now', kind: 'pass', data: {} }, { step: 2, at: 'now', kind: 'intake', data: { idea: 'x', seconds: 100, style: { id: 's' }, styleHash: 'h', policy: { id: 'p', judge: { spendingRubrics: ['artifact'] } }, policyHash: 'h', prices: { date: 'd' }, rulebookVersion: 'v', rubricsVersion: 'v' } }, { step: 3, at: 'now', kind: 'pass.failed', data: { stage: 'screenplay', code: 'E-PASS-EXHAUSTED-SCREENPLAY', detail: 'twice' } }], project: null, runId: 'r' });
  assert.equal(failedSummary.summary.status, 'failed');
  assert.ok(failedSummary.summary.guarantees.filter((g) => g.id !== 'journal-never-lies' && g.id !== 'money-bounded' && g.id !== 'judge-authority-earned').every((g) => g.met === false));
  assert.ok(failedSummary.text.includes('NOT MET') && failedSummary.text.includes('E-PASS-EXHAUSTED-SCREENPLAY'));
});

test('a note lands on the latest iteration in the critic\'s shape with author human, is journaled, and refuses an unknown shot', async () => {
  assert.ok(passed.full, 'the full pass ran');
  const { ws, dir } = passed.full;
  await assert.rejects(() => addNote({ runsDir: ws.runsDir, runId: 'run_full', text: 'x', severity: 'note', shotRef: 's99' }), /E-NOTE-SHOT/);
  await assert.rejects(() => addNote({ runsDir: ws.runsDir, runId: 'run_full', text: 'x', severity: 'strong' }), /E-NOTE-SEVERITY/);
  const out = await addNote({ runsDir: ws.runsDir, runId: 'run_full', text: 'the tide never touches the figure', severity: 'blocker', shotRef: 's4', timecode: 17.5, ruleRef: 'SCR-013' });
  assert.equal(out.note.author, 'human');
  assert.equal(out.note.disposition, 'pending');
  const project = await loadProjectFs(dir);
  const notes = project.sequences[0].iterations.at(-1).notes;
  assert.equal(notes.length, 1);
  assert.deepEqual({ text: notes[0].text, shotRef: notes[0].shotRef, timecode: notes[0].timecode, ruleRef: notes[0].ruleRef, severity: notes[0].severity, author: notes[0].author }, { text: 'the tide never touches the figure', shotRef: 's4', timecode: 17.5, ruleRef: 'SCR-013', severity: 'blocker', author: 'human' });
  const entries = await journalOf(dir);
  assert.equal(entries.filter((e) => e.kind === 'note').length, 1);
});

const syntheticRun = (runsDir, runId, { idea, findings, joins, notes }) => {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(path.join(dir, 'steps'), { recursive: true });
  const shots = [{ id: 's1', seconds: 5 }, { id: 's2', seconds: 6 }];
  const records = [
    { kind: 'pass', data: { runId } },
    { kind: 'intake', data: { runId, idea, seconds: 11, style: { id: 'house' }, policy: POLICY } },
    { kind: 'plan', data: { shots } },
    { kind: 'measure', data: { shotId: 's1', takeId: 't1', measured: 5.04, fps: 24 } },
    { kind: 'measure', data: { shotId: 's2', takeId: 't2', measured: 6.1, fps: 24 } },
    ...joins.map((j) => ({ kind: 'join', data: j })),
    ...findings.map((f) => ({ kind: 'finding', data: f })),
    { kind: 'complete', data: { runId, status: 'complete' } },
  ];
  fs.writeFileSync(path.join(dir, 'journal.ndjson'), records.map((r, i) => JSON.stringify({ step: i + 1, at: new Date().toISOString(), ...r })).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'errors.ndjson'), findings.map((f, i) => JSON.stringify({ step: i + 1, ...f })).join('\n') + '\n');
  const project = { schemaVersion: 1, id: `prj_${runId}`, title: 't', createdAt: 'x', updatedAt: 'x', film: { shots: [] }, bible: [], activity: [], look: { style: '', grade: '', notes: '' }, threads: [], sequences: [{ id: `seq_${runId}`, brief: null, screenplay: null, beats: [], plan: { slot: 'seedance25', shots, plates: [] }, rulebookVersion: 'v', shotIds: [], manifestHash: null, status: 'assembled', iterations: [{ id: `it_${runId}`, index: 0, notes, corrections: [], gates: [], runs: [], measurements: { perShot: [], joins: [], timeline: null }, artifacts: {}, cost: {}, status: 'assembled' }] }] };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  return dir;
};

const row = (runId, over) => ({ finding_id: `f_${runId}_${Math.random().toString(36).slice(2, 6)}`, runId, at: new Date().toISOString(), family: 'qc', stage: 'qc', severity: 'note', code: 'E-RUBRIC-FAIL', detail: 'd', evidence: [], ...over });

test('kb fold derives knowledge/index.json from every run: counts by code, recurrence across runs and ideas, calibration from joins, overshoot and human notes; query reads it back; rebuild deletes and refolds', async () => {
  const ws = workspace('kb');
  fs.mkdirSync(ws.runsDir, { recursive: true });
  syntheticRun(ws.runsDir, 'run_a', {
    idea: 'a race against the tide',
    findings: [
      row('run_a', { rubricId: 'take.force-seen', ruleId: 'SCR-013', shotId: 's1' }),
      row('run_a', { rubricId: 'take.force-seen', ruleId: 'SCR-013', shotId: 's2' }),
      row('run_a', { family: 'gate', stage: 'measure', severity: 'blocker', code: 'E-MEASURE-CIN-007', ruleId: 'CIN-007', shotId: 's2', cost: 6 }),
    ],
    joins: [{ from: 's1', to: 's2', distance: 30, joinType: 'cut' }],
    notes: [{ id: 'n1', at: 'x', disposition: 'pending', text: 'no pressure in the frame', shotRef: 's1', severity: 'blocker', author: 'human' }, { id: 'n2', at: 'x', disposition: 'pending', text: 'fine', shotRef: 's2', severity: 'taste', author: 'human' }],
  });
  syntheticRun(ws.runsDir, 'run_b', {
    idea: 'a locked door at dusk',
    findings: [
      row('run_b', { rubricId: 'take.force-seen', ruleId: 'SCR-013', shotId: 's1' }),
      row('run_b', { family: 'gate', stage: 'measure', severity: 'blocker', code: 'E-MEASURE-CIN-007', ruleId: 'CIN-007', shotId: 's1', cost: 5 }),
    ],
    joins: [{ from: 's1', to: 's2', distance: 2, joinType: 'continuous' }],
    notes: [{ id: 'n3', at: 'x', disposition: 'pending', text: 'the door reads', shotRef: 's1', severity: 'note', author: 'human' }],
  });
  const policy = { ...POLICY, learn: { minRuns: 2, minIdeas: 2 }, judge: { ...POLICY.judge, minInstances: 3, minPrecision: 0.6 } };
  const { rulebook } = loadLaw(RULES_DIR);
  const audited = [];
  const audit = (index) => { audited.push(index); return knowledgePolicyGates({ rulebook, policy, index }); };
  await assert.rejects(() => foldKnowledge({ runsDir: ws.runsDir, knowledgeDir: ws.knowledgeDir, policy: null, audit, reason: 'test' }), /E-KB-POLICY/, 'a fold without policy values refuses by name');
  await assert.rejects(() => foldKnowledge({ runsDir: ws.runsDir, knowledgeDir: ws.knowledgeDir, policy, reason: 'test' }), /E-KB-AUDIT/, 'a fold without the knowledge audit refuses by name');
  await assert.rejects(() => foldKnowledge({ runsDir: ws.runsDir, knowledgeDir: ws.knowledgeDir, policy, audit: () => [], reason: 'test' }), /E-KB-AUDIT/, 'an audit that ran no rule refuses by name');
  assert.ok(!fs.existsSync(ws.knowledgeDir), 'a refused fold writes nothing');
  const { index, path: file, fold } = await foldKnowledge({ runsDir: ws.runsDir, knowledgeDir: ws.knowledgeDir, policy, audit, reason: 'test' });
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fold, { ...fold, runs: 2, findings: 5, signatures: 2, policyId: policy.id });
  assert.equal(audited.length, 1, 'the audit ran once over the folded index');
  assert.deepEqual(audited[0].recurrence, index.recurrence);
  assert.deepEqual(fold.audit.rules.map((r) => r.ruleId), ['POL-009', 'POL-010'], 'every fold records the knowledge audit');
  assert.ok(fold.audit.rules.every((r) => r.pass === true), JSON.stringify(fold.audit));
  assert.equal(fold.audit.blockers, 0);
  assert.deepEqual(index.counts.byCode, { 'E-RUBRIC-FAIL': 3, 'E-MEASURE-CIN-007': 2 });
  assert.deepEqual(index.counts.byFamily, { qc: 3, gate: 2 });
  const rubric = index.recurrence.find((r) => r.code === 'E-RUBRIC-FAIL');
  assert.equal(rubric.signature, signatureOf({ family: 'qc', stage: 'qc', code: 'E-RUBRIC-FAIL', ruleId: 'SCR-013' }));
  assert.deepEqual({ count: rubric.count, runs: rubric.runs, ideas: rubric.ideas, propose: rubric.propose }, { count: 3, runs: 2, ideas: 2, propose: true });
  const measure = index.recurrence.find((r) => r.code === 'E-MEASURE-CIN-007');
  assert.equal(measure.cost, 11);
  assert.deepEqual(index.calibration.joins.cut.distances, [30]);
  assert.deepEqual(index.calibration.joins.continuous.distances, [2]);
  assert.deepEqual(index.calibration.overshoot['5'], { n: 2, min: 0.04, max: 0.04, mean: 0.04, values: [0.04, 0.04] });
  assert.deepEqual(index.calibration.overshoot['6'], { n: 2, min: 0.1, max: 0.1, mean: 0.1, values: [0.1, 0.1] });
  const judge = index.calibration.judge.find((j) => j.rubricId === 'take.force-seen');
  assert.deepEqual({ instances: judge.instances, agreements: judge.agreements, precision: judge.precision, promote: judge.promote }, { instances: 3, agreements: 2, precision: 0.667, promote: true });
  assert.deepEqual(index.runs.map((r) => r.runId), ['run_a', 'run_b']);

  const q = queryKnowledge({ knowledgeDir: ws.knowledgeDir, runsDir: ws.runsDir, term: 'CIN-007' });
  assert.equal(q.recurrence.length, 1);
  assert.equal(q.rows.length, 2);
  assert.deepEqual(q.rows.map((r) => r.runId), ['run_a', 'run_b']);

  await assert.rejects(() => rebuildKnowledge({ runsDir: ws.runsDir, knowledgeDir: ws.knowledgeDir, policy: null, audit }), /E-KB-POLICY/);
  await assert.rejects(() => rebuildKnowledge({ runsDir: ws.runsDir, knowledgeDir: ws.knowledgeDir, policy }), /E-KB-AUDIT/);
  assert.ok(fs.existsSync(file), 'a refused rebuild deletes nothing');
  const rebuilt = await rebuildKnowledge({ runsDir: ws.runsDir, knowledgeDir: ws.knowledgeDir, policy, audit });
  assert.equal(rebuilt.deleted, true);
  assert.equal(rebuilt.index.recurrence[0].propose, true, 'a rebuild decides under the same policy');
  const folds = fs.readFileSync(path.join(ws.knowledgeDir, 'folds.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(folds.length, 2);
  assert.ok(folds.every((f) => f.policyId === policy.id && f.audit.rules.length === 2), 'every fold row carries its policy and its audit');

  const root = fresh('kb-main');
  fs.cpSync(RULES_DIR, path.join(root, 'rules'), { recursive: true });
  fs.cpSync(ws.runsDir, path.join(root, 'runs'), { recursive: true });
  const policyFile = writeJson(root, 'policy.json', policy);
  const printed = [];
  const out = (line) => printed.push(line);
  await assert.rejects(() => main(['kb', 'fold'], { cwd: root, out }), /E-ARGS-MISSING-POLICY/, 'bravo kb fold needs --policy');
  await assert.rejects(() => main(['kb', 'rebuild'], { cwd: root, out }), /E-ARGS-MISSING-POLICY/, 'bravo kb rebuild needs --policy');
  await assert.rejects(() => main(['kb', 'query', 'CIN-007', '--policy', policyFile], { cwd: root, out }), /E-ARGS/, 'bravo kb query takes no policy');
  assert.ok(!fs.existsSync(path.join(root, 'knowledge')), 'a refused command folds nothing');
  assert.equal(await main(['kb', 'fold', '--policy', policyFile], { cwd: root, out }), 0);
  assert.equal(await main(['kb', 'rebuild', '--policy', policyFile], { cwd: root, out }), 0);
  const rows = printed.map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.audit.rules.map((x) => x.ruleId)), [['POL-009', 'POL-010'], ['POL-009', 'POL-010']], 'the CLI fold and rebuild run the knowledge audit');
  assert.equal(rows[1].deleted, true);
  const cliFolds = fs.readFileSync(path.join(root, 'knowledge', 'folds.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(cliFolds.map((f) => [f.reason, f.policyId, f.audit.blockers]), [['bravo kb fold', policy.id, 0], ['rebuild (previous index deleted)', policy.id, 0]]);
});

test('resume re-enters a halted pass: done nodes with media are kept, missing evidence is restored from the store, a plate the store has lost is dropped with everything that descended from it, and a completed run refuses a second resume', async () => {
  const ws = workspace('resume');
  const wire = makeWire({ failMeasure: '/api/film/media?key=task2.mp4' });
  const client = scriptedClient();
  const { stages } = stubStages();
  const halted = await film({ ws, wire, client, stages, runId: 'run_halt', over: { policy: { ...POLICY, attempts: { ...POLICY.attempts, fault: 1 } } } });
  assert.equal(halted.status, 'halted', JSON.stringify(halted));
  const dir = path.join(ws.runsDir, 'run_halt');
  let entries = await journalOf(dir);
  const halt = entries.find((e) => e.kind === 'pass.halted');
  assert.ok(halt && /ffprobe crashed/.test(halt.data.reason), 'the halt names the fault');
  assert.ok(entries.some((e) => e.kind === 'fault'));
  assert.equal(entries.find((e) => e.kind === 'complete').data.status, 'halted');
  const project = await loadProjectFs(dir);
  assert.equal(project.sequences[0].status, 'halted');
  const animateBefore = wire.calls.animate.length;
  const doneShoots = Object.entries(project.sequences[0].run.nodes).filter(([id, n]) => id.startsWith('shoot:') && n.status === 'done').map(([id]) => id);
  assert.ok(doneShoots.length > 0, 'some takes finished before the halt');

  const restorable = doneShoots[0].slice('shoot:'.length);
  const restorableFile = path.join(dir, 'media', `shoot-${restorable}-attempt1.mp4`);
  assert.ok(fs.existsSync(restorableFile));
  fs.rmSync(restorableFile);
  const quayUrl = project.sequences[0].run.nodes['plate:THE-QUAY'].value.url;
  fs.rmSync(path.join(dir, 'media', 'plate-THE_QUAY.png'));
  wire.state.lost.add(quayUrl.split('key=')[1]);
  wire.state.failMeasure = null;
  wire.install();
  let resumed;
  try {
    resumed = await resumeRun({ ...ws, rulesDir: RULES_DIR, runId: 'run_halt', client, stages, server: 'stub' });
  } finally {
    wire.restore();
  }
  assert.equal(resumed.status, 'complete', JSON.stringify(resumed));
  entries = await journalOf(dir);
  const resume = entries.find((e) => e.kind === 'resume').data;
  assert.deepEqual(resume.restored.map((r) => r.id), [doneShoots[0]], 'a take whose evidence copy is missing is restored from the durable store, never re-rendered');
  assert.ok(fs.existsSync(restorableFile), 'the evidence copy is back on disk');
  assert.deepEqual(resume.dropped.map((d) => d.id), ['plate:THE-QUAY'], 'a plate the store has lost is dropped');
  assert.ok(entries.some((e) => e.kind === 'resume.media' && e.data.id === 'plate:THE-QUAY' && e.data.restored === false), 'the failed restore is journaled');
  for (const id of doneShoots) assert.ok(resume.cascaded.some((c) => c.id === id && c.why === 'plate:THE-QUAY'), `${id} descended from the dropped plate and is reset with it`);
  assert.ok(resume.kept.includes('plate:FIGURE-1') && resume.kept.includes('shots'));
  assert.ok(!resume.kept.some((id) => id.startsWith('shoot:') || id.startsWith('keyframe:')), 'nothing downstream of a lost plate is kept');
  assert.ok(resume.inflight.some((n) => n.status === 'halted' && n.id === halt.data.node), 'the halted node re-enters as pending');
  assert.ok(Array.isArray(resume.faultsCleared));
  assert.equal(resume.orphans.length, 0);
  assert.equal(entries.filter((e) => e.kind === 'cost' && e.data.code === 'E-WASTE-RESUME-DROPPED').length, doneShoots.length, 'every take the cascade threw away is counted as coded waste');
  assert.equal(wire.calls.imagine.length, 3, 'only the dropped plate was re-rendered');
  assert.equal(wire.calls.animate.length, animateBefore + 20, 'every shot is re-shot from the re-rendered plate');
  const after = await loadProjectFs(dir);
  assert.equal(after.sequences[0].status, 'assembled');
  assert.equal(after.sequences[0].iterations.length, 2, 'the halt and the completion are both iterations, append-only');
  assert.ok(fs.existsSync(path.join(dir, 'media', entries.filter((e) => e.kind === 'assemble').at(-1).data.media)));
  assert.ok(fs.existsSync(path.join(dir, 'media', `shoot-${restorable}-attempt2.mp4`)), 'the re-shot take keeps its own attempt number beside the restored one');
  assert.ok(entries.filter((e) => e.kind === 'complete').at(-1).data.status === 'complete');
  await assert.rejects(() => resumeRun({ ...ws, rulesDir: RULES_DIR, runId: 'run_halt', client, stages, server: 'stub' }), /E-RESUME-COMPLETE/);
  entries = await journalOf(dir);
  assert.ok(entries.some((e) => e.kind === 'resume.refused' && e.data.code === 'E-RESUME-COMPLETE'));
});

test('replay --dry re-runs a pass from its own journal: every answer comes from the source, nothing leaves the process, and the replay completes into its own run directory', async () => {
  assert.ok(passed.full, 'the full pass ran');
  const { ws, wire } = passed.full;
  const skillsDir = skillsFixture();
  const fetchBefore = globalThis.fetch;
  const mediaBefore = wire.calls.media.length;
  await assert.rejects(() => replayRun({ ...ws, rulesDir: RULES_DIR, skillsDir, runId: 'run_full', dry: false }), /E-REPLAY-DRY/);
  const out = await replayRun({ ...ws, rulesDir: RULES_DIR, skillsDir, runId: 'run_full', dry: true });
  assert.equal(globalThis.fetch, fetchBefore, 'the replay puts fetch back');
  assert.equal(out.status, 'complete', JSON.stringify(out));
  assert.equal(out.replayOf, 'run_full');
  assert.equal(out.runId, 'run_full-replay-1');
  assert.equal(wire.calls.media.length, mediaBefore, 'the stubbed wire of the source pass was never touched');
  const entries = await journalOf(path.join(ws.runsDir, 'run_full-replay-1'));
  const intakeRec = entries.find((e) => e.kind === 'intake').data;
  assert.equal(intakeRec.ideaSource, 'replay of run_full');
  assert.equal(intakeRec.styleFrom, 'journal run_full');
  assert.equal(entries.filter((e) => e.kind === 'intent' && e.data.call === 'startVideo').length, 20);
  assert.ok(entries.filter((e) => e.kind === 'candidate').every((e) => e.data.replayed === true));
  assert.ok(fs.existsSync(path.join(ws.runsDir, 'run_full-replay-1', 'media', entries.find((e) => e.kind === 'assemble').data.media)));
  assert.ok(fs.existsSync(path.join(ws.runsDir, 'run_full-replay-1', 'report.md')));
});

test('judge skips the joins on either side of a still held under the ceiling: no judge call, a join.skipped step, the joins row and the report name them', async () => {
  assert.ok(passed.full, 'the full pass ran');
  const { ws, wire } = passed.full;
  const dir = path.join(ws.runsDir, 'run_held');
  fs.cpSync(path.join(ws.runsDir, 'run_full'), dir, { recursive: true });
  const project = await loadProjectFs(dir);
  const nodes = project.sequences[0].run.nodes;
  const shootValue = nodes['shoot:s4'].value;
  nodes['shoot:s4'].value = { ...shootValue, taskId: null, takeId: null, reservationId: null, lastFrameUrl: shootValue.url, held: { seconds: 5 }, ceiling: { refused: 'E-BUDGET-MAXWALLMINUTES', decision: 'still-hold' } };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  const client = scriptedClient();
  const { calls, stages } = stubStages();
  wire.install();
  let out;
  try {
    out = await judgeRun({ ...ws, rulesDir: RULES_DIR, runId: 'run_held', client, stages, server: 'stub' });
  } finally {
    wire.restore();
  }
  assert.equal(out.status, 'judged', JSON.stringify(out));
  assert.equal(calls.join.length, 17, 'the two joins touching the held still are never judged');
  assert.ok(!calls.join.some((j) => j.joinRef.includes('s4')));
  const entries = await journalOf(dir);
  const skipped = entries.filter((e) => e.kind === 'join.skipped' && e.step > entries.find((e2) => e2.kind === 'judge.start').step).map((e) => e.data);
  assert.deepEqual(skipped, [{ joinRef: 's3->s4', reason: 'still-hold', held: { s4: { seconds: 5 } } }, { joinRef: 's4->s5', reason: 'still-hold', held: { s4: { seconds: 5 } } }]);
  assert.ok(!entries.some((e) => e.kind === 'finding' && e.data.code === 'E-JOINQC-FAULT'), 'a held still is not a join fault');
  const judged = entries.filter((e) => e.kind === 'judge').at(-1).data;
  assert.equal(judged.joins.length, 19);
  assert.deepEqual(judged.joins.filter((j) => j.skipped).map((j) => j.joinRef), ['s3->s4', 's4->s5']);
  const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(report, /2 join\(s\) unjudged under still-hold: s3->s4, s4->s5/);
});

test('the pass journal adapter stamps runId at the pass level, answers intents by ticket, and refuses object evidence and a cause column instead of repairing them', async () => {
  const dir = fresh('adapter');
  const raw = await openJournal({ dir });
  const j = passJournal(raw, { runId: 'run_x' });
  const ticket = j.intent('render.start', { shotId: 's1' });
  j.result(ticket, { taskId: 't1' });
  j.finding({ finding_id: 'f1', at: new Date().toISOString(), family: 'qc', stage: 'qc', severity: 'note', code: 'E-RUBRIC-FAIL', detail: 'd', evidence: [{ label: 'x' }] });
  j.cost({ nodeId: 'shoot:s2', kind: 'take', units: 1, disposition: 'wasted', code: 'E-WASTE-INVALIDATED-SUCCESSOR', takeId: 'tk', detail: 'shot s1 regenerated' });
  assert.throws(() => j.finding({ family: 'qc' }), /journal.finding refuses/);
  assert.throws(() => j.finding({ finding_id: 'f2', at: new Date().toISOString(), family: 'qc', stage: 'qc', severity: 'note', code: 'E-RUBRIC-FAIL', detail: 'd', evidence: { label: 'x' } }), /evidence must be an array/);
  assert.throws(() => j.cost({ nodeId: 'shoot:s2', kind: 'take', units: 1, disposition: 'wasted', code: 'E-WASTE-INVALIDATED-SUCCESSOR', takeId: 'tk', cause: 'shot s1 regenerated' }), /cause is not a column/);
  const failures = await j.drain();
  assert.equal(failures.length, 0);
  const entries = j.entries();
  assert.deepEqual(entries.map((e) => e.kind).sort(), ['cost', 'finding', 'intent', 'result']);
  const intent = entries.find((e) => e.kind === 'intent');
  const result = entries.find((e) => e.kind === 'result');
  assert.equal(result.data.intentId, intent.data.intentId);
  assert.ok(result.step > intent.step, 'the result answers its intent after it');
  const finding = entries.find((e) => e.kind === 'finding');
  assert.equal(finding.data.runId, 'run_x');
  assert.deepEqual(finding.data.evidence, [{ label: 'x' }]);
  const cost = entries.find((e) => e.kind === 'cost');
  assert.equal(cost.data.detail, 'shot s1 regenerated');
  assert.equal('cause' in cost.data, false);
  await j.close();
  const errors = fs.readFileSync(path.join(dir, 'errors.ndjson'), 'utf8').trim().split('\n');
  assert.equal(errors.length, 1);
  assert.equal(JSON.parse(errors[0]).runId, 'run_x');
});

test('intake is a pure function of its inputs and the server: the same inputs journal the same hashes', async () => {
  const dir = fresh('intake-pure');
  const wire = makeWire();
  wire.install();
  try {
    const raw = await openJournal({ dir });
    const j = passJournal(raw, { runId: 'run_p' });
    const a = await intake({ journal: j, runId: 'run_p', idea: 'x', ideaSource: 'argument', seconds: 100, ...inputs(), rulesDir: RULES_DIR, server: 'stub' });
    const b = await intake({ journal: j, runId: 'run_p', idea: 'x', ideaSource: 'argument', seconds: 100, ...inputs(), rulesDir: RULES_DIR, server: 'stub' });
    assert.equal(a.styleHash, b.styleHash);
    assert.equal(a.policyHash, b.policyHash);
    assert.equal(a.rulebookVersion, b.rulebookVersion);
    assert.equal(a.rubricsVersion, b.rubricsVersion);
    assert.ok(a.rulebook.ruleById('POL-000') && a.rubrics.forSet('take').length > 0);
    await j.drain();
    await j.close();
  } finally {
    wire.restore();
  }
});
