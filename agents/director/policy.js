const fail = (code, what) => {
  const err = new Error(`${code}: ${what}`);
  err.code = code;
  throw err;
};

const builtin = (name) => {
  if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') {
    fail('E-POLICY-RUNTIME', `${name} is a Node builtin: the policy values file is read on the machine that runs the pass`);
  }
  return process.getBuiltinModule(name);
};

const canon = (x) => String(x || '').trim().toUpperCase();

const v = (ruleId, subject, pass, value, threshold, detail) => ({ ruleId, subject, pass, value, threshold, detail: detail || null });

export const RESERVE_KINDS = ['still', 'take', 'judge', 'reason'];
export const REGENERATE_MODES = ['same-keyframe', 'new-candidate'];
export const COMPLETION_DECISIONS = ['promote-best', 'still-hold'];
export const PLANNING_STAGES = ['ideate', 'brief', 'screenplay', 'breakdown'];

const JUDGE_ORDERS = 2;
const JUDGE_OFFSETS = 2;
const JUDGE_FALSIFICATION = 1;
export const JUDGE_PROTOCOL = {
  orders: JUDGE_ORDERS,
  offsets: JUDGE_OFFSETS,
  falsification: JUDGE_FALSIFICATION,
  callsPerItem: { base: JUDGE_ORDERS, max: JUDGE_ORDERS * JUDGE_OFFSETS + JUDGE_FALSIFICATION },
};

const ceiling = { kind: 'ceiling' };
const int = (min) => ({ kind: 'int', min });
const num = (min, max) => ({ kind: 'num', min, max });
const positive = { kind: 'positive' };
const str = { kind: 'string' };
const strings = { kind: 'strings' };
const oneOf = (options) => ({ kind: 'enum', options });
const orderOf = (options) => ({ kind: 'order', options });

export const POLICY_SCHEMA = {
  id: str,
  budget: {
    maxRenders: ceiling,
    maxStills: ceiling,
    maxVideoSeconds: ceiling,
    maxJudgeCalls: ceiling,
    maxUsd: ceiling,
    maxWallMinutes: ceiling,
    maxIterations: ceiling,
  },
  attempts: { plate: int(1), candidate: int(1), shot: int(1), fault: int(1) },
  plates: { max: ceiling },
  candidates: { perShot: int(1), selectionFloor: num(0, 1) },
  shots: { regenerateOrder: orderOf(REGENERATE_MODES) },
  chains: { maxLength: int(1) },
  concurrency: { stills: int(1), chains: int(1), judge: int(1) },
  judge: {
    fps: positive,
    maxFramesPerCall: int(1),
    blindFraction: num(0, 1),
    spendingRubrics: strings,
    minPrecision: num(0, 1),
    minInstances: int(1),
  },
  antagonism: { maxShareWithoutForce: num(0, 1) },
  resume: { backoffMs: int(0) },
  poll: { timeoutMs: int(1), maxMs: int(1) },
  completion: { onExhaustedShot: oneOf(COMPLETION_DECISIONS), onRenderCeiling: oneOf(COMPLETION_DECISIONS) },
  mode: oneOf(['edit', 'staged', 'extend']),
  shots: { min: int(1), max: int(1), secondsMin: int(1), secondsMax: int(1) },
  learn: { minRuns: int(1), minIdeas: int(1) },
};

const isLeaf = (spec) => typeof spec.kind === 'string';

const leafProblem = (spec, value, path) => {
  switch (spec.kind) {
    case 'ceiling':
      return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? null : `${path} is a ceiling: a number >= 0 or null (null declares no ceiling); got ${JSON.stringify(value)}`;
    case 'int':
      return Number.isInteger(value) && value >= spec.min ? null : `${path} must be an integer >= ${spec.min}; got ${JSON.stringify(value)}`;
    case 'num':
      return typeof value === 'number' && Number.isFinite(value) && value >= spec.min && value <= spec.max ? null : `${path} must be a number in [${spec.min}, ${spec.max}]; got ${JSON.stringify(value)}`;
    case 'positive':
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? null : `${path} must be a number > 0; got ${JSON.stringify(value)}`;
    case 'string':
      return typeof value === 'string' && value.trim() ? null : `${path} must be a non-empty string; got ${JSON.stringify(value)}`;
    case 'strings':
      return Array.isArray(value) && value.every((s) => typeof s === 'string' && s.trim()) ? null : `${path} must be a list of non-empty strings; got ${JSON.stringify(value)}`;
    case 'enum':
      return spec.options.includes(value) ? null : `${path} must be one of ${spec.options.join(', ')}; got ${JSON.stringify(value)}`;
    case 'order': {
      const ok = Array.isArray(value) && value.length > 0 && value.every((m) => spec.options.includes(m)) && new Set(value).size === value.length;
      return ok ? null : `${path} must be a non-empty ordering of distinct modes from ${spec.options.join(', ')}; got ${JSON.stringify(value)}`;
    }
    default:
      return fail('E-POLICY-SCHEMA', `unknown spec kind ${spec.kind} at ${path}`);
  }
};

