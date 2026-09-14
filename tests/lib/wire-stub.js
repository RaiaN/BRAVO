import fs from 'node:fs';
import path from 'node:path';
import { journaledClient, openJournal } from '../../agents/journal.js';
import { passJournal as pinRunId } from '../../cli/bravo.js';
import { CHECKS } from '../../agents/director/gates.js';
import { loadRulebook } from '../../agents/director/rulebook.js';
import { loadRubrics, readRubricBooks } from '../../agents/director/rubrics.js';
import { POLICY_CHECKS, approveManifest, makeLedger, makeReserve, runPolicyGate } from '../../agents/director/policy.js';
import { ideate } from '../../agents/director/ideate.js';
import { generateCandidates, scoreCandidate, selectCandidate } from '../../agents/director/candidates.js';
import { plateQC, takeQC, filmQC } from '../../agents/director/qc.js';
import { brief as briefTool, screenplay as screenplayTool, breakdown as breakdownTool } from '../../agents/tools/director.js';
import { manifestOf, fnv1a, runSequence } from '../../agents/director/execute.js';
import { requireSkillLine } from '../../utils/film/skills.js';
import {
  appendMessage, latchThread, makeProject, makeSequence, sequenceById, setLook, setSequenceFields, touch,
} from '../../state/project.js';

const round3 = (v) => Math.round(v * 1000) / 1000;

export const hashAt = (n) => `${'1'.repeat(n)}${'0'.repeat(64 - n)}`;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const withIteration = (book) => ({
  ...book,
  rules: book.rules.map((r) => (r.provenance?.origin === 'note' && !r.provenance.iteration ? { ...r, provenance: { ...r.provenance, iteration: 'creator-decree-2026-08-31' } } : r)),
});

export const RULES = () => ({
  cinematic: withIteration(readJson('rules/cinematic.json')),
  screenwriting: withIteration(readJson('rules/screenwriting.json')),
  metrics: readJson('rules/metrics.json'),
});

export const POLICY_BOOK = () => readJson('rules/policy.json');
export const POLICY = () => readJson('policy/default.json');
export const STYLE = () => readJson('looks/default.json');

export const SKILLS = () => ({
  skills: [
    { id: 'sd25-pe', name: 'Seedance 2.5 spec', description: '', models: ['seedance25'], text: 'Write one paragraph that states the world, the subject and the moment.' },
    { id: 'plate-pe', name: 'Plate spec', description: '', models: ['seedreamPro', 'seedream'], text: 'Write one paragraph that describes the subject on a neutral background.' },
  ],
});

export const readNdjson = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []);

export const passJournal = async ({ dir, runId }) => {
  if (typeof dir !== 'string' || !dir) throw new Error('passJournal needs a "dir"');
  if (typeof runId !== 'string' || !runId) throw new Error('passJournal needs a "runId"');
  const raw = await openJournal({ dir });
  const journal = pinRunId(raw, { runId });
  const openIntents = () => {
    const answered = new Set(raw.entries('result').map((r) => r.data.intentId));
    return raw.entries('intent').map((r) => r.data.intentId).filter((id) => !answered.has(id));
  };
  const settle = async () => {
    const failures = await journal.drain();
    if (failures.length) throw failures[0];
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await journal.close();
  };
  return {
    ...journal,
    runId,
    settle,
    close,
    openIntents,
    errors: () => readNdjson(raw.paths.errors),
    costs: () => readNdjson(raw.paths.cost),
  };
};

const SETUPS = ['Medium Shot', 'Close-Up', 'Full Shot', 'Two Shot', 'Over-the-Shoulder', 'Low Angle'];

const between = (text, from, to) => {
  const a = text.indexOf(from);
  if (a < 0) throw new Error(`the seed reasoner cannot find "${from}" in the prompt`);
  const start = a + from.length;
  const b = to ? text.indexOf(to, start) : -1;
  return text.slice(start, b < 0 ? undefined : b);
};

