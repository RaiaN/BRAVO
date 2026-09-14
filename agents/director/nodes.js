import {
  addActivity, bibleEntryById, insertShot, newId, removeActivity, setSequenceFields, setShotFields, shotById, touch,
} from '../../state/project.js';
import { animate, isAudioPolicyError } from '../../utils/film/core/operations.js';
import { runMeasureGates } from './gates.js';
import { getModel, keyframeImageSize, maxShotSeconds } from '../../utils/film/suiteConfig.js';
import { runWithConcurrency } from '../../utils/film/core/parallel.js';
import { kindOf, secondsOf, shotOf } from './schedule.js';
import { explainCompletion, regenerateMode, reservationIdOf } from './policy.js';

const STAGES = ['plateQC', 'generateCandidates', 'scoreCandidate', 'selectCandidate', 'takeQC'];
const CTX_KEYS = ['flow', 'policy', 'concurrency', 'poll', 'manifest', 'plan', 'seqId', 'brief', 'threadId', 'messageId', 'runId', 'client', 'rulebook', 'style', 'rubrics', 'stages', 'project', 'apply', 'run', 'node', 'setNode', 'patchRun', 'recordGates', 'say', 'journal', 'reserve'];

export const requireContext = (ctx) => {
  for (const key of CTX_KEYS) {
    if (!(key in ctx)) throw new Error(`the node context is missing "${key}"`);
  }
  for (const name of STAGES) {
    if (typeof ctx.stages?.[name] !== 'function') throw new Error(`the node context's stages have no "${name}"`);
  }
  if (typeof ctx.reserve !== 'function') throw new Error('the node context has no reserve');
  if (ctx.flow === 'policy' && !ctx.policy) throw new Error('the policy flow needs the policy values');
  for (const key of ['timeoutMs', 'maxMs']) {
    if (!Number.isInteger(ctx.poll?.[key]) || ctx.poll[key] < 1) throw new Error(`poll.${key} is missing — the policy (or the browser's declared poll constants) says how long one poll waits and how long a render may take`);
  }
  return ctx;
};

const hamming = (a, b) => {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
  return d;
};

