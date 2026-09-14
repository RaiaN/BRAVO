const JOINS = ['cut', 'continuous'];
const FLOWS = ['card', 'policy'];
const CHAIN_KINDS = ['shoot', 'measure', 'qc'];

export const kindOf = (id) => id.split(':')[0];
export const shotOf = (id) => id.slice(id.indexOf(':') + 1);
export const secondsOf = (manifest, shotId) => {
  const sh = manifest.shots.find((x) => x.id === shotId);
  if (!sh) throw new Error(`E-SHOT-SECONDS: shot "${shotId}" is not in the manifest, so its take has no seconds to charge`);
  if (typeof sh.seconds !== 'number' || !Number.isFinite(sh.seconds) || sh.seconds <= 0) throw new Error(`E-SHOT-SECONDS: shot "${shotId}" declares no seconds (${JSON.stringify(sh.seconds)}); a take is charged by its shot's seconds`);
  return sh.seconds;
};

export const chainsOf = (manifest) => {
  const chains = [];
  manifest.shots.forEach((sh, i) => {
    if (i === 0 || sh.join === 'cut') chains.push([sh.id]);
    else chains.at(-1).push(sh.id);
  });
  return chains;
};

export const successorsOf = (manifest, shotId) => {
  const i = manifest.shots.findIndex((sh) => sh.id === shotId);
  if (i < 0) throw new Error(`shot "${shotId}" is not in the manifest`);
  const out = [];
  for (let j = i + 1; j < manifest.shots.length && manifest.shots[j].join === 'continuous'; j += 1) out.push(manifest.shots[j].id);
  return out;
};

export const validateManifest = (manifest) => {
  const typed = manifest.shots.find((sh) => typeof sh.id !== 'string');
  if (typed) throw new Error(`shot "${typed.id}" is not in the manifest by name — plan shot ids must be the strings their nodes are named for (got: ${manifest.shots.map((x) => `${typeof x.id} ${JSON.stringify(x.id)}`).join(', ')})`);
  const untyped = manifest.shots.slice(1).filter((sh) => !JOINS.includes(sh.join));
  if (untyped.length) throw new Error(`shots ${untyped.map((sh) => sh.id).join(', ')} declare no join — every shot after the first is a cut or continuous; break the plan down again under the join law`);
  return manifest;
};

export const nodeIds = (manifest, { flow }) => {
  if (!FLOWS.includes(flow)) throw new Error(`flow must be one of ${FLOWS.join(', ')} — got ${JSON.stringify(flow)}`);
  const policy = flow === 'policy';
  return [
    'shots',
    ...manifest.plates.map((p) => `plate:${p.entity}`),
    ...manifest.shots.flatMap((sh, i) => [
      ...(policy ? [`keyframe:${sh.id}`] : []),
      `shoot:${sh.id}`,
      `measure:${sh.id}`,
      ...(policy ? [`qc:${sh.id}`] : []),
      ...(i > 0 ? [`chain:${sh.id}`] : []),
    ]),
    'assemble',
    'final',
  ];
};

export const dependenciesOf = (manifest, id, { flow }) => {
  if (!FLOWS.includes(flow)) throw new Error(`flow must be one of ${FLOWS.join(', ')} — got ${JSON.stringify(flow)}`);
  const policy = flow === 'policy';
  const plates = manifest.plates.map((p) => `plate:${p.entity}`);
  const kind = kindOf(id);
  if (id === 'shots' || kind === 'plate') return [];
  if (kind === 'keyframe') return plates;
  const shotId = shotOf(id);
  const i = manifest.shots.findIndex((sh) => sh.id === shotId);
  if (i < 0 && !['assemble', 'final'].includes(id)) throw new Error(`node "${id}" names a shot that is not in the manifest`);
  const prev = i > 0 ? manifest.shots[i - 1].id : null;
  if (kind === 'shoot') {
    if (!policy) return ['shots', ...(i > 0 ? [`measure:${prev}`] : plates)];
    if (i > 0 && manifest.shots[i].join === 'continuous') return ['shots', `shoot:${prev}`];
    return ['shots', `keyframe:${shotId}`];
  }
  if (kind === 'measure') return [`shoot:${shotId}`];
  if (kind === 'qc') return [`measure:${shotId}`];
  if (kind === 'chain') return [`measure:${prev}`, `measure:${shotId}`];
  if (id === 'assemble') {
    return [
      ...manifest.shots.map((sh) => (policy ? `qc:${sh.id}` : `measure:${sh.id}`)),
      ...manifest.shots.slice(1).map((sh) => `chain:${sh.id}`),
    ];
  }
  if (id === 'final') return ['assemble'];
  throw new Error(`node "${id}" has no place in the dependency graph`);
};