export const worldOf = (over = {}) => ({
  cast: ['FIGURE-1', 'FIGURE-2'],
  locations: ['PLACE-1'],
  protagonist: 'FIGURE-1',
  want: 'reach the door before the tide',
  opposition: 'the tide rising across the stone',
  joinOf: (i) => ((i - 1) % 4 === 0 ? 'cut' : 'continuous'),
  subjectOf: () => 'FIGURE-1',
  forceOf: () => 'the tide climbs the steps, seen as water crossing the frame',
  ...over,
});

const PASS_NO = ['take.garbled-writing', 'take.stillness-seen', 'take.black-seen'];

export const seedReasoner = ({ wire, world = worldOf() }) => async ({ prompt, systemPrompt, images = [] }) => {
  const call = { prompt, systemPrompt, images };
  wire.calls.reason.push(call);
  const system = String(systemPrompt || '');

  if (/^You derive the complete brief/.test(system)) {
    const proposal = {
      logline: { value: 'A figure races the rising tide to a locked door.', reason: 'the idea names a race against a rising force' },
      world: { value: 'a stone quay at the turn of the tide', reason: 'the style leaves the world to the idea' },
      cast: world.cast.map((name, i) => ({ name, role: 'character', reason: `the idea needs figure ${['one', 'two', 'three', 'four'][i] || i + 1} on screen` })),
      locations: world.locations.map((name) => ({ name, reason: 'the tide needs a shore' })),
      dramatis: { protagonist: world.protagonist, want: world.want, opposition: world.opposition, reason: 'the want and the opposition come from the idea' },
    };
    return { content: JSON.stringify(proposal) };
  }

  if (/^You write the screenplay/.test(system)) {
    const ks = between(system, 'so produce ', ' beats').split(' or ').map(Number);
    const k = ks[0];
    const cast = world.cast.join(' and ');
    const scene = (id, time, turn) => ({
      id,
      slug: { intExt: 'EXT', location: world.locations[0], time },
      action: [`${cast} stand on ${world.locations[0]} as ${world.opposition}.`, `${world.protagonist} pushes toward the door while ${world.opposition}.`],
      dialogue: [],
      turn,
      side: 'L',
      antagonism: true,
    });
    const screenplay = {
      scenes: [scene('1', 'DAY', { from: 'dry', to: 'wet' }), scene('2', 'DUSK', { from: 'shut', to: 'open' })],
      beats: Array.from({ length: k }, (_, i) => ({ id: `b${i + 1}`, text: `beat ${['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][i % 10]} of the race turns the water higher` })),
    };
    return { content: JSON.stringify(screenplay) };
  }

  if (/^You break a screenplay/.test(system)) {
    const partition = between(system, 'nothing else sums correctly: ', '\n').split(',').map((x) => Number(x.trim()));
    const beats = JSON.parse(between(prompt, 'THE BEATS:\n', '\n\nTHE SCREENPLAY:'));
    const half = Math.ceil(beats.length / 2);
    const shots = beats.map((b, idx) => {
      const i = idx + 1;
      return {
        id: `s${i}`,
        sceneId: i <= half ? '1' : '2',
        beatId: b.id,
        subject: world.subjectOf(i),
        force: world.forceOf(i),
        change: 'dry stone -> wet stone',
        setup: i === 1 ? 'Wide Establisher' : SETUPS[i % SETUPS.length],
        side: 'L',
        seconds: partition[idx],
        location: world.locations[0],
        ...(i > 1 ? { join: world.joinOf(i) } : {}),
        moment: `[s${i}] the water reaches one step higher and the figure answers it`,
        dialogue: [],
      };
    });
    return { content: JSON.stringify({ shots }) };
  }

  if (system.includes('Write the FINAL PROMPT for this reference PLATE')) {
    const title = between(prompt, 'THE SHOT: ', '\n');
    return { content: `A neutral studio plate of ${title}, full figure, plain grey backdrop, even light.` };
  }

  if (system.includes('Write the FINAL PROMPT for this shot')) {
    const title = between(prompt, 'THE SHOT: ', '\n');
    const tag = title.match(/\[(s\d+)\]/);
    if (!tag) throw new Error(`the seed reasoner needs the shot tag in the title — got ${JSON.stringify(title)}`);
    return { content: `[${tag[1]}] The figure climbs the wet stone as the water crosses the frame and the door stays shut.` };
  }

  if (/^You are the witness judge/.test(system)) {
    const take = wire.takeOfImages(images);
    const behavior = take ? wire.behaviorOf(take.shotId) : {};
    const artifact = take ? behavior.artifact?.[take.attempt - 1] === true : false;
    wire.calls.judge.push({ taskId: take?.taskId || null, shotId: take?.shotId || null, attempt: take?.attempt || null, prompt });
    const fals = [...prompt.matchAll(/^\d+\. \[([^\]]+)\] .* Your answer: (.*)$/gm)];
    if (fals.length) return { content: JSON.stringify({ falsifications: fals.map((m) => ({ id: m[1], seen: true, frame: 0, note: 'seen here' })) }) };
    const qs = [...prompt.matchAll(/^\d+\. \[([^\]]+)\] .* Answer with one of: (.*)$/gm)];
    const answers = qs.map((m) => {
      const id = m[1];
      const base = id.split(':')[0];
      const options = m[2].split(' | ');
      let answer = PASS_NO.includes(base) ? 'no' : options[0];
      if (artifact && base === 'take.anatomy') answer = 'extra limb';
      return { id, answer, frame: 0, note: 'because' };
    });
    return { content: JSON.stringify({ answers }) };
  }

  throw new Error(`the seed reasoner has no answer for this system prompt: ${system.slice(0, 80)}`);
};