const walk = (spec, value, path, out) => {
  if (isLeaf(spec)) {
    const p = leafProblem(spec, value, path);
    if (p) out.push({ key: path, detail: p });
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    out.push({ key: path, detail: `${path} must be an object with keys ${Object.keys(spec).join(', ')}; got ${JSON.stringify(value)}` });
    return;
  }
  for (const key of Object.keys(spec)) {
    const sub = path ? `${path}.${key}` : key;
    if (!(key in value)) { out.push({ key: sub, detail: `missing key ${sub}` }); continue; }
    walk(spec[key], value[key], sub, out);
  }
  for (const key of Object.keys(value)) {
    const sub = path ? `${path}.${key}` : key;
    if (!(key in spec)) out.push({ key: sub, detail: `unknown key ${sub}` });
  }
};

export const policyProblems = (values) => {
  const out = [];
  walk(POLICY_SCHEMA, values, '', out);
  return out;
};

const canonical = (x) => {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
};

export const hashPolicyValues = (values) => builtin('node:crypto').createHash('sha256').update(canonical(values)).digest('hex');

export const loadPolicyValues = (path) => {
  if (typeof path !== 'string' || !path.trim()) fail('E-POLICY-FILE', 'loadPolicyValues needs the path of the policy values file');
  const fs = builtin('node:fs');
  if (!fs.existsSync(path)) fail('E-POLICY-FILE', `no policy values file at ${path}`);
  let values;
  try {
    values = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    return fail('E-POLICY-FILE', `${path} is not JSON: ${err.message}`);
  }
  const problems = policyProblems(values);
  if (problems.length) fail('E-POLICY-SCHEMA', `${path} refused: ${problems.map((p) => p.detail).join('; ')}`);
  return { values, hash: hashPolicyValues(values) };
};

export const ceilings = (policy) => [
  ...Object.keys(POLICY_SCHEMA.budget).map((k) => [`budget.${k}`, policy.budget[k]]),
  ['plates.max', policy.plates.max],
];

export const budgetCode = (ceilingPath) => `E-BUDGET-${ceilingPath.replace(/^budget\./, '').replace(/\./g, '-').toUpperCase()}`;

const requireNumber = (o, key, where) => {
  if (!o || typeof o !== 'object' || typeof o[key] !== 'number' || !Number.isFinite(o[key])) {
    fail('E-APPROVE-INPUT', `${where}.${key} must be a finite number; got ${JSON.stringify(o?.[key])}`);
  }
  return o[key];
};

export const decideKeyframe = (shot, prevShot) => {
  if (!shot || typeof shot !== 'object' || shot.id === undefined || shot.id === null) fail('E-KEYFRAME-SHOT', 'decideKeyframe needs a shot with an id');
  if (!prevShot) {
    if (shot.join === 'continuous') fail('E-KEYFRAME-JOIN', `shot ${shot.id} is the first shot and declares a continuous join with nothing before it`);
    return { needed: true, reason: `shot ${shot.id} is the first shot: identity and setup are anchored by a keyframe generated from the plates` };
  }
  if (shot.join === 'cut') {
    return { needed: true, reason: `shot ${shot.id} cuts from ${prevShot.id}: the image changes, so identity and setup are anchored by a keyframe generated from the plates` };
  }
  if (shot.join === 'continuous') {
    const drift = ['subject', 'location'].filter((k) => canon(shot[k]) !== canon(prevShot[k]));
    if (drift.length) fail('E-KEYFRAME-CONTINUOUS-MISMATCH', `shot ${shot.id} continues from ${prevShot.id} but its ${drift.join(' and ')} differ — a continuous shot keeps its predecessor's subject and location (SCR-013)`);
    return { needed: false, reason: `shot ${shot.id} continues from ${prevShot.id}: its first frame is the recorded last frame of the previous take, and the wire rejects a keyframe alongside references` };
  }
  return fail('E-KEYFRAME-JOIN', `shot ${shot.id} declares join ${JSON.stringify(shot.join === undefined ? null : shot.join)} — every shot after the first declares cut or continuous`);
};