export const invalidationOf = (manifest, shotId, { flow, mode }) => {
  const policy = flow === 'policy';
  const own = [
    ...(policy && mode === 'new-candidate' ? [`keyframe:${shotId}`] : []),
    `shoot:${shotId}`, `measure:${shotId}`, ...(policy ? [`qc:${shotId}`] : []),
  ];
  const successors = successorsOf(manifest, shotId);
  const touched = [shotId, ...successors];
  const joins = [];
  for (const sid of touched) {
    const j = manifest.shots.findIndex((sh) => sh.id === sid);
    if (j > 0) joins.push(`chain:${sid}`);
    if (j + 1 < manifest.shots.length) joins.push(`chain:${manifest.shots[j + 1].id}`);
  }
  const succ = successors.flatMap((sid) => [`shoot:${sid}`, `measure:${sid}`, ...(policy ? [`qc:${sid}`] : [])]);
  return { own, successors: succ, joins: [...new Set(joins)], invalidatedShots: successors };
};

const keyframeNeeded = (plan, shotId) => {
  const sh = (plan.shots || []).find((x) => String(x.id) === shotId);
  if (!sh) throw new Error(`shot "${shotId}" is not in the plan the manifest was made from`);
  if (typeof sh.keyframe?.needed !== 'boolean') throw new Error(`shot "${shotId}" carries no keyframe decision — decideKeyframe records { needed, reason } on every plan shot at breakdown`);
  return sh.keyframe.needed;
};

const classOf = (plan, id) => {
  const kind = kindOf(id);
  if (kind === 'plate') return 'stills';
  if (kind === 'keyframe') return keyframeNeeded(plan, shotOf(id)) ? 'stills' : 'local';
  if (kind === 'shoot') return 'chains';
  if (kind === 'qc') return 'judge';
  return 'local';
};