const measureUrl = async (url, hashes) => {
  const res = await fetch('/api/film/measure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, hashes }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `measure failed (HTTP ${res.status})`);
  return data;
};

const extOf = (url, fallback) => (url.match(/\.(png|jpe?g|webp|mp4)(?=[?#]|$)/i) || [, fallback])[1].toLowerCase();

const manifestShot = (ctx, shotId) => {
  const idx = ctx.manifest.shots.findIndex((sh) => sh.id === shotId);
  const sh = ctx.manifest.shots[idx];
  if (!sh) throw new Error(`shot "${shotId}" is not in the manifest — plan shot ids must be the strings their nodes are named for (got: ${ctx.manifest.shots.map((x) => `${typeof x.id} ${JSON.stringify(x.id)}`).join(', ')})`);
  return { sh, idx, prev: idx > 0 ? ctx.manifest.shots[idx - 1] : null };
};

const planShot = (ctx, shotId) => {
  const sh = (ctx.plan.shots || []).find((x) => String(x.id) === shotId);
  if (!sh) throw new Error(`shot "${shotId}" is not in the plan the manifest was made from`);
  return sh;
};

const platesOf = (ctx) => ctx.manifest.plates.map((pl) => {
  const value = ctx.node(`plate:${pl.entity}`).value;
  if (!value) throw new Error(`plate "${pl.entity}" has no rendered value — the graph admitted a shot before its plates`);
  return { ...pl, url: value.url, assetId: value.assetId };
});

const takesOf = (ctx, shotId) => ctx.run().takes[shotId] || [];

const countedTakes = (ctx, shotId) => {
  const invalidated = ctx.node(`shoot:${shotId}`).invalidated || [];
  return takesOf(ctx, shotId).filter((t) => !invalidated.includes(t.takeId));
};

const appendTake = (ctx, shotId, entry) => ctx.patchRun((r) => ({ takes: { ...r.takes, [shotId]: [...(r.takes[shotId] || []), entry] } }));

const patchTake = (ctx, shotId, takeId, patch) => ctx.patchRun((r) => ({
  takes: { ...r.takes, [shotId]: (r.takes[shotId] || []).map((t) => (t.takeId === takeId ? { ...t, ...patch } : t)) },
}));

const wasteTakes = async (ctx, shotId, ledger, keptTakeId, codeOf, detailOf) => {
  const invalidated = ctx.node(`shoot:${shotId}`).invalidated || [];
  for (const t of ledger) {
    if (t.takeId === keptTakeId || t.waste || invalidated.includes(t.takeId)) continue;
    const code = codeOf(t);
    await ctx.journal.cost({ nodeId: `shoot:${shotId}`, kind: 'take', units: secondsOf(ctx.manifest, shotId), disposition: 'wasted', code, shotId, takeId: t.takeId, taskId: t.taskId, attempt: t.attempt, reservationId: t.reservationId, detail: detailOf(t) });
    patchTake(ctx, shotId, t.takeId, { waste: code });
  }
};

export const finding = (ctx, row) => ctx.journal.finding({ finding_id: newId('fnd'), runId: ctx.runId, at: new Date().toISOString(), ...row });

const shots = async (ctx) => {
  const { manifest, brief, seqId, apply } = ctx;
  const mapping = {};
  apply((prev) => {
    let next = prev;
    const ids = [];
    for (const sh of manifest.shots) {
      const made = insertShot(next, {
        fields: {
          title: `${brief.logline.slice(0, 24)} · ${sh.id}`,
          prompt: sh.prompt,
          model: manifest.slot,
          duration: sh.seconds,
          resolution: manifest.params.resolution,
          ratio: manifest.params.ratio,
          generateAudio: manifest.params.audio,
          ownedBy: seqId,
        },
      });
      next = made.project;
      mapping[sh.id] = made.shot.id;
      ids.push(made.shot.id);
    }
    return setSequenceFields(next, seqId, { shotIds: ids });
  });
  return { status: 'done', value: mapping };
};

const plate = async (ctx, id) => {
  const { manifest, flow, policy, seqId, apply, client, journal, reserve, patchRun, style, rubrics, stages, node, setNode } = ctx;
  const entity = shotOf(id);
  const pl = manifest.plates.find((x) => x.entity === entity);
  if (!pl) throw new Error(`plate "${entity}" is not in the manifest`);
  if (!pl.model) throw new Error(`plate "${entity}" carries no model — the plan names the image model every plate renders on`);
  const model = getModel(pl.model);
  const size = keyframeImageSize(pl.model);
  const slug = entity.replace(/[^a-z0-9]+/gi, '_');
  const admission = ctx.node(id).attempts;
  if (!Number.isInteger(admission) || admission < 1) throw new Error(`plate "${entity}" runs with no admission count — the schedule numbers every run of a node before it starts`);
  const render = async (attempt) => {
    const reservation = await reserve({ nodeId: id, kind: 'still', units: 1, justification: `identity plate for ${entity}, attempt ${attempt}` });
    const reservationId = reservationIdOf(reservation, id);
    const intentId = await journal.intent('render.image', { nodeId: id, entity, prompt: pl.prompt, model: pl.model, modelId: model, size, attempt });
    let rendered;
    try {
      rendered = await client.generateImage({ prompt: pl.prompt, referenceImages: [], size, model });
    } catch (err) {
      await journal.result(intentId, { url: null, error: err.message });
      throw err;
    }
    const { url, cacheUrl, assetId } = rendered;
    const durable = cacheUrl || url;
    if (!durable) {
      await journal.result(intentId, { url: null, error: `the image model returned no url for plate "${entity}"` });
      throw new Error(`the image model returned no url for plate "${entity}"`);
    }
    await journal.result(intentId, { url: durable, assetId: assetId || null });
    patchRun((r) => ({ spentRenders: r.spentRenders + 1 }));
    await journal.cost({ nodeId: id, kind: 'still', units: 1, disposition: 'kept', reservationId, attempt });
    await journal.media(`plate-${slug}-a${admission}-attempt${attempt}.${extOf(durable, 'png')}`, durable);
    const entry = { url: durable, assetId: assetId || null, reservationId, attempt, pass: null, score: null };
    await setNode(id, { rendered: [...(node(id).rendered || []), entry] }, true);
    return entry;
  };
  const judged = async (entry) => {
    const verdict = await stages.plateQC({ plate: { ...pl, url: entry.url, assetId: entry.assetId, attempt: entry.attempt }, style, rubrics, policy, client, journal });
    if (typeof verdict?.pass !== 'boolean' || typeof verdict.score !== 'number' || !Array.isArray(verdict.findings)) throw new Error(`plateQC returned no { pass, score, findings[] } for plate "${entity}"`);
    const scored = { ...entry, pass: verdict.pass, score: verdict.score };
    await setNode(id, { rendered: (node(id).rendered || []).map((r) => (r.attempt === entry.attempt ? scored : r)) }, true);
    await journal.write('plate', { entity, attempt: entry.attempt, budget, url: entry.url, pass: verdict.pass, score: verdict.score, findings: verdict.findings });
    return scored;
  };
  if (flow !== 'card' && !Number.isInteger(policy.attempts?.plate)) throw new Error('policy.attempts.plate is missing');
  const budget = flow === 'card' ? 1 : policy.attempts.plate;
  const keep = async (chosen) => {
    apply((prev) => touch({
      ...prev,
      bible: [...prev.bible, {
        id: newId('bib'), name: pl.entity, role: pl.role, plateUrl: chosen.url, assetId: chosen.assetId,
        notes: `plate for sequence ${seqId}`, prompt: pl.prompt, model: pl.model, stills: [], refs: [],
      }],
    }));
    await journal.media(`plate-${slug}.${extOf(chosen.url, 'png')}`, chosen.url);
    return { status: 'done', value: { url: chosen.url, assetId: chosen.assetId, attempt: chosen.attempt, pass: chosen.pass, score: chosen.score } };
  };
  if (flow === 'card') {
    const rendered = await render(1);
    await journal.write('plate', { entity, attempt: 1, budget: 1, url: rendered.url, pass: null, score: null, findings: [], skipped: 'the approved-card flow carries no judge; the approved card stands for the verdict' });
    return keep(rendered);
  }
  const ledger = [];
  const wastePlates = async (keptAttempt, codeOf, detailOf) => {
    for (const r of ledger) {
      if (r.attempt === keptAttempt) continue;
      await journal.cost({ nodeId: id, kind: 'still', units: 1, disposition: 'wasted', code: codeOf(r), attempt: r.attempt, reservationId: r.reservationId, detail: detailOf(r) });
    }
  };
  const prior = node(id).rendered || [];
  for (const r of prior.filter((x) => x.pass === true)) {
    await journal.write('plate.resumed', { entity, attempt: r.attempt, url: r.url, reason: 'a passing plate rendered before this re-admission stands' });
    return keep(r);
  }
  ledger.push(...prior.filter((x) => x.pass === false));
  for (const r of prior.filter((x) => x.pass === null)) {
    await journal.write('plate.resumed', { entity, attempt: r.attempt, url: r.url, reason: 'a rendered plate that was never judged is judged before anything is re-rendered' });
    const entry = await judged(r);
    ledger.push(entry);
    if (entry.pass) {
      await wastePlates(entry.attempt, () => 'E-WASTE-QC-REGENERATED', (x) => `attempt ${x.attempt} was rejected by plate QC (score ${x.score}); attempt ${entry.attempt} passed`);
      return keep(entry);
    }
  }
  for (let attempt = prior.length + 1; attempt <= budget; attempt += 1) {
    const rendered = await render(attempt);
    const entry = await judged(rendered);
    ledger.push(entry);
    if (entry.pass) {
      await wastePlates(attempt, () => 'E-WASTE-QC-REGENERATED', (r) => `attempt ${r.attempt} was rejected by plate QC (score ${r.score}) and re-rendered; attempt ${attempt} passed`);
      return keep(entry);
    }
    if (attempt < budget) {
      const cause = verdict.findings.map((f) => f.code || f.rubricId || f.detail || String(f)).join(', ') || `plate QC failed with score ${verdict.score}`;
      await journal.write('regeneration', { entity, attempt, mode: 'plate-rerender', cause, ruleId: null, invalidatedShots: [], justification: `plate ${entity} failed QC on attempt ${attempt} of ${budget}; nothing downstream has rendered from it` });
    }
  }
  const scored = ledger.map((r) => ({ attempt: r.attempt, score: r.score, pass: r.pass, url: r.url }));
  await journal.write('completionDecision', { entity, decision: 'promote-best', cause: 'exhausted-plate', attempts: ledger.length, budget, plates: scored });
  const best = ledger.reduce((a, b) => (b.score > a.score ? b : a));
  await finding(ctx, { family: 'shortfall', stage: 'plate', severity: 'blocker', code: 'E-PLATE-ATTEMPTS-EXHAUSTED', attempt: ledger.length, detail: `plate ${entity} exhausted ${ledger.length} of ${budget} attempts; promoted attempt ${best.attempt} (score ${best.score})`, evidence: scored });
  await wastePlates(best.attempt, () => 'E-WASTE-NOT-PROMOTED', (r) => `plate ${entity} exhausted ${ledger.length} of ${budget} attempts; attempt ${r.attempt} (score ${r.score}) lost to promoted attempt ${best.attempt} (score ${best.score})`);
  return keep(best);
};

const keyframe = async (ctx, id) => {
  const { policy, concurrency, client, journal, reserve, style, rubrics, stages, node, patchRun } = ctx;
  const shotId = shotOf(id);
  const shot = planShot(ctx, shotId);
  const decision = shot.keyframe;
  if (!decision || typeof decision.needed !== 'boolean' || !decision.reason) throw new Error(`shot "${shotId}" carries no keyframe decision — decideKeyframe records { needed, reason } on every plan shot at breakdown`);
  if (!decision.needed) {
    await journal.write('keyframe', { shotId, needed: false, reason: decision.reason });
    return { status: 'done', value: { needed: false, reason: decision.reason, url: null, candidateId: null, score: null, shortfall: null, candidates: [] } };
  }
  const k = policy.candidates?.perShot;
  if (!Number.isInteger(k) || k < 1) throw new Error('policy.candidates.perShot must be a positive integer');
  const plates = platesOf(ctx);
  const rejected = node(id).rejected || [];
  const attempt = node(id).attempts;
  await journal.write('keyframe', { shotId, needed: true, reason: decision.reason, attempt, k, rejected });
  const prior = (node(id).pool || []).filter((c) => !rejected.includes(c.id));
  const scored = [];
  try {
    const fresh = await stages.generateCandidates({ shot, plates, k, attempt, client, journal, reserve });
    if (!Array.isArray(fresh) || !fresh.length) throw new Error(`generateCandidates returned no candidates for shot "${shotId}"`);
    patchRun((r) => ({ spentRenders: r.spentRenders + fresh.length }));
    const siblings = [...prior, ...fresh];
    await runWithConcurrency(fresh.map((candidate) => async () => {
      const s = await stages.scoreCandidate({ candidate, siblings, shot, plates, style, rubrics, policy, client, journal });
      scored.push({ ...candidate, ...s });
    }), concurrency.judge);
  } catch (err) {
    if (ctx.flow !== 'policy' || !isCeilingRefusal(err)) throw err;
    await ctx.setNode(id, { pool: [...prior, ...scored.filter((c) => !rejected.includes(c.id))] }, true);
    return completeKeyframe(ctx, id, { refused: err, reason: err.message, faults: node(id).faults || 0 });
  }
  const pool = [...prior, ...scored.filter((c) => !rejected.includes(c.id))];
  const sel = await stages.selectCandidate({ shot, candidates: pool, policy, journal });
  if (!sel?.winner?.url || !sel.winner.id) throw new Error(`selectCandidate promoted no keyframe for shot "${shotId}"`);
  if (typeof sel.winner.score !== 'number' || !Array.isArray(sel.ranked)) throw new Error(`selectCandidate returned no { winner.score, ranked } for shot "${shotId}"`);
  await ctx.setNode(id, { pool }, true);
  await journal.media(`keyframe-${shotId}-attempt${attempt}.${extOf(sel.winner.url, 'png')}`, sel.winner.url);
  await journal.write('selection', { shotId, attempt, winner: sel.winner.id, score: sel.winner.score, shortfall: sel.shortfall || null, ranked: sel.ranked.map((c) => ({ id: c.id, score: c.score })) });
  if (sel.shortfall) {
    if (typeof sel.shortfall.code !== 'string' || !sel.shortfall.code) throw new Error(`selectCandidate reported a shortfall with no code for shot "${shotId}"`);
    if (!Number.isInteger(policy.attempts?.candidate)) throw new Error('policy.attempts.candidate is missing');
    const budget = policy.attempts.candidate;
    const scores = pool.map((c) => ({ candidateId: c.id, score: c.score }));
    if (attempt < budget) return { status: 'regenerate', shotId, mode: 'new-candidate', cause: sel.shortfall.code, ruleId: null };
    await journal.write('completionDecision', { shotId, decision: 'promote-best', cause: 'exhausted-candidate', attempts: attempt, budget, winner: sel.winner.id, score: sel.winner.score, shortfall: sel.shortfall, candidates: scores });
    await finding(ctx, { family: 'shortfall', stage: 'select', severity: 'note', code: 'E-KEYFRAME-FLOOR', shotId, candidateId: sel.winner.id, attempt, detail: `shot ${shotId} exhausted ${attempt} of ${budget} candidate attempts under ${sel.shortfall.code}; promoted candidate ${sel.winner.id} (score ${sel.winner.score})`, evidence: scores });
  }
  return { status: 'done', value: { needed: true, reason: decision.reason, url: sel.winner.url, candidateId: sel.winner.id, score: sel.winner.score, shortfall: sel.shortfall || null, candidates: pool.map((c) => c.id) } };
};

const isCeilingRefusal = (err) => typeof err?.code === 'string' && err.code.startsWith('E-BUDGET-');

const completeUnderCeiling = async (ctx, id, { shotPlanId, seconds, stillUrl, refused }) => {
  const { policy, journal, node } = ctx;
  const ledger = countedTakes(ctx, shotPlanId);
  const attempt = node(id).attempts;
  const why = explainCompletion({ policy, shot: { id: shotPlanId }, attempts: [...ledger, { refused: refused.code }] });
  const scored = ledger.map((t) => ({ takeId: t.takeId, attempt: t.attempt, score: t.score, pass: t.pass }));
  await journal.write('completionDecision', { shotId: shotPlanId, decision: why.decision, cause: why.cause, refused: why.refused, attempts: why.attempts, budget: why.budget, takes: scored });
  await journal.cost({ nodeId: id, kind: 'take', units: seconds, disposition: 'refused', code: refused.code, shotId: shotPlanId, attempt, detail: refused.message });
  const ceiling = { refused: refused.code, decision: why.decision };
  if (why.decision === 'promote-best') {
    const best = ledger.find((t) => t.attempt === why.best.attempt);
    await finding(ctx, { family: 'budget', stage: 'shoot', severity: 'blocker', code: refused.code, shotId: shotPlanId, takeId: best.takeId, attempt, detail: `${refused.message} — shot ${shotPlanId} promotes take ${best.takeId} (score ${best.score}) under the ceiling`, evidence: scored });
    return { status: 'done', value: { taskId: best.taskId, promptUsed: best.promptUsed, silent: best.silent, reservationId: best.reservationId, takeId: best.takeId, url: best.url, lastFrameUrl: best.lastFrameUrl, ceiling } };
  }
  if (why.decision !== 'still-hold') throw new Error(`policy.completion.onRenderCeiling is ${JSON.stringify(why.decision)} — this executor holds a still or promotes the best take under a ceiling and knows no other completion`);
  if (!stillUrl) throw new Error(`E-HOLD-NO-STILL: shot ${shotPlanId} has no keyframe or recorded last frame to hold under ${refused.code}`);
  await finding(ctx, { family: 'budget', stage: 'shoot', severity: 'blocker', code: refused.code, shotId: shotPlanId, attempt, detail: `${refused.message} — shot ${shotPlanId} is held as a still for its planned ${seconds}s`, evidence: [{ stillUrl, seconds }, ...scored] });
  return { status: 'done', value: { taskId: null, promptUsed: null, silent: false, reservationId: null, takeId: null, url: stillUrl, lastFrameUrl: stillUrl, ceiling, held: { seconds } } };
};

const completePlate = async (ctx, id, { reason, faults }) => {
  const { policy, journal, node, apply, seqId, manifest } = ctx;
  const entity = shotOf(id);
  const pl = manifest.plates.find((x) => x.entity === entity);
  const rendered = node(id).rendered || [];
  const judgedOk = rendered.filter((r) => r.pass === true);
  const unjudged = rendered.filter((r) => r.pass === null);
  const best = judgedOk[0] || unjudged[unjudged.length - 1] || null;
  await journal.write('completionDecision', { entity, node: id, decision: best ? 'ship-plate' : 'absent-plate', cause: 'exhausted-faults', faulted: reason, faults, budget: policy.attempts.fault, rendered: rendered.map((r) => ({ attempt: r.attempt, pass: r.pass, score: r.score })) });
  if (!best) {
    await finding(ctx, { family: 'shortfall', stage: 'plate', severity: 'blocker', code: 'E-PLATE-ABSENT', detail: `plate "${entity}" never rendered across ${faults} faults (${reason}) — the shots that cite it render without this identity anchor`, evidence: rendered.map((r) => ({ attempt: r.attempt, url: r.url })) });
    return { status: 'done', value: { url: null, assetId: null, attempt: null, pass: null, score: null, absent: true } };
  }
  const code = best.pass === true ? 'E-PLATE-FAULTED-AFTER-PASS' : 'E-PLATE-UNJUDGED';
  await finding(ctx, { family: 'shortfall', stage: 'plate', severity: best.pass === true ? 'note' : 'blocker', code, attempt: best.attempt, detail: `plate "${entity}" ships attempt ${best.attempt} after ${faults} faults (${reason})${best.pass === true ? '' : ' without a QC verdict'}`, evidence: [{ url: best.url, attempt: best.attempt, pass: best.pass, score: best.score }] });
  apply((prev) => touch({
    ...prev,
    bible: [...prev.bible, { id: newId('bib'), name: pl.entity, role: pl.role, plateUrl: best.url, assetId: best.assetId, notes: `plate for sequence ${seqId} (${code})`, prompt: pl.prompt, model: pl.model, stills: [], refs: [] }],
  }));
  return { status: 'done', value: { url: best.url, assetId: best.assetId, attempt: best.attempt, pass: best.pass, score: best.score, completion: code } };
};

const completeKeyframe = async (ctx, id, { refused, reason, faults }) => {
  const { policy, journal, node, stages } = ctx;
  const shotId = shotOf(id);
  const shot = planShot(ctx, shotId);
  const attempt = node(id).attempts;
  const rejected = node(id).rejected || [];
  const pool = (node(id).pool || []).filter((c) => !rejected.includes(c.id));
  const cause = refused ? 'render-ceiling' : 'exhausted-faults';
  const scores = pool.map((c) => ({ candidateId: c.id, score: c.score }));
  const unscored = (refused?.candidates || []).map((c) => c.id);
  await journal.write('completionDecision', { shotId, decision: 'promote-best', cause, refused: refused ? refused.code : null, faulted: refused ? null : reason, faults, attempts: attempt, budget: policy.attempts.fault, candidates: scores, unscored });
  if (!pool.length) throw new Error(`E-COMPLETION-NO-CANDIDATE: shot ${shotId} has no scored keyframe candidate to promote after ${reason}`);
  const sel = await stages.selectCandidate({ shot, candidates: pool, policy, journal });
  if (!sel?.winner?.url || !sel.winner.id) throw new Error(`selectCandidate promoted no keyframe for shot "${shotId}"`);
  if (typeof sel.winner.score !== 'number' || !Array.isArray(sel.ranked)) throw new Error(`selectCandidate returned no { winner.score, ranked } for shot "${shotId}"`);
  await journal.write('selection', { shotId, attempt, winner: sel.winner.id, score: sel.winner.score, shortfall: sel.shortfall || null, ranked: sel.ranked.map((c) => ({ id: c.id, score: c.score })) });
  await finding(ctx, {
    family: refused ? 'budget' : 'fault', stage: 'keyframe', severity: 'blocker', code: refused ? refused.code : 'E-KEYFRAME-FAULTS-EXHAUSTED', shotId, candidateId: sel.winner.id, attempt,
    detail: `${reason} — shot ${shotId} promotes candidate ${sel.winner.id} (score ${sel.winner.score}) from the ${pool.length} scored candidate(s) it has`, evidence: scores,
  });
  const exhausted = { cause, refused: refused ? refused.code : null, faults, decision: 'promote-best' };
  return { status: 'done', value: { needed: true, reason: shot.keyframe.reason, url: sel.winner.url, candidateId: sel.winner.id, score: sel.winner.score, shortfall: sel.shortfall || null, candidates: pool.map((c) => c.id), exhausted } };
};

const completeShoot = async (ctx, id, { reason, faults }) => {
  const { policy, journal, node } = ctx;
  const shotPlanId = shotOf(id);
  const ledger = countedTakes(ctx, shotPlanId);
  const attempt = node(id).attempts;
  const why = explainCompletion({ policy, shot: { id: shotPlanId }, attempts: [...ledger, { faulted: reason }] });
  const scored = ledger.map((t) => ({ takeId: t.takeId, attempt: t.attempt, score: t.score, pass: t.pass }));
  await journal.write('completionDecision', { shotId: shotPlanId, decision: why.decision, cause: why.cause, faulted: why.faulted, faults, attempts: why.attempts, budget: why.budget, takes: scored });
  if (why.decision !== 'promote-best') throw new Error(`policy.completion.onExhaustedShot is ${JSON.stringify(why.decision)} — this executor promotes the best take on exhaustion and knows no other completion`);
  const best = ledger.find((t) => t.attempt === why.best.attempt);
  const exhausted = { cause: why.cause, refused: null, faults, decision: why.decision };
  await finding(ctx, { family: 'fault', stage: 'shoot', severity: 'blocker', code: 'E-SHOT-FAULTS-EXHAUSTED', shotId: shotPlanId, takeId: best.takeId, taskId: best.taskId, attempt, detail: `${reason} — shot ${shotPlanId} exhausted ${faults} of ${policy.attempts.fault} faults and promotes take ${best.takeId} (score ${best.score})`, evidence: scored });
  return { status: 'done', value: { taskId: best.taskId, promptUsed: best.promptUsed, silent: best.silent, reservationId: best.reservationId, takeId: best.takeId, url: best.url, lastFrameUrl: best.lastFrameUrl, exhausted } };
};

const completeQC = async (ctx, id, { reason, faults }) => {
  const { policy, journal, node } = ctx;
  const shotId = shotOf(id);
  const shootValue = node(`shoot:${shotId}`).value;
  if (!shootValue) throw new Error(`E-COMPLETION-NO-TAKE: shot ${shotId} has no shoot value for its QC to complete on after ${reason}`);
  const ledger = countedTakes(ctx, shotId);
  const attempt = node(id).attempts;
  const takeId = shootValue.takeId || null;
  const scored = ledger.map((t) => ({ takeId: t.takeId, attempt: t.attempt, score: t.score, pass: t.pass }));
  await journal.write('completionDecision', { shotId, decision: 'ship-unjudged', cause: 'exhausted-faults', faulted: reason, faults, attempts: ledger.length, budget: policy.attempts.fault, takes: scored });
  await journal.write('qc', { shotId, takeId, attempt, faulted: reason, faults, held: shootValue.held || null, pass: null, score: null, findings: [] });
  await finding(ctx, {
    family: 'fault', stage: 'qc', severity: 'blocker', code: 'E-QC-FAULTS-EXHAUSTED', shotId, ...(takeId ? { takeId } : {}), ...(shootValue.taskId ? { taskId: shootValue.taskId } : {}), attempt,
    detail: `${reason} — take QC of shot ${shotId} faulted ${faults} of ${policy.attempts.fault} times; ${takeId ? `take ${takeId}` : 'the held still'} ships without a verdict`, evidence: scored,
  });
  return { status: 'done', value: { pass: null, score: null, takeId, attempts: ledger.length, promoted: takeId, findings: [], ...(shootValue.held ? { held: shootValue.held } : {}), faulted: { cause: 'exhausted-faults', reason, faults } }, promote: null };
};

export const EXECUTOR_COMPLETIONS = { onExhaustedShot: ['promote-best'], onRenderCeiling: ['promote-best', 'still-hold'] };

export const completionProblems = (policy) => Object.entries(EXECUTOR_COMPLETIONS)
  .filter(([key, able]) => !able.includes(policy?.completion?.[key]))
  .map(([key, able]) => `completion.${key} is ${JSON.stringify(policy?.completion?.[key])} — this executor performs ${able.join(' or ')} there`);

export const completeNode = async (ctx, id, { error, faults }) => {
  requireContext(ctx);
  if (ctx.flow !== 'policy') throw new Error(`node "${id}" asks for a completion in the ${ctx.flow} flow — the approved card halts on a fault`);
  if (!error || typeof error.message !== 'string') throw new Error(`node "${id}" asks for a completion without the fault that exhausted it`);
  if (!Number.isInteger(faults) || faults < 1) throw new Error(`node "${id}" asks for a completion with a fault count that is not a positive integer: ${JSON.stringify(faults)}`);
  const kind = kindOf(id);
  if (kind === 'plate') return completePlate(ctx, id, { reason: error.message, faults });
  if (kind === 'keyframe') return completeKeyframe(ctx, id, { refused: isCeilingRefusal(error) ? error : null, reason: error.message, faults });
  if (kind === 'shoot') return completeShoot(ctx, id, { reason: error.message, faults });
  if (kind === 'qc') return completeQC(ctx, id, { reason: error.message, faults });
  throw new Error(`E-COMPLETION-${kind.toUpperCase()}: node "${id}" exhausted ${faults} of ${ctx.policy.attempts.fault} faults (${error.message}) — this executor completes a keyframe from its scored candidates, a shoot from its recorded takes and a qc by shipping the take unjudged, and knows no completion for a ${kind} node`);
};

const shoot = async (ctx, id) => {
  const { manifest, flow, node, setNode, client, journal, reserve, apply, patchRun, project, brief, seqId, threadId, messageId } = ctx;
  const shotPlanId = shotOf(id);
  const { sh, prev } = manifestShot(ctx, shotPlanId);
  const chained = !!prev && sh.join === 'continuous';
  const keyframeValue = flow === 'policy' ? node(`keyframe:${shotPlanId}`).value : null;
  if (flow === 'policy' && !keyframeValue) throw new Error(`shot "${shotPlanId}" has no keyframe decision value — the graph admitted a shoot before its keyframe node`);
  let firstFrameUrl = null;
  if (chained) {
    firstFrameUrl = node(`shoot:${prev.id}`).value?.lastFrameUrl || null;
    if (!firstFrameUrl) throw new Error(`continuous shot "${shotPlanId}" has no recorded last frame from "${prev.id}" to continue from`);
  } else if (keyframeValue?.needed) {
    if (!keyframeValue.url) throw new Error(`shot "${shotPlanId}" needs a keyframe and none was promoted`);
    firstFrameUrl = keyframeValue.url;
  }
  const briefEntities = [...(brief.cast || []), ...(brief.locations || [])];
  const biblePlates = firstFrameUrl ? [] : briefEntities
    .map((e) => bibleEntryById(project(), e.bibleEntryId))
    .filter((b) => b && b.plateUrl)
    .map((b) => ({ url: b.plateUrl, assetId: b.assetId || null }));
  const newPlates = firstFrameUrl ? [] : manifest.plates.map((pl) => node(`plate:${pl.entity}`).value).filter((v) => v && v.url);
  const plateRefs = [...newPlates, ...biblePlates];

  const existing = node(id).value || {};
  let taskId = existing.taskId || null;
  let promptUsed = existing.promptUsed || sh.prompt;
  let silent = existing.silent || false;
  let reservationId = existing.reservationId || null;
  if (taskId && !reservationId) throw new Error(`shot "${shotPlanId}" resumes task ${taskId} without the reservation it spent from — a shoot value carries its reservationId`);

  if (!taskId) {
    let reservation;
    try {
      reservation = await reserve({ nodeId: id, kind: 'take', units: sh.seconds, justification: `take for shot ${shotPlanId} (${sh.seconds}s, ${chained ? 'continuous' : (firstFrameUrl ? 'keyframe' : 'plates')})` });
    } catch (err) {
      if (flow !== 'policy' || !isCeilingRefusal(err)) throw err;
      return completeUnderCeiling(ctx, id, { shotPlanId, seconds: sh.seconds, stillUrl: firstFrameUrl, refused: err });
    }
    reservationId = reservationIdOf(reservation, id);
    let lastIntentId = null;
    const kick = async (audioOn) => {
      const intentId = await journal.intent('render.start', { nodeId: id, shotId: shotPlanId, prompt: sh.prompt, firstFrameUrl, references: plateRefs.map((r) => r.url), seconds: sh.seconds, audio: audioOn, attempt: node(id).attempts });
      lastIntentId = intentId;
      try {
        const started = await animate({
          motion: sh.prompt,
          refUrls: plateRefs.map((r) => r.url),
          refAssetIds: plateRefs.map((r) => r.assetId || null),
          firstFrameUrl,
          duration: sh.seconds,
          resolution: manifest.params.resolution,
          ratio: firstFrameUrl ? 'adaptive' : manifest.params.ratio,
          generateAudio: audioOn,
          seed: manifest.seed,
          modelKey: manifest.slot,
        }, { client });
        await journal.result(intentId, { taskId: started.taskId, promptUsed: started.prompt });
        return started;
      } catch (err) {
        await journal.result(intentId, { taskId: null, error: err.message });
        throw err;
      }
    };
    try {
      const started = await kick(manifest.params.audio);
      taskId = started.taskId;
      promptUsed = started.prompt;
    } catch (err) {
      if (!manifest.params.audio || !isAudioPolicyError(err)) throw err;
      const attempt = node(id).attempts;
      const refusedIntentId = lastIntentId;
      await finding(ctx, { family: 'shortfall', stage: 'shoot', severity: 'note', code: 'E-AUDIO-POLICY-SILENT', shotId: shotPlanId, attempt, detail: `${err.message} — shot ${shotPlanId} is re-shot without audio where the brief declared audio`, evidence: [{ intentId: refusedIntentId, audio: true, reservationId }], disposition: 'downgrade' });
      await journal.cost({ nodeId: id, kind: 'take', units: sh.seconds, disposition: 'refused', code: 'E-AUDIO-POLICY', shotId: shotPlanId, attempt, intentId: refusedIntentId, reservationId, detail: `${err.message} — the start with audio produced no task; the silent retake spends reservation ${reservationId}` });
      await journal.write('regeneration', { shotId: shotPlanId, attempt, mode: 'silent-retake', cause: err.message, ruleId: null, intentId: refusedIntentId, reservationId, invalidatedShots: [], justification: `the refused start produced no task and spent nothing; the silent retake spends reservation ${reservationId}` });
      const started = await kick(false);
      taskId = started.taskId;
      promptUsed = started.prompt;
      silent = true;
      patchRun((r) => ({ silentShots: [...r.silentShots, sh.id] }));
    }
    await setNode(id, { value: { taskId, promptUsed, silent, reservationId } });
  }

  const activityId = newId('act');
  apply((prev) => addActivity(prev, { id: activityId, threadId, messageId, taskId, tool: 'shoot', label: `sequence · ${sh.id}`, seqId, nodeId: id }));
  let polled = null;
  const pollStarted = Date.now();
  const { timeoutMs, maxMs } = ctx.poll;
  try {
    while (!polled) {
      if (Date.now() - pollStarted > maxMs) throw new Error(`the render task outlived poll.maxMs (${maxMs}ms) at the provider (task ${taskId})`);
      await setNode(id, { lastCheckAt: new Date().toISOString() }, true);
      try {
        polled = await client.pollVideo({ taskId, timeoutMs });
      } catch (err) {
        if (!/timed out/i.test(err.message)) throw err;
      }
    }
  } finally {
    apply((prev) => removeActivity(prev, activityId));
  }

  const take = {
    id: newId('take'),
    url: polled.videoCacheUrl || polled.videoUrl,
    sourceUrl: polled.videoUrl,
    posterUrl: polled.lastFrameCacheUrl || polled.lastFrameUrl || null,
    createdAt: new Date().toISOString(),
    promptUsed,
    model: manifest.slot,
    seed: manifest.seed,
    resolution: manifest.params.resolution,
    ratio: manifest.params.ratio,
    duration: sh.seconds,
    silent,
  };
  const filmShotId = node('shots').value[sh.id];
  apply((prev) => {
    const fs = shotById(prev, filmShotId);
    return fs ? setShotFields(prev, filmShotId, { takes: [...fs.takes, take], chosenTakeId: take.id }) : prev;
  });
  patchRun((r) => ({ spentRenders: r.spentRenders + 1 }));
  const attempt = node(id).attempts;
  await journal.cost({ nodeId: id, kind: 'take', units: sh.seconds, disposition: 'kept', shotId: shotPlanId, taskId, takeId: take.id, attempt, reservationId });
  await journal.media(`shoot-${shotPlanId}-attempt${attempt}.mp4`, take.url);
  if (take.posterUrl) await journal.media(`shoot-${shotPlanId}-attempt${attempt}-lastframe.jpg`, take.posterUrl);
  const value = { taskId, promptUsed, silent, reservationId, takeId: take.id, url: take.url, lastFrameUrl: take.posterUrl };
  appendTake(ctx, shotPlanId, { ...value, attempt, firstFrameUrl, keyframeId: keyframeValue?.candidateId || null, score: null, pass: null, findings: [] });
  return { status: 'done', value };
};

const measure = async (ctx, id) => {
  const { manifest, flow, policy, node, patchRun, recordGates, rulebook, run, say, journal } = ctx;
  const shotPlanId = shotOf(id);
  const { sh } = manifestShot(ctx, shotPlanId);
  const shootValue = node(`shoot:${shotPlanId}`).value;
  if (shootValue.held) {
    await journal.write('measure', { shotId: shotPlanId, takeId: null, held: shootValue.held, refused: shootValue.ceiling.refused, measured: shootValue.held.seconds, fps: null, nbReadFrames: null, gates: [] });
    return { status: 'done', value: { shotId: shotPlanId, requested: sh.seconds, measured: shootValue.held.seconds, nbReadFrames: null, fps: null, overshoot: 0, firstHash: null, lastHash: null, hasAudio: false, silent: false, held: shootValue.held } };
  }
  const m = await measureUrl(shootValue.url, true);
  const payload = {
    brief: { targetSeconds: manifest.targetSeconds, shotCount: manifest.shots.length },
    perShot: [{ shotId: shotPlanId, requested: sh.seconds, measured: m.duration, fps: m.fps, nbReadFrames: m.nbReadFrames }],
    joins: [],
    timeline: { totalMeasured: manifest.targetSeconds },
  };
  const gates = runMeasureGates(rulebook, payload, { maxSeconds: maxShotSeconds });
  const relevant = gates.results.filter((g) => ['CIN-004', 'CIN-007'].includes(g.ruleId));
  recordGates(relevant);
  await journal.write('measure', { shotId: shotPlanId, takeId: shootValue.takeId, measured: m.duration, fps: m.fps, nbReadFrames: m.nbReadFrames, gates: relevant });
  const blockers = relevant.filter((g) => g.blocking && !g.pass);
  const value = { shotId: shotPlanId, requested: sh.seconds, measured: m.duration, nbReadFrames: m.nbReadFrames, fps: m.fps, overshoot: Math.round((m.duration - sh.seconds) * 1000) / 1000, firstHash: m.firstHash, lastHash: m.lastHash, hasAudio: m.hasAudio, silent: shootValue.silent };
  patchTake(ctx, shotPlanId, shootValue.takeId, { measure: value, measureBlockers: blockers.map((g) => g.ruleId) });
  if (blockers.length) {
    const b = blockers[0];
    const cause = b.detail || b.value;
    if (flow === 'card') {
      if (b.failureKind === 'deterministic') return { status: 'halt', reason: `[${b.ruleId}] ${cause} — a model property, not retryable`, ruleId: b.ruleId };
      const left = run().retryPoolLeft;
      if (left <= 0) return { status: 'halt', reason: `[${b.ruleId}] ${cause} — retry pool exhausted`, ruleId: b.ruleId };
      patchRun((r) => ({ retryPoolLeft: r.retryPoolLeft - 1 }));
      await journal.cost({ nodeId: `shoot:${shotPlanId}`, kind: 'take', units: sh.seconds, disposition: 'wasted', code: 'E-WASTE-GATE-REGENERATED', shotId: shotPlanId, takeId: shootValue.takeId, taskId: shootValue.taskId, reservationId: shootValue.reservationId, detail: `[${b.ruleId}] ${cause} — re-rendered from the declared pool` });
      say(`Take ${shotPlanId} failed ${b.ruleId} (${cause}) — re-rendering from the declared pool (${left - 1} left).`);
      return { status: 'regenerate', shotId: shotPlanId, mode: 'same-keyframe', cause, ruleId: b.ruleId };
    }
    if (!Number.isInteger(policy.attempts?.shot)) throw new Error('policy.attempts.shot is missing');
    const ledger = countedTakes(ctx, shotPlanId);
    const attempts = ledger.length;
    for (const g of blockers) {
      await finding(ctx, { family: 'gate', stage: 'measure', severity: 'blocker', code: `E-MEASURE-${g.ruleId}`, ruleId: g.ruleId, shotId: shotPlanId, takeId: shootValue.takeId, taskId: shootValue.taskId, attempt: attempts, detail: g.detail || String(g.value), value: g.value, threshold: g.threshold, evidence: [{ takeUrl: shootValue.url, measured: m.duration, fps: m.fps }] });
    }
    if (b.failureKind === 'retryable' && attempts < policy.attempts.shot && !shootValue.ceiling && !shootValue.exhausted) {
      return { status: 'regenerate', shotId: shotPlanId, mode: regenerateMode(policy, attempts), n: attempts, cause, ruleId: b.ruleId };
    }
    const exhausted = b.failureKind === 'retryable';
    const decision = exhausted ? policy.completion?.onExhaustedShot : 'accept-measured-blocker';
    const measured = ledger.filter((t) => t.measure).map((t) => ({ takeId: t.takeId, attempt: t.attempt, measured: t.measure.measured, fps: t.measure.fps, deviation: Math.abs(t.measure.measured - sh.seconds), blockers: t.measureBlockers }));
    await journal.write('completionDecision', { shotId: shotPlanId, decision, cause: exhausted ? 'exhausted-shot' : 'deterministic-measure-blocker', ruleId: b.ruleId, attempts, budget: policy.attempts.shot, takes: measured });
    if (exhausted && decision !== 'promote-best') throw new Error(`policy.completion.onExhaustedShot is ${JSON.stringify(decision)} — this executor promotes the best take on exhaustion and knows no other completion`);
    const best = exhausted ? measured.reduce((a, t) => (t.deviation <= a.deviation ? t : a)) : measured.find((t) => t.takeId === shootValue.takeId);
    const bestEntry = ledger.find((t) => t.takeId === best.takeId);
    await finding(ctx, { family: 'shortfall', stage: 'measure', severity: 'blocker', code: 'E-SHOT-MEASURE-SHIPPED', ruleId: b.ruleId, shotId: shotPlanId, takeId: best.takeId, taskId: bestEntry.taskId, attempt: attempts, detail: exhausted ? `shot ${shotPlanId} exhausted ${attempts} of ${policy.attempts.shot} attempts on ${b.ruleId} (${cause}); promoted take ${best.takeId} (${best.measured}s for ${sh.seconds}s)` : `shot ${shotPlanId} ships take ${best.takeId} over ${b.ruleId} (${cause}) — a model property, not retryable`, value: b.value, threshold: b.threshold, evidence: measured });
    const promote = best.takeId === shootValue.takeId ? null : { taskId: bestEntry.taskId, promptUsed: bestEntry.promptUsed, silent: bestEntry.silent, reservationId: bestEntry.reservationId, takeId: bestEntry.takeId, url: bestEntry.url, lastFrameUrl: bestEntry.lastFrameUrl };
    return { status: 'done', value: bestEntry.measure, promote };
  }
  return { status: 'done', value };
};

const qc = async (ctx, id) => {
  const { policy, node, client, journal, style, rubrics, stages } = ctx;
  const shotId = shotOf(id);
  const shot = planShot(ctx, shotId);
  const shootValue = node(`shoot:${shotId}`).value;
  const measureValue = node(`measure:${shotId}`).value;
  const keyframeValue = node(`keyframe:${shotId}`).value;
  const ledger = countedTakes(ctx, shotId);
  if (shootValue.held) {
    await journal.write('qc', { shotId, takeId: null, attempt: null, held: shootValue.held, refused: shootValue.ceiling.refused, pass: false, score: null, findings: [] });
    return { status: 'done', value: { pass: false, score: null, takeId: null, attempts: ledger.length, promoted: null, findings: [], held: shootValue.held }, promote: null };
  }
  const current = ledger.find((t) => t.takeId === shootValue.takeId);
  if (!current) throw new Error(`take ${shootValue.takeId} of shot "${shotId}" is not in the take ledger`);
  if (shootValue.ceiling || shootValue.exhausted) {
    const under = shootValue.ceiling ? shootValue.ceiling.refused : `${shootValue.exhausted.faults} exhausted faults`;
    if (typeof current.score !== 'number' || typeof current.pass !== 'boolean') throw new Error(`take ${shootValue.takeId} of shot "${shotId}" was promoted under ${under} without a recorded QC verdict`);
    await journal.write('qc', { shotId, takeId: shootValue.takeId, attempt: current.attempt, refused: shootValue.ceiling ? shootValue.ceiling.refused : null, exhausted: shootValue.exhausted || null, pass: current.pass, score: current.score, findings: current.findings });
    return { status: 'done', value: { pass: current.pass, score: current.score, takeId: shootValue.takeId, attempts: ledger.length, promoted: shootValue.takeId, findings: current.findings }, promote: null };
  }
  const plates = platesOf(ctx);
  const verdict = await stages.takeQC({ take: { id: shootValue.takeId, ...shootValue, attempt: current.attempt, measure: measureValue }, shot, keyframe: keyframeValue.needed ? keyframeValue : null, plates, style, rubrics, policy, client, journal });
  if (typeof verdict?.pass !== 'boolean' || typeof verdict.score !== 'number' || !Array.isArray(verdict.findings)) throw new Error(`takeQC returned no { pass, score, findings[] } for take ${shootValue.takeId}`);
  const blockers = verdict.findings.filter((f) => f.severity === 'blocker');
  const shipOnly = !verdict.pass && blockers.length > 0 && blockers.every((f) => f.disposition === 'ship');
  const regenerable = !verdict.pass && !shipOnly;
  patchTake(ctx, shotId, shootValue.takeId, { score: verdict.score, pass: verdict.pass, findings: verdict.findings });
  await journal.write('qc', { shotId, takeId: shootValue.takeId, attempt: current.attempt, pass: verdict.pass, regenerate: regenerable, score: verdict.score, findings: verdict.findings });
  const counted = countedTakes(ctx, shotId);
  const attempts = counted.length;
  if (verdict.pass) {
    await wasteTakes(ctx, shotId, counted, shootValue.takeId,
      (t) => (t.pass === null ? 'E-WASTE-GATE-REGENERATED' : 'E-WASTE-QC-REGENERATED'),
      (t) => `attempt ${t.attempt} was ${t.pass === null ? 'failed by a measure gate' : `rejected by take QC (score ${t.score})`} and re-shot; attempt ${current.attempt} (take ${shootValue.takeId}) passed`);
    return { status: 'done', value: { pass: true, score: verdict.score, takeId: shootValue.takeId, attempts, promoted: shootValue.takeId, findings: verdict.findings }, promote: null };
  }
  if (!Number.isInteger(policy.attempts?.shot)) throw new Error('policy.attempts.shot is missing');
  if (shipOnly) {
    const shipped = blockers;
    const scored = counted.map((t) => ({ takeId: t.takeId, attempt: t.attempt, score: t.score, pass: t.pass }));
    await journal.write('completionDecision', { shotId, decision: 'ship-measured-blocker', cause: 'deterministic-measure-blocker', ruleIds: [...new Set(shipped.map((f) => f.ruleId).filter(Boolean))], codes: shipped.map((f) => f.code), attempts, budget: policy.attempts.shot, takes: scored });
    await wasteTakes(ctx, shotId, counted, shootValue.takeId,
      (t) => (t.pass === null ? 'E-WASTE-GATE-REGENERATED' : 'E-WASTE-QC-REGENERATED'),
      (t) => `attempt ${t.attempt} was ${t.pass === null ? 'failed by a measure gate' : `rejected by take QC (score ${t.score})`} and re-shot; attempt ${current.attempt} (take ${shootValue.takeId}) ships over ${shipped.map((f) => f.code).join(', ')}, a model property no regeneration answers`);
    return { status: 'done', value: { pass: false, score: verdict.score, takeId: shootValue.takeId, attempts, promoted: shootValue.takeId, findings: verdict.findings, shipped: shipped.map((f) => f.code) }, promote: null };
  }
  if (attempts < policy.attempts.shot) {
    const mode = regenerateMode(policy, attempts);
    const cause = verdict.findings.map((f) => f.code || f.rubricId || f.detail || String(f)).join(', ') || `take QC failed with score ${verdict.score}`;
    return { status: 'regenerate', shotId, mode, n: attempts, cause, ruleId: null };
  }
  const scored = counted.map((t) => ({ takeId: t.takeId, attempt: t.attempt, score: t.score, pass: t.pass }));
  const why = explainCompletion({ policy, shot: { id: shotId }, attempts: scored });
  await journal.write('completionDecision', { shotId, decision: why.decision, cause: why.cause, attempts: why.attempts, budget: why.budget, takes: scored });
  if (why.decision !== 'promote-best') throw new Error(`policy.completion.onExhaustedShot is ${JSON.stringify(why.decision)} — this executor promotes the best take on exhaustion and knows no other completion`);
  const bestEntry = counted.find((t) => t.attempt === why.best.attempt);
  const best = { takeId: bestEntry.takeId, score: bestEntry.score };
  await finding(ctx, { family: 'shortfall', stage: 'qc', severity: 'blocker', code: 'E-SHOT-ATTEMPTS-EXHAUSTED', shotId, takeId: best.takeId, attempt: attempts, detail: `shot ${shotId} exhausted ${attempts} of ${policy.attempts.shot} attempts; promoted take ${best.takeId} (score ${best.score})`, evidence: scored });
  await wasteTakes(ctx, shotId, counted, best.takeId,
    () => 'E-WASTE-NOT-PROMOTED',
    (t) => `shot ${shotId} exhausted ${attempts} of ${policy.attempts.shot} attempts; attempt ${t.attempt} (score ${t.score}) lost to promoted take ${best.takeId} (score ${best.score})`);
  const promote = { taskId: bestEntry.taskId, promptUsed: bestEntry.promptUsed, silent: bestEntry.silent, reservationId: bestEntry.reservationId, takeId: bestEntry.takeId, url: bestEntry.url, lastFrameUrl: bestEntry.lastFrameUrl };
  return { status: 'done', value: { pass: false, score: best.score, takeId: shootValue.takeId, attempts, promoted: best.takeId, findings: verdict.findings }, promote };
};

const chain = async (ctx, id) => {
  const { manifest, node, recordGates, rulebook, journal } = ctx;
  const shotPlanId = shotOf(id);
  const { sh, prev } = manifestShot(ctx, shotPlanId);
  if (!prev) throw new Error(`shot "${shotPlanId}" is the first shot — it has no join to measure`);
  const a = node(`measure:${prev.id}`).value.lastHash;
  const b = node(`measure:${shotPlanId}`).value.firstHash;
  const distance = hamming(a, b);
  const joinType = sh.join;
  if (!['cut', 'continuous'].includes(joinType)) throw new Error(`shot "${shotPlanId}" declares join ${JSON.stringify(joinType === undefined ? null : joinType)} — a join is measured as a cut or as continuous, never as a default`);
  const gates = runMeasureGates(rulebook, {
    brief: { targetSeconds: manifest.targetSeconds, shotCount: manifest.shots.length },
    perShot: [],
    joins: [{ from: prev.id, to: shotPlanId, distance, joinType }],
    timeline: { totalMeasured: manifest.targetSeconds },
  }, { maxSeconds: maxShotSeconds });
  const relevant = gates.results.filter((g) => ['CIN-003', 'CIN-012'].includes(g.ruleId));
  recordGates(relevant);
  await journal.write('join', { from: prev.id, to: shotPlanId, distance, joinType, gates: relevant });
  return { status: 'done', value: { from: prev.id, to: shotPlanId, distance, joinType } };
};

const assemble = async (ctx) => {
  const { manifest, node, seqId, journal } = ctx;
  const admission = node('assemble').attempts;
  if (!Number.isInteger(admission) || admission < 1) throw new Error('assemble runs with no admission count — the schedule numbers every run of a node before it starts');
  const urls = manifest.shots.map((sh) => {
    const value = node(`shoot:${sh.id}`).value;
    return value.held ? { url: value.url, seconds: value.held.seconds } : value.url;
  });
  const res = await fetch('/api/film/stitch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shots: urls, name: `slice-${seqId}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.details || data.error || `stitch failed (HTTP ${res.status})`);
  const url = data.cacheUrl || data.url;
  const media = `slice-a${admission}.mp4`;
  await journal.media(media, url);
  await journal.write('assemble', { takes: manifest.shots.map((sh) => node(`shoot:${sh.id}`).value.takeId), url, media, admission });
  return { status: 'done', value: { url, media, admission } };
};

const final = async (ctx) => {
  const { manifest, flow, node, recordGates, rulebook, journal } = ctx;
  const sliceUrl = node('assemble').value.url;
  const m = await measureUrl(sliceUrl, false);
  const gates = runMeasureGates(rulebook, {
    brief: { targetSeconds: manifest.targetSeconds, shotCount: manifest.shots.length },
    perShot: [],
    joins: [],
    timeline: { totalMeasured: m.duration },
  }, { maxSeconds: maxShotSeconds });
  const relevant = gates.results.filter((g) => g.ruleId === 'CIN-008');
  recordGates(relevant);
  await journal.write('final', { totalMeasured: m.duration, targetSeconds: manifest.targetSeconds, fps: m.fps, gates: relevant });
  const blocker = gates.blockers.find((g) => g.ruleId === 'CIN-008');
  if (blocker) {
    if (flow === 'card') return { status: 'halt', reason: `[CIN-008] assembled ${m.duration}s for target ${manifest.targetSeconds}s — ${blocker.detail}`, ruleId: 'CIN-008' };
    await finding(ctx, { family: 'gate', stage: 'final', severity: 'blocker', code: 'E-TIMELINE-CIN-008', ruleId: 'CIN-008', detail: `assembled ${m.duration}s for target ${manifest.targetSeconds}s — ${blocker.detail}`, value: blocker.value, threshold: blocker.threshold, evidence: [{ sliceUrl, totalMeasured: m.duration }] });
  }
  return { status: 'done', value: { totalMeasured: m.duration, deltaFromN: Math.round((m.duration - manifest.targetSeconds) * 1000) / 1000, fps: m.fps } };
};

export const NODES = { shots, plate, keyframe, shoot, measure, qc, chain, assemble, final };

export const runNode = async (ctx, id) => {
  requireContext(ctx);
  const body = NODES[kindOf(id)];
  if (!body) throw new Error(`node "${id}" has no body`);
  return body(ctx, id);
};