export const chainsOf = (shots) => {
  if (!Array.isArray(shots)) fail('E-CHAIN-SHOTS', 'chainsOf needs the list of plan shots');
  const chains = [];
  shots.forEach((sh, i) => {
    const kf = decideKeyframe(sh, i ? shots[i - 1] : null);
    if (kf.needed) chains.push({ head: sh.id, shotIds: [sh.id], length: 1 });
    else {
      const cur = chains[chains.length - 1];
      cur.shotIds.push(sh.id);
      cur.length += 1;
    }
  });
  return chains;
};

export const regenerateMode = (policy, n) => {
  if (!Number.isInteger(n) || n < 1) fail('E-REGENERATE-N', `regeneration number must be an integer >= 1; got ${JSON.stringify(n)}`);
  const order = policy.shots.regenerateOrder;
  return order[Math.min(n - 1, order.length - 1)];
};

export const filmSegmentsOf = (shots, { fps, maxFramesPerCall }) => {
  if (!(fps > 0) || !Number.isInteger(maxFramesPerCall) || maxFramesPerCall < 1) fail('E-APPROVE-INPUT', `filmSegmentsOf needs policy.judge.fps > 0 and an integer policy.judge.maxFramesPerCall; got ${JSON.stringify({ fps, maxFramesPerCall })}`);
  let segments = 0;
  let frames = 0;
  for (const sh of shots) {
    const n = Math.ceil(requireNumber(sh, 'seconds', `manifest.shots[${sh.id}]`) * fps);
    if (frames && frames + n > maxFramesPerCall) { segments += 1; frames = 0; }
    frames += n;
  }
  return frames ? segments + 1 : segments;
};

export const approveManifest = ({ manifest, policy, spent }) => {
  if (!manifest || !Array.isArray(manifest.shots) || !Array.isArray(manifest.plates)) fail('E-APPROVE-INPUT', 'approveManifest needs a manifest with shots and plates');
  if (!policy || policyProblems(policy).length) fail('E-APPROVE-INPUT', 'approveManifest needs schema-valid policy values');
  const shots = manifest.shots;
  const a = policy.attempts;
  const K = policy.candidates.perShot;
  const keyframeShots = shots.filter((sh, i) => decideKeyframe(sh, i ? shots[i - 1] : null).needed).length;
  const seconds = shots.reduce((sum, sh) => sum + requireNumber(sh, 'seconds', `manifest.shots[${sh.id}]`), 0);
  const joins = Math.max(0, shots.length - 1);
  const plates = { count: manifest.plates.length, attempts: a.plate, max: manifest.plates.length * a.plate };
  const candidates = { shots: keyframeShots, perShot: K, count: keyframeShots * K, attempts: a.candidate, max: keyframeShots * K * a.candidate };
  const takes = { count: shots.length, attempts: a.shot, max: shots.length * a.shot };
  const stills = { base: plates.count + candidates.count, max: plates.max + candidates.max };
  const renders = { base: stills.base + takes.count, max: stills.max + takes.max };
  const videoSeconds = { base: seconds, max: seconds * a.shot };
  const segments = filmSegmentsOf(shots, policy.judge);
  const judged = {
    plates: { base: plates.count, max: plates.max },
    candidates: { base: candidates.count, max: candidates.max },
    takes: { base: takes.count, max: takes.max },
    joins: { base: joins, max: joins },
    film: { segments, base: segments + 1, max: segments + 1 },
  };
  const per = JUDGE_PROTOCOL.callsPerItem;
  const items = {
    base: Object.values(judged).reduce((sum, j) => sum + j.base, 0),
    max: Object.values(judged).reduce((sum, j) => sum + j.max, 0),
  };
  const judgeCalls = { perItem: per, judged, items, base: items.base * per.base, max: items.max * per.max };
  const already = {
    stills: requireNumber(spent, 'stills', 'spent'),
    takes: requireNumber(spent, 'takes', 'spent'),
    videoSeconds: requireNumber(spent, 'videoSeconds', 'spent'),
    judgeCalls: requireNumber(spent, 'judgeCalls', 'spent'),
    usd: requireNumber(spent, 'usd', 'spent'),
    iterations: requireNumber(spent, 'iterations', 'spent'),
  };
  const needs = [
    ['budget.maxStills', already.stills, stills.max],
    ['budget.maxRenders', already.stills + already.takes, renders.max],
    ['budget.maxVideoSeconds', already.videoSeconds, videoSeconds.max],
    ['budget.maxJudgeCalls', already.judgeCalls, judgeCalls.max],
    ['budget.maxIterations', already.iterations, 1],
    ['plates.max', 0, plates.count],
  ];
  const usdEstimate = manifest.estimate && typeof manifest.estimate.usd === 'number' ? manifest.estimate.usd : null;
  if (policy.budget.maxUsd !== null) {
    if (usdEstimate === null) fail('E-APPROVE-INPUT', 'budget.maxUsd is a number, so the manifest must carry estimate.usd from the dated price file');
    needs.push(['budget.maxUsd', already.usd, usdEstimate]);
  }
  const limits = Object.fromEntries(ceilings(policy));
  const checks = needs.map(([path, spentSoFar, need]) => {
    const limit = limits[path];
    const total = spentSoFar + need;
    const pass = limit === null || total <= limit;
    return { ceiling: path, limit, spent: spentSoFar, need, total, pass };
  });
  const refusals = checks.filter((c) => !c.pass).map((c) => ({
    code: budgetCode(c.ceiling),
    ceiling: c.ceiling,
    limit: c.limit,
    spent: c.spent,
    need: c.need,
    total: c.total,
    detail: `${c.ceiling} is ${c.limit}; ${c.spent} spent + ${c.need} needed = ${c.total}`,
  }));
  return {
    ok: refusals.length === 0,
    arithmetic: {
      plates, candidates, takes, stills, renders, videoSeconds, judgeCalls,
      usd: { ceiling: policy.budget.maxUsd, estimate: usdEstimate },
      wallMinutes: { ceiling: policy.budget.maxWallMinutes, enforcedAt: 'reservation' },
      iterations: { ceiling: policy.budget.maxIterations, before: already.iterations, thisPass: 1 },
      checks,
    },
    refusals,
  };
};