const requireCaps = (concurrency) => {
  for (const key of ['stills', 'chains', 'judge']) {
    if (!Number.isInteger(concurrency?.[key]) || concurrency[key] < 1) throw new Error(`concurrency.${key} must be a positive integer — got ${JSON.stringify(concurrency?.[key])}`);
  }
  return concurrency;
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const runSchedule = async ({ manifest, plan, flow, policy, concurrency, nodes, run, complete, journal }) => {
  if (!FLOWS.includes(flow)) throw new Error(`flow must be one of ${FLOWS.join(', ')} — got ${JSON.stringify(flow)}`);
  if (flow === 'policy' && !policy) throw new Error('the policy flow needs the policy values');
  if (flow === 'card' && policy) throw new Error('the approved-card flow carries no policy — pass the policy flow to regenerate');
  if (!plan) throw new Error('the schedule needs the plan the manifest was made from');
  if (!nodes || typeof nodes.get !== 'function' || typeof nodes.set !== 'function') throw new Error('the schedule needs nodes.get and nodes.set');
  if (typeof run !== 'function') throw new Error('the schedule needs a node runner');
  if (!journal || typeof journal.write !== 'function' || typeof journal.cost !== 'function') throw new Error('the schedule needs a journal with write and cost');
  const caps = requireCaps(concurrency);
  if (flow === 'policy') {
    if (!Number.isInteger(policy.attempts?.fault) || policy.attempts.fault < 1) throw new Error('policy.attempts.fault is missing');
    if (!Number.isInteger(policy.resume?.backoffMs) || policy.resume.backoffMs < 0) throw new Error('policy.resume.backoffMs is missing — a faulted node re-enters after the backoff the policy declares');
    if (typeof complete !== 'function') throw new Error('the policy flow needs a completion for a node that exhausts policy.attempts.fault — nothing waits on a person after intake');
  }
  validateManifest(manifest);

  const ids = nodeIds(manifest, { flow });
  const deps = new Map(ids.map((id) => [id, dependenciesOf(manifest, id, { flow })]));
  for (const [id, list] of deps) {
    for (const d of list) if (!deps.has(d)) throw new Error(`node "${id}" depends on "${d}", which is not in the graph`);
  }
  const chains = chainsOf(manifest);
  const chainIndex = new Map();
  chains.forEach((c, ci) => c.forEach((sid) => chainIndex.set(sid, ci)));
  const shotIndex = new Map(manifest.shots.map((sh, i) => [sh.id, i]));
  const tier = (id) => {
    const kind = kindOf(id);
    if (id === 'shots') return 0;
    if (kind === 'plate') return 1;
    if (kind === 'keyframe') return 2;
    if (CHAIN_KINDS.includes(kind) || kind === 'chain') return 3;
    return 4;
  };
  const chainStarted = (ci) => chains[ci].some((sid) => nodes.get(`shoot:${sid}`).status === 'done');
  const priority = (id) => {
    const kind = kindOf(id);
    const sid = ['shots', 'assemble', 'final'].includes(id) ? null : shotOf(id);
    const ci = sid !== null && chainIndex.has(sid) ? chainIndex.get(sid) : -1;
    const len = ci >= 0 ? chains[ci].length : 0;
    const started = kind === 'shoot' && ci >= 0 && chainStarted(ci) ? 0 : 1;
    const idx = sid !== null && shotIndex.has(sid) ? shotIndex.get(sid) : (kind === 'plate' ? manifest.plates.findIndex((p) => p.entity === sid) : 0);
    return [tier(id), started, -len, idx];
  };
  const byPriority = (a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    for (let i = 0; i < pa.length; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  };

  const running = new Map();
  const waiting = new Map();
  const invalidated = new Set();
  const completing = new Set();
  const exhausted = new Map();
  const budget = flow === 'policy' ? policy.attempts.fault : null;
  const backoffMs = flow === 'policy' ? policy.resume.backoffMs : null;
  let halted = null;
  let wave = 0;

  const status = (id) => nodes.get(id).status;
  const isReady = (id) => status(id) !== 'done' && !running.has(id) && !waiting.has(id) && deps.get(id).every((d) => status(d) === 'done');
  const inFlight = (cls) => [...running.keys()].filter((r) => classOf(plan, r) === cls).length;
  const admissible = (id) => {
    const cls = classOf(plan, id);
    if (cls === 'local') return true;
    return inFlight(cls) < caps[cls];
  };

  const track = (id, began, promise) => {
    running.set(id, Promise.resolve(promise)
      .then((outcome) => ({ id, began, outcome }))
      .catch((error) => ({ id, began, error })));
  };

  const start = async (id) => {
    const cur = nodes.get(id);
    const began = Date.now();
    const attempt = (cur.attempts || 0) + 1;
    await nodes.set(id, { status: 'running', startedAt: new Date(began).toISOString(), attempts: attempt });
    await journal.write('schedule', { event: 'admit', id, wave, attempt, running: [...running.keys()] });
    let p;
    try {
      p = run(id);
    } catch (err) {
      p = Promise.reject(err);
    }
    track(id, began, p);
  };

  const reset = async (id, patch = {}) => {
    if (running.has(id)) { invalidated.add(id); return 'in-flight'; }
    const cur = nodes.get(id);
    if (cur.status === 'pending' && cur.value === null) return 'untouched';
    await nodes.set(id, { status: 'pending', value: null, ...patch });
    return 'reset';
  };

  const invalidateSuccessors = async ({ set, record, detail }) => {
    for (const id of [...set.successors, ...set.joins]) {
      const before = nodes.get(id);
      const stale = kindOf(id) === 'shoot' ? before.value?.takeId || null : null;
      const r = await reset(id, stale ? { invalidated: [...(before.invalidated || []), stale] } : {});
      if (r === 'in-flight') record.inFlight.push(id);
      else if (r === 'reset') {
        record.reset.push(id);
        if (stale) {
          record.wasted.push(stale);
          await journal.cost({ nodeId: id, kind: 'take', units: secondsOf(manifest, shotOf(id)), disposition: 'wasted', code: 'E-WASTE-INVALIDATED-SUCCESSOR', shotId: shotOf(id), takeId: stale, reservationId: before.value.reservationId, detail });
        }
      }
    }
    return record;
  };

  const regenerationNumber = (id, outcome) => {
    if (flow !== 'policy' || !['measure', 'qc'].includes(kindOf(id))) return null;
    if (!Number.isInteger(outcome.n) || outcome.n < 1) throw new Error(`node "${id}" asked to regenerate shot ${outcome.shotId} without its regeneration number — the mode is chosen from the counted takes, not the shoot node's admissions, and the audit reads that number as n`);
    return outcome.n;
  };

  const regenerate = async ({ shotId, mode, n, cause, ruleId, attempt }) => {
    const set = invalidationOf(manifest, shotId, { flow, mode });
    const record = { reset: [], inFlight: [], wasted: [] };
    for (const id of set.own) {
      const before = nodes.get(id);
      const rejectedId = kindOf(id) === 'keyframe' ? before.value?.candidateId || null : null;
      const r = await reset(id, rejectedId ? { rejected: [...(before.rejected || []), rejectedId] } : {});
      if (r === 'in-flight') record.inFlight.push(id); else if (r === 'reset') record.reset.push(id);
      if (r === 'reset' && rejectedId) {
        await journal.cost({ nodeId: id, kind: 'still', units: 1, disposition: 'wasted', code: 'E-WASTE-KEYFRAME-REJECTED', shotId, candidateId: rejectedId, detail: `shot ${shotId} regenerated with a new candidate after ${cause}` });
      }
    }
    await invalidateSuccessors({ set, record, detail: `shot ${shotId} regenerated (${mode} after ${cause})` });
    await journal.write('regeneration', { shotId, attempt, n, mode, cause, ruleId: ruleId || null, invalidatedShots: set.invalidatedShots, ...record });
  };

  const exhaust = async (id, error, faults) => {
    const began = Date.now();
    await nodes.set(id, { status: 'running', faults });
    await journal.write('schedule', { event: 'exhausted', id, faults, budget, reason: error.message });
    completing.add(id);
    exhausted.set(id, error);
    track(id, began, Promise.resolve().then(() => complete(id, { error, faults })));
  };

  const settle = async ({ id, began, outcome, error, backoff }) => {
    if (backoff) { waiting.delete(id); return; }
    running.delete(id);
    const completed = completing.delete(id);
    const ms = Date.now() - began;
    if (invalidated.has(id)) {
      invalidated.delete(id);
      await journal.write('schedule', { event: 'invalidated', id, ms, outcome: error ? `fault: ${error.message}` : outcome.status });
      const stale = !error && outcome.status === 'done' && kindOf(id) === 'shoot' ? outcome.value?.takeId || null : null;
      if (stale) {
        await journal.cost({ nodeId: id, kind: 'take', units: secondsOf(manifest, shotOf(id)), disposition: 'wasted', code: 'E-WASTE-INVALIDATED-SUCCESSOR', shotId: shotOf(id), takeId: stale, reservationId: outcome.value.reservationId, detail: 'a predecessor regenerated while this take was in flight; the discarded take is not one of the shot\'s attempts' });
      }
      await nodes.set(id, { status: 'pending', value: null, ...(stale ? { invalidated: [...(nodes.get(id).invalidated || []), stale] } : {}) });
      return;
    }
    if (error) {
      if (flow === 'card') { halted = { node: id, reason: error.message, ruleId: null }; return; }
      if (completed) {
        const fault = exhausted.get(id);
        const faults = nodes.get(id).faults;
        await journal.write('schedule', { event: 'completion-failed', id, faults, budget, fault: fault.message, reason: error.message });
        halted = { node: id, reason: `${fault.message} (${faults} faults, budget ${budget}) — the completion refused by name: ${error.message}`, ruleId: null };
        return;
      }
      const faults = (nodes.get(id).faults || 0) + 1;
      await journal.write('fault', { id, attempt: nodes.get(id).attempts, faults, budget, reason: error.message, backoffMs: faults < budget ? backoffMs : null });
      if (faults >= budget) { await exhaust(id, error, faults); return; }
      await nodes.set(id, { status: 'pending', faults });
      waiting.set(id, sleep(backoffMs).then(() => ({ id, backoff: true })));
      return;
    }
    if (!outcome || typeof outcome.status !== 'string') throw new Error(`node "${id}" returned no outcome status`);
    if (completed && outcome.status !== 'done') throw new Error(`node "${id}" completed with status ${JSON.stringify(outcome.status)} — a completion is done or fails by name`);
    if (outcome.status === 'done') {
      await nodes.set(id, { status: 'done', ms, value: outcome.value });
      if (outcome.promote) {
        const shootId = `shoot:${shotOf(id)}`;
        const current = nodes.get(shootId).value;
        if (current?.takeId !== outcome.promote.takeId) {
          await nodes.set(shootId, { value: outcome.promote });
          const shotId = shotOf(id);
          const set = invalidationOf(manifest, shotId, { flow, mode: 'promote' });
          const record = await invalidateSuccessors({ set, record: { reset: [], inFlight: [], wasted: [] }, detail: `shot ${shotId} promoted take ${outcome.promote.takeId}, which is not the last take rendered` });
          await journal.write('regeneration', { shotId, attempt: null, n: null, mode: 'promote-best', cause: `promoted take ${outcome.promote.takeId} is not the last take rendered`, ruleId: null, invalidatedShots: set.invalidatedShots, ...record });
        }
      }
      return;
    }
    if (outcome.status === 'regenerate') {
      await nodes.set(id, { status: 'pending', value: null, ms });
      await regenerate({ ...outcome, n: regenerationNumber(id, outcome), attempt: nodes.get(`shoot:${outcome.shotId}`).attempts });
      return;
    }
    if (outcome.status === 'halt') {
      if (flow !== 'card') throw new Error(`node "${id}" asked to halt in the policy flow — after intake a violation is a finding and a shortfall is named, never a halt`);
      halted = { node: id, reason: outcome.reason, ruleId: outcome.ruleId || null };
      return;
    }
    throw new Error(`node "${id}" returned an unknown outcome status ${JSON.stringify(outcome.status)}`);
  };

  while (true) {
    if (!halted) {
      const ready = ids.filter(isReady).sort(byPriority);
      let admitted = 0;
      for (const id of ready) {
        if (admissible(id)) { await start(id); admitted += 1; }
      }
      if (admitted) wave += 1;
    }
    if (!running.size && !waiting.size) break;
    await settle(await Promise.race([...running.values(), ...waiting.values()]));
  }

  if (halted) {
    await journal.write('schedule', { event: 'halted', ...halted });
    return { status: 'halted', halted, waves: wave };
  }
  const left = ids.filter((id) => status(id) !== 'done');
  if (left.length) throw new Error(`the schedule stalled with nothing running and ${left.length} nodes undone: ${left.join(', ')}`);
  await journal.write('schedule', { event: 'complete', waves: wave });
  return { status: 'done', halted: null, waves: wave };
};