export const makePassWire = ({ behaviors = {}, world = worldOf() } = {}) => {
  const calls = { imagine: [], animate: [], polls: [], measure: [], frames: [], stats: [], stitch: [], media: [], reason: [], judge: [], rules: 0, skills: 0 };
  const tasks = new Map();
  const attemptsOf = {};
  const killed = {};
  const clock = { base: Date.now(), offset: 0 };
  const now = () => clock.base + clock.offset;
  const state = { handle: null };
  const real = globalThis.fetch;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const behaviorOf = (shotId) => behaviors[shotId] || {};
  const taskOfUrl = (url) => {
    const m = String(url).match(/key=(task\d+)\.mp4/);
    return m ? tasks.get(m[1]) || null : null;
  };
  const takeOfImages = (images) => {
    for (const u of images) {
      const t = taskOfUrl(u);
      if (t) return t;
    }
    return null;
  };
  const stillOfUrl = (url) => {
    const m = String(url).match(/key=still(\d+)\.png/);
    return m ? Number(m[1]) : null;
  };

  const stub = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes('/api/rules')) { calls.rules += 1; return json(RULES()); }
    if (u.includes('/api/film/skills')) { calls.skills += 1; return json(SKILLS()); }
    if (u.includes('/api/film/imagine')) {
      calls.imagine.push(body);
      const n = calls.imagine.length;
      return json({ url: `https://x.test/still${n}.png`, cacheUrl: `/api/film/media?key=still${n}.png`, assetId: `asset-${n}` });
    }
    if (u.includes('/api/seedance-status')) {
      const id = new URL(u, 'http://t').searchParams.get('taskId');
      if (!tasks.has(id)) throw new Error(`the pass wire has no task "${id}" to poll`);
      calls.polls.push(id);
      return json({ status: 'succeeded', video_url: `https://x.test/${id}.mp4`, video_cache_url: `/api/film/media?key=${id}.mp4`, last_frame_url: `https://x.test/${id}.jpg`, last_frame_cache_url: `/api/film/media?key=${id}.jpg` });
    }
    if (u.includes('/api/seedance')) {
      const text = body.content?.[0]?.text || '';
      const tag = text.match(/\[(s\d+)\]/);
      if (!tag) throw new Error(`the pass wire maps a take to its shot by the [sN] tag in its prompt — got ${JSON.stringify(text.slice(0, 60))}`);
      const shotId = tag[1];
      attemptsOf[shotId] = (attemptsOf[shotId] || 0) + 1;
      const taskId = `task${tasks.size + 1}`;
      const first = body.content.find((c) => c.role === 'first_frame')?.image_url?.url || null;
      const refs = body.content.filter((c) => c.role === 'reference_image').map((c) => c.image_url?.url || c.asset_id);
      const b = behaviorOf(shotId);
      const attempt = attemptsOf[shotId];
      const info = {
        taskId, shotId, attempt, seconds: body.duration, prompt: text, firstFrameUrl: first, references: refs,
        duration: round3(body.duration + (b.overshoot?.[attempt - 1] ?? 0.04)),
        fps: b.fps?.[attempt - 1] ?? 24,
        frozen: b.frozen?.[attempt - 1] === true,
        black: b.black?.[attempt - 1] === true,
      };
      tasks.set(taskId, info);
      calls.animate.push({ ...body, taskId, shotId, attempt });
      return json({ id: taskId });
    }
    if (u.includes('/api/film/measure')) {
      calls.measure.push(body);
      const t = taskOfUrl(body.url);
      if (t) {
        const n = Number(t.taskId.slice(4));
        return json({ duration: t.duration, nbReadFrames: Math.round(t.duration * 24), fps: t.fps, width: 1280, height: 720, hasAudio: true, firstHash: hashAt((n * 3) % 64), lastHash: hashAt((n * 3 + 1) % 64) });
      }
      const m = String(body.url).match(/key=slice(\d+)\.mp4/);
      if (!m) throw new Error(`the pass wire cannot measure ${JSON.stringify(body.url)}`);
      const stitched = calls.stitch[Number(m[1]) - 1];
      const total = round3(stitched.shots.reduce((sum, s) => {
        if (s && typeof s === 'object' && typeof s.seconds === 'number') return sum + s.seconds;
        const tk = taskOfUrl(s);
        if (!tk) throw new Error(`the stitched slice names ${JSON.stringify(s)}, which is neither a take the wire rendered nor a held still { url, seconds }`);
        return sum + tk.duration;
      }, 0));
      return json({ duration: total, nbReadFrames: Math.round(total * 24), fps: 24, width: 1280, height: 720, hasAudio: true, firstHash: hashAt(1), lastHash: hashAt(2) });
    }
    if (u.includes('/api/film/frames')) {
      calls.frames.push(body);
      return json({ frames: body.timestamps.map((t) => ({ t, url: `frame:${body.url}@${t}` })) });
    }
    if (u.includes('/api/film/image-stats')) {
      calls.stats.push(body.url);
      const frame = String(body.url).match(/^frame:(.*)@([\d.]+)$/);
      if (frame) {
        const t = taskOfUrl(frame[1]);
        const at = Number(frame[2]);
        const dhash = t && t.frozen ? hashAt(3) : hashAt(Math.round(at * 8) % 64);
        return json({ width: 1280, height: 720, meanLuma: t && t.black ? 4 : 120, blur: 40, dhash });
      }
      const still = stillOfUrl(body.url);
      if (still === null) throw new Error(`the pass wire has no image stats for ${JSON.stringify(body.url)}`);
      return json({ width: 2560, height: 1440, meanLuma: 120, blur: 40, dhash: hashAt((still * 7) % 64) });
    }
    if (u.includes('/api/film/stitch')) {
      calls.stitch.push(body);
      const n = calls.stitch.length;
      return json({ url: `https://x.test/slice${n}.mp4`, cacheUrl: `/api/film/media?key=slice${n}.mp4` });
    }
    if (u.includes('/api/film/media?key=')) {
      calls.media.push(u);
      return new Response(new Uint8Array([0x42, 0x52, 0x41, 0x56, 0x4f]), { status: 200 });
    }
    throw new Error(`the pass wire has no route for ${u} — a full pass on the stub never reaches the network`);
  };

  const pollGate = async (taskId) => {
    const t = tasks.get(taskId);
    if (!t) throw new Error(`the pass wire has no task "${taskId}" to poll`);
    const b = behaviorOf(t.shotId);
    if (b.holdUntil !== undefined) {
      if (typeof b.holdUntil !== 'function') throw new Error(`behavior holdUntil for ${t.shotId} must be a predicate over the wire's calls and the pass handle`);
      while (!b.holdUntil(calls, state.handle)) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const advance = b.advanceMs?.[t.attempt - 1] || 0;
    if (advance) clock.offset += advance;
    const wanted = b.killPoll || 0;
    const done = killed[taskId] || 0;
    if (done < wanted) {
      killed[taskId] = done + 1;
      throw new Error(`the process was killed while polling ${taskId}`);
    }
  };

  return {
    calls, tasks, behaviors, world, behaviorOf, taskOfUrl, takeOfImages, pollGate, now, state,
    attemptsOf: (shotId) => attemptsOf[shotId] || 0,
    install: () => { globalThis.fetch = stub; },
    restore: () => { globalThis.fetch = real; },
  };
};