export const makeLedger = ({ iterations, startedAt }) => {
  if (!Number.isInteger(iterations) || iterations < 0) fail('E-LEDGER-ITERATIONS', `makeLedger needs the count of iterations already run; got ${JSON.stringify(iterations)}`);
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) fail('E-LEDGER-STARTED-AT', `makeLedger needs the ISO time the pass began, the origin budget.maxWallMinutes is measured from; got ${JSON.stringify(startedAt)}`);
  return { startedAt, iterations, stills: 0, takes: 0, videoSeconds: 0, judgeCalls: 0, reasonCalls: 0, usd: 0, reservations: [] };
};

const snapshot = (ledger, now) => ({
  stills: ledger.stills,
  takes: ledger.takes,
  renders: ledger.stills + ledger.takes,
  videoSeconds: ledger.videoSeconds,
  judgeCalls: ledger.judgeCalls,
  reasonCalls: ledger.reasonCalls,
  usd: ledger.usd,
  elapsedMinutes: (now - Date.parse(ledger.startedAt)) / 60000,
});

const applyReservation = (s, { kind, units, usd }) => {
  const next = { ...s };
  if (kind === 'still') next.stills += units;
  if (kind === 'take') { next.takes += 1; next.videoSeconds += units; }
  if (kind === 'judge') next.judgeCalls += units;
  if (kind === 'reason') next.reasonCalls += units;
  next.renders = next.stills + next.takes;
  next.usd += usd;
  return next;
};