export const passClient = (wire) => ({
  reason: seedReasoner({ wire, world: wire.world }),
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
    await wire.pollGate(taskId);
    const res = await fetch(`/api/seedance-status?taskId=${taskId}`);
    const d = await res.json();
    return { videoUrl: d.video_url, videoCacheUrl: d.video_cache_url, lastFrameUrl: d.last_frame_url, lastFrameCacheUrl: d.last_frame_cache_url };
  },
});

export const passReserve = ({ policy, journal, ledger, clock }) => {
  const reserve = makeReserve({ policy, journal, ledger, clock });
  const refusals = [];
  const wrapped = (request) => {
    const p = reserve(request);
    p.catch((err) => refusals.push({ code: err.code, message: err.message, request }));
    return p;
  };
  wrapped.refusals = refusals;
  return wrapped;
};

export const passStages = () => ({ plateQC, generateCandidates, scoreCandidate, selectCandidate, takeQC });

export const passRulebook = () => loadRulebook(RULES(), { checks: CHECKS });
export const passPolicyBook = () => loadRulebook({ ...RULES(), policy: POLICY_BOOK() }, { checks: CHECKS, policyChecks: POLICY_CHECKS });
export const passRubrics = () => loadRubrics(passRulebook(), readRubricBooks());

const toolOrRefuse = async (tool, args) => {
  const problem = tool.validate(args.input);
  if (problem) throw new Error(`${tool.name} refused its input: ${problem}`);
  const r = await tool.run(args);
  if (r.output?.kind === 'error') throw new Error(`${tool.name} refused: ${r.output.error}`);
  return r;
};

export const runFullPass = async ({ idea, style = STYLE(), seconds = 100, policy = POLICY(), wire, journal, runId, stages = passStages(), reserve = null, ledger = null }) => {
  for (const [k, v] of Object.entries({ idea, wire, journal, runId })) if (!v) throw new Error(`runFullPass: ${k} is required`);
  if (typeof wire.now !== 'function') throw new Error('runFullPass: the wire must carry the virtual clock the reserve reads');
  const client = journaledClient(journal, passClient(wire));
  const passLedger = ledger || makeLedger({ iterations: 0, startedAt: new Date(wire.now()).toISOString() });
  const reserveFn = reserve || passReserve({ policy, journal, ledger: passLedger, clock: wire.now });
  const rulebook = passRulebook();
  const rubrics = loadRubrics(rulebook, readRubricBooks());
  const policyBook = passPolicyBook();
  const ctx = { client, modelId: null, requireSkillLine, policy, rulebook, journal };

  let project = makeProject(idea);
  project = setLook(project, { style: style.look.style, grade: style.look.grade });
  const seq = makeSequence({ status: 'drafting' });
  project = touch({ ...project, sequences: [seq] });
  const threadId = project.threads[0].id;
  project = latchThread(project, threadId, 'director', { subjectId: seq.id, title: idea }).project;
  const thread = () => project.threads.find((t) => t.id === threadId);

  const ideation = await ideate({ idea, style, seconds, policy, client, journal });
  const briefRun = await toolOrRefuse(briefTool, { input: ideation.brief, project, thread: thread(), ctx });
  project = briefRun.project;
  await journal.write('brief', { provenance: ideation.provenance, output: briefRun.output });
  const screenplayRun = await toolOrRefuse(screenplayTool, { input: {}, project, thread: thread(), ctx });
  project = screenplayRun.project;
  await journal.write('screenplay', { calls: screenplayRun.cost, output: screenplayRun.output });
  const breakdownRun = await toolOrRefuse(breakdownTool, { input: {}, project, thread: thread(), ctx });
  project = breakdownRun.project;
  await journal.write('breakdown', { calls: breakdownRun.cost, output: breakdownRun.output });

  const planned = sequenceById(project, seq.id);
  const manifest = manifestOf(planned, rulebook);
  const spent = { stills: 0, takes: 0, videoSeconds: 0, judgeCalls: 0, usd: 0, iterations: 0 };
  const approval = approveManifest({ manifest, policy, spent });
  const gates = ['POL-002', 'POL-006', 'POL-012'].map((id) => runPolicyGate(policyBook, id, id === 'POL-002' ? { manifest, policy, spent } : { policy, shots: planned.plan.shots }));
  await journal.write('approve', { approval, gates });
  const blockers = gates.flatMap((g) => g.blockers);
  if (!approval.ok || blockers.length) throw new Error(`the pass is refused before any money: ${[...approval.refusals.map((r) => r.detail), ...blockers.map((b) => `[${b.ruleId}] ${b.subject}: ${b.detail}`)].join('; ')}`);

  const manifestHash = fnv1a(JSON.stringify(manifest));
  project = appendMessage(project, threadId, {
    role: 'tool', text: '',
    tool: { name: 'sequence', input: {}, card: { tool: 'sequence', manifest, manifestHash }, output: null, approved: true, cost: 0 },
  });
  const messageId = thread().messages.at(-1).id;
  const pass = { policy, journal, reserve: reserveFn, stages, style, rubrics, rulebook, runId };
  const handle = {
    get project() { return project; },
    seqId: seq.id, threadId, messageId, ledger: passLedger, reserve: reserveFn, client, rubrics, manifest, pass, journal, wire, policy, style,
    seq: () => sequenceById(project, seq.id),
    get: () => project,
    apply: (fn) => { project = fn(project) || project; },
  };
  wire.state.handle = handle;
  handle.status = await drivePass(handle);
  return handle;
};