export const makeReserve = ({ policy, journal, ledger, clock }) => {
  if (!policy || policyProblems(policy).length) fail('E-RESERVE-POLICY', 'makeReserve needs schema-valid policy values');
  if (!journal || typeof journal.write !== 'function') fail('E-RESERVE-JOURNAL', 'makeReserve needs a journal with write(kind, data) — a reservation nobody journals did not happen');
  if (!ledger || !Array.isArray(ledger.reservations) || typeof ledger.startedAt !== 'string') fail('E-RESERVE-LEDGER', 'makeReserve needs a ledger from makeLedger');
  if (typeof clock !== 'function') fail('E-RESERVE-CLOCK', 'makeReserve needs a clock() returning epoch milliseconds — budget.maxWallMinutes is measured against it, never against an implicit system clock');
  const b = policy.budget;
  const refuse = async (code, request, detail, before, after) => {
    await journal.write('reservation.refused', { code, request, detail, before, after });
    return fail(code, detail);
  };
  return async (request) => {
    const { nodeId, kind, units, justification } = request || {};
    const now = clock();
    if (typeof now !== 'number' || !Number.isFinite(now)) fail('E-RESERVE-CLOCK', `the reserve clock returned ${JSON.stringify(now)}, not epoch milliseconds`);
    const before = snapshot(ledger, now);
    if (typeof nodeId !== 'string' || !nodeId.trim()) await refuse('E-RESERVE-NO-NODE', request, 'a reservation names the plan node it serves', before, null);
    if (!RESERVE_KINDS.includes(kind)) await refuse('E-RESERVE-KIND', request, `kind must be one of ${RESERVE_KINDS.join(', ')}; got ${JSON.stringify(kind)}`, before, null);
    if (typeof units !== 'number' || !Number.isFinite(units) || units <= 0) await refuse('E-RESERVE-UNITS', request, `units must be a number > 0; got ${JSON.stringify(units)}`, before, null);
    if (typeof justification !== 'string' || !justification.trim()) await refuse('E-RESERVE-JUSTIFICATION', request, 'a reservation states why the call is made', before, null);
    const usd = 'usd' in request ? request.usd : 0;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) await refuse('E-RESERVE-USD', request, `usd must be a number >= 0 when given; got ${JSON.stringify(usd)}`, before, null);
    if (b.maxUsd !== null && !('usd' in request)) await refuse('E-RESERVE-NO-PRICE', request, 'budget.maxUsd is a number, so every reservation carries its usd from the dated price file', before, null);
    const after = applyReservation(before, { kind, units, usd });
    const crossings = [
      ['budget.maxWallMinutes', before.elapsedMinutes, b.maxWallMinutes],
      ['budget.maxStills', after.stills, b.maxStills],
      ['budget.maxRenders', after.renders, b.maxRenders],
      ['budget.maxVideoSeconds', after.videoSeconds, b.maxVideoSeconds],
      ['budget.maxJudgeCalls', after.judgeCalls, b.maxJudgeCalls],
      ['budget.maxUsd', after.usd, b.maxUsd],
    ];
    for (const [path, total, limit] of crossings) {
      if (limit !== null && total > limit) {
        await refuse(budgetCode(path), request, `${path} is ${limit}; ${kind} ${units} for ${nodeId} would make ${total}`, before, after);
      }
    }
    ledger.stills = after.stills;
    ledger.takes = after.takes;
    ledger.videoSeconds = after.videoSeconds;
    ledger.judgeCalls = after.judgeCalls;
    ledger.reasonCalls = after.reasonCalls;
    ledger.usd = after.usd;
    const record = {
      id: `res_${ledger.reservations.length + 1}`,
      at: new Date(now).toISOString(),
      nodeId, kind, units, usd, justification,
      before, after,
    };
    ledger.reservations.push(record);
    await journal.write('reservation', record);
    return record;
  };
};

export const reservationIdOf = (reservation, nodeId) => {
  if (!reservation || typeof reservation.id !== 'string' || !reservation.id.trim()) fail('E-RESERVE-NO-ID', `the reservation for ${nodeId} carries no id — a cost row names the reservation it spent from`);
  return reservation.id;
};

export const explainCompletion = ({ policy, shot, attempts }) => {
  if (!policy || policyProblems(policy).length) fail('E-COMPLETION-POLICY', 'completionDecision needs schema-valid policy values');
  if (!shot || shot.id === undefined || shot.id === null) fail('E-COMPLETION-SHOT', 'completionDecision needs the shot with its id');
  if (!Array.isArray(attempts)) fail('E-COMPLETION-ATTEMPTS', `completionDecision needs the list of attempts for shot ${shot.id}`);
  const budget = policy.attempts.shot;
  const scored = attempts.filter((at) => typeof at.score === 'number');
  const refusal = attempts.find((at) => typeof at.refused === 'string' && at.refused.startsWith('E-BUDGET-'));
  const faulted = attempts.find((at) => typeof at.faulted === 'string' && at.faulted.trim());
  let cause;
  if (refusal) cause = 'render-ceiling';
  else if (faulted) cause = 'exhausted-faults';
  else if (attempts.length >= budget) cause = 'exhausted-shot';
  else fail('E-COMPLETION-OPEN', `shot ${shot.id} has ${attempts.length} of ${budget} attempts, no ceiling refusal and no exhausted fault budget — the pass is still working on it`);
  const decision = cause === 'render-ceiling' ? policy.completion.onRenderCeiling : policy.completion.onExhaustedShot;
  if (decision === 'promote-best' && !scored.length) {
    fail('E-COMPLETION-NO-TAKE', `shot ${shot.id}: policy says promote-best on ${cause} but no attempt produced a scored take`);
  }
  const best = scored.reduce((top, at) => (top === null || at.score > top.score ? at : top), null);
  return {
    decision,
    cause,
    budget,
    attempts: attempts.length,
    scores: attempts.map((at) => (typeof at.score === 'number' ? at.score : null)),
    best: best ? { attempt: best.attempt, score: best.score } : null,
    refused: refusal ? refusal.refused : null,
    faulted: faulted ? faulted.faulted : null,
  };
};

export const completionDecision = (args) => explainCompletion(args).decision;

export const promotionDecision = ({ policy, rubricId, instances, precision }) => {
  if (typeof rubricId !== 'string' || !rubricId.trim()) fail('E-PROMOTION-RUBRIC', 'promotionDecision needs a rubric id');
  if (!Number.isInteger(instances) || instances < 0) fail('E-PROMOTION-INSTANCES', `${rubricId}: instances must be an integer >= 0; got ${JSON.stringify(instances)}`);
  if (typeof precision !== 'number' || !(precision >= 0 && precision <= 1)) fail('E-PROMOTION-PRECISION', `${rubricId}: precision must be in [0, 1]; got ${JSON.stringify(precision)}`);
  const { minInstances, minPrecision } = policy.judge;
  const enough = instances >= minInstances;
  const precise = precision >= minPrecision;
  return {
    promote: enough && precise,
    reason: `${rubricId}: ${instances} instances vs minimum ${minInstances} (${enough ? 'met' : 'short'}), precision ${precision} vs minimum ${minPrecision} (${precise ? 'met' : 'short'})`,
  };
};

export const recurrenceDecision = ({ policy, signature, runs, ideas }) => {
  if (typeof signature !== 'string' || !signature.trim()) fail('E-RECURRENCE-SIGNATURE', 'recurrenceDecision needs a finding signature');
  if (!Number.isInteger(runs) || runs < 0) fail('E-RECURRENCE-RUNS', `${signature}: runs must be an integer >= 0; got ${JSON.stringify(runs)}`);
  if (!Number.isInteger(ideas) || ideas < 0) fail('E-RECURRENCE-IDEAS', `${signature}: ideas must be an integer >= 0; got ${JSON.stringify(ideas)}`);
  const { minRuns, minIdeas } = policy.learn;
  const enoughRuns = runs >= minRuns;
  const enoughIdeas = ideas >= minIdeas;
  return {
    propose: enoughRuns && enoughIdeas,
    reason: `${signature}: ${runs} passes vs minimum ${minRuns} (${enoughRuns ? 'met' : 'short'}), ${ideas} ideas vs minimum ${minIdeas} (${enoughIdeas ? 'met' : 'short'})`,
  };
};

const section = (payload, key, ruleId) => {
  if (!payload || !(key in payload)) fail('E-POLICY-PAYLOAD', `${ruleId} checks payload.${key}, which is absent`);
  return payload[key];
};

const list = (payload, key, ruleId) => {
  const x = section(payload, key, ruleId);
  if (!Array.isArray(x)) fail('E-POLICY-PAYLOAD', `${ruleId}: payload.${key} must be a list`);
  return x;
};

const INTAKE_REQUIRED = [
  ['slots.video', (i) => typeof i.slots?.video === 'string' && i.slots.video.trim()],
  ['slots.image', (i) => typeof i.slots?.image === 'string' && i.slots.image.trim()],
  ['slots.reason', (i) => typeof i.slots?.reason === 'string' && i.slots.reason.trim()],
  ['tos', (i) => i.tos === true],
  ['priceFileDate', (i) => typeof i.priceFileDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.priceFileDate)],
  ['style', (i) => !!i.style && typeof i.style === 'object' && !!i.style.look],
  ['policyValues', (i) => !!i.policyValues && policyProblems(i.policyValues).length === 0],
];