const drivePass = async (handle) => {
  const { client, threadId, messageId, pass, journal, policy, style, rubrics } = handle;
  await runSequence({ client, threadId, messageId, get: handle.get, apply: handle.apply, pass });
  const q = handle.seq();
  if (q.status !== 'assembled') { await journal.settle(); return q.status; }
  const shots = q.plan.shots.map((sh, i) => ({ ...sh, ...handle.manifest.shots[i] }));
  const film = await filmQC({ slice: { url: q.run.nodes.assemble.value.url }, manifest: { ...handle.manifest, shots }, screenplay: { ...q.screenplay, beats: q.beats }, style, rubrics, policy, client, journal });
  await journal.write('film', { findings: film.findings.map((f) => f.finding_id), calls: film.calls });
  await journal.settle();
  return q.status;
};

export const resumePass = async (handle, { journal = handle.journal } = {}) => {
  const before = handle.seq().run;
  const undone = Object.entries(before.nodes).filter(([, n]) => n.status !== 'done').map(([id, n]) => ({ id, status: n.status, taskId: n.value?.taskId || null }));
  await journal.write('resume', { seqId: handle.seqId, halted: before.halted, undone, openIntents: journal.openIntents() });
  handle.apply((prev) => {
    const q = sequenceById(prev, handle.seqId);
    return setSequenceFields(prev, handle.seqId, { status: 'executing', run: { ...q.run, halted: null } });
  });
  if (journal !== handle.journal) {
    handle.journal = journal;
    handle.client = journaledClient(journal, passClient(handle.wire));
    handle.reserve = passReserve({ policy: handle.policy, journal, ledger: handle.ledger, clock: handle.wire.now });
    handle.pass = { ...handle.pass, journal, reserve: handle.reserve };
  }
  handle.status = await drivePass(handle);
  return handle;
};