export const POLICY_CHECKS = {
  'POL-000': (payload) => {
    const intake = section(payload, 'intake', 'POL-000');
    if (typeof intake.audio !== 'boolean') return [v('POL-000', 'audio', false, JSON.stringify(intake.audio), 'true or false', 'audio on or off is declared by the style file')];
    const required = intake.audio ? [...INTAKE_REQUIRED, ['slots.audioJudge', (i) => typeof i.slots?.audioJudge === 'string' && i.slots.audioJudge.trim()]] : INTAKE_REQUIRED;
    return required.map(([name, present]) => {
      const ok = !!present(intake);
      return v('POL-000', name, ok, ok, 'present at intake', ok ? null : `refused by name: ${name}`);
    });
  },

  'POL-001': (payload) => {
    const brief = section(payload, 'briefInput', 'POL-001');
    const out = [];
    if (Array.isArray(brief.questions) && brief.questions.length) {
      out.push(v('POL-001', 'questions', false, brief.questions.length, 'derived, so none', 'ideation asked instead of deriving'));
    }
    for (const [key, field] of Object.entries(brief)) {
      if (key === 'questions') continue;
      const ok = !!field && typeof field === 'object' && field.derived === true && field.from === 'ideate' && typeof field.reason === 'string' && field.reason.trim();
      out.push(v('POL-001', key, ok, ok ? 'derived' : JSON.stringify(field), '{ derived: true, from: ideate, reason }', ok ? null : `${key} carries no derivation`));
    }
    if (!out.length) out.push(v('POL-001', 'briefInput', false, 0, '>= 1 derived field', 'ideation derived nothing'));
    return out;
  },

  'POL-002': (payload) => {
    const r = approveManifest({ manifest: section(payload, 'manifest', 'POL-002'), policy: section(payload, 'policy', 'POL-002'), spent: section(payload, 'spent', 'POL-002') });
    return r.arithmetic.checks.map((c) => v('POL-002', c.ceiling, c.pass, c.total, c.limit === null ? 'no ceiling (null)' : `<= ${c.limit}`, c.pass ? null : `${c.spent} spent + ${c.need} needed = ${c.total} over ${c.limit}`));
  },

  'POL-003': (payload) => {
    const reservations = list(payload, 'reservations', 'POL-003');
    const costs = list(payload, 'costs', 'POL-003');
    const known = new Map(reservations.map((r) => [r.id, r]));
    return costs.map((c, i) => {
      const res = known.get(c.reservationId);
      const ok = !!res && (!c.at || !res.at || res.at <= c.at);
      return v('POL-003', `cost ${c.id ?? i + 1}`, ok, c.reservationId ?? null, 'a reservation that preceded it', ok ? null : (res ? 'the reservation came after the spend' : 'no reservation named'));
    });
  },

  'POL-004': (payload) => {
    const policy = section(payload, 'policy', 'POL-004');
    return list(payload, 'attempts', 'POL-004').map((a) => {
      const allowed = policy.attempts[a.kind];
      const ok = Number.isInteger(allowed) && Number.isInteger(a.used) && a.used <= allowed;
      return v('POL-004', `${a.kind} ${a.subject}`, ok, a.used, allowed === undefined ? 'a declared attempt kind' : `<= ${allowed}`, ok ? null : (allowed === undefined ? `unknown attempt kind ${JSON.stringify(a.kind)}` : 'attempts beyond the policy count'));
    });
  },

  'POL-005': (payload) => {
    const policy = section(payload, 'policy', 'POL-005');
    return list(payload, 'regenerations', 'POL-005').map((r) => {
      const want = regenerateMode(policy, r.n);
      return v('POL-005', `shot ${r.shotId} regeneration ${r.n}`, r.mode === want, r.mode, want, r.mode === want ? null : 'out of the declared order');
    });
  },

  'POL-006': (payload) => {
    const policy = section(payload, 'policy', 'POL-006');
    return chainsOf(list(payload, 'shots', 'POL-006')).map((c) => v('POL-006', `chain ${c.head}`, c.length <= policy.chains.maxLength, c.length, `<= ${policy.chains.maxLength}`, c.length <= policy.chains.maxLength ? null : `chain of ${c.length} exceeds the policy length`));
  },

  'POL-007': (payload) => {
    const policy = section(payload, 'policy', 'POL-007');
    return list(payload, 'completions', 'POL-007').map((c) => {
      const want = explainCompletion({ policy, shot: c.shot, attempts: c.attempts });
      const ok = c.decision === want.decision;
      return v('POL-007', `shot ${c.shot.id}`, ok, c.decision, `${want.decision} on ${want.cause}`, ok ? null : 'the completion decision departs from policy');
    });
  },

  'POL-008': (payload) => {
    const policy = section(payload, 'policy', 'POL-008');
    return list(payload, 'verdicts', 'POL-008').map((x, i) => {
      const spending = policy.judge.spendingRubrics.includes(x.rubricId);
      const ok = x.action === 'witness' || (x.action === 'regenerate' && spending);
      return v('POL-008', `verdict ${x.id ?? i + 1} (${x.rubricId})`, ok, x.action, spending ? 'witness or regenerate' : 'witness', ok ? null : (x.action === 'regenerate' ? `${x.rubricId} is a witness rubric and spent` : `unknown action ${JSON.stringify(x.action)}`));
    });
  },

  'POL-009': (payload) => {
    const policy = section(payload, 'policy', 'POL-009');
    return list(payload, 'calibrations', 'POL-009').map((c) => {
      const want = promotionDecision({ policy, rubricId: c.rubricId, instances: c.instances, precision: c.precision });
      const ok = c.promoted === want.promote;
      return v('POL-009', c.rubricId, ok, c.promoted, want.promote, ok ? null : want.reason);
    });
  },

  'POL-010': (payload) => {
    const policy = section(payload, 'policy', 'POL-010');
    return list(payload, 'recurrences', 'POL-010').map((r) => {
      const want = recurrenceDecision({ policy, signature: r.signature, runs: r.runs, ideas: r.ideas });
      const ok = r.proposed === want.propose;
      return v('POL-010', r.signature, ok, r.proposed, want.propose, ok ? null : want.reason);
    });
  },

  'POL-011': (payload) => {
    const policy = section(payload, 'policy', 'POL-011');
    const problems = policyProblems(policy);
    if (problems.length) return problems.map((p) => v('POL-011', p.key, false, null, 'declared per schema', p.detail));
    return ceilings(policy).map(([path, limit]) => v('POL-011', path, true, limit, 'a number or null', limit === null ? 'declared unbounded' : null));
  },

  'POL-012': (payload) => {
    const shots = list(payload, 'shots', 'POL-012');
    return shots.map((sh, i) => {
      const want = decideKeyframe(sh, i ? shots[i - 1] : null);
      const ok = !!sh.keyframe && sh.keyframe.needed === want.needed && sh.keyframe.reason === want.reason;
      return v('POL-012', `shot ${sh.id}`, ok, sh.keyframe ? sh.keyframe.needed : null, want.needed, ok ? null : (sh.keyframe ? 'the recorded keyframe decision departs from the harness decision' : 'no keyframe decision recorded'));
    });
  },

  'POL-013': (payload) => {
    const policy = section(payload, 'policy', 'POL-013');
    const K = policy.candidates.perShot;
    const floor = policy.candidates.selectionFloor;
    return list(payload, 'selections', 'POL-013').flatMap((s) => {
      const countOk = Number.isInteger(s.candidates) && s.candidates >= K && s.candidates % K === 0;
      const scoreOk = typeof s.winnerScore === 'number' && (s.winnerScore >= floor || (typeof s.shortfall === 'string' && s.shortfall.trim()));
      return [
        v('POL-013', `shot ${s.shotId} candidates`, countOk, s.candidates, `${K} per attempt`, countOk ? null : 'candidate count is not whole attempts of the policy count'),
        v('POL-013', `shot ${s.shotId} winner`, !!scoreOk, s.winnerScore, `>= ${floor}, or a named shortfall`, scoreOk ? null : 'promoted under the floor with no shortfall named'),
      ];
    });
  },
};

export const runPolicyGate = (rulebook, ruleId, payload) => {
  const rule = rulebook.ruleById(ruleId);
  if (!rule || rule.class !== 'policy') fail('E-POLICY-RULE', `${ruleId} is not a policy rule in this rulebook`);
  if (rule.status !== 'active') fail('E-POLICY-RULE', `${ruleId} is ${rule.status}`);
  const check = POLICY_CHECKS[ruleId];
  if (!check) fail('E-POLICY-RULE', `${ruleId} has no check`);
  const results = check(payload, rule.params || {}).map((r) => ({ ...r, class: rule.class, blocking: rule.blocking, failureKind: rule.failureKind || 'deterministic' }));
  const blockers = results.filter((r) => r.blocking && !r.pass);
  return { pass: blockers.length === 0, results, blockers };
};
