import { animate } from '../utils/film/core/operations.js';
import { maxShotSeconds } from '../utils/film/suiteConfig.js';
import { reservationIdOf } from './director/policy.js';
import { filmTimingOf, measure, referenceQC, takeQC } from './film-qc.js';

const need = (name, value, ok) => { if (!ok(value)) throw new Error(`E-FILM-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}: the film loop needs ${name}`); return value; };
const json = (content, what) => {
  const body = String(content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
  try { return JSON.parse(body); } catch (err) { throw new Error(`${what} is not JSON (${err.message})`); }
};
const REFUSAL = /copyright|sensitive|prohibited|policy|violat|not allowed|inappropriate|SensitiveContent|content/i;
const faultKind = (err) => (REFUSAL.test(String(err?.message || '')) ? 'refused' : 'transient');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (route, body) => {
  const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`E-ROUTE-${res.status}: POST ${route} answered HTTP ${res.status} with a non-JSON body — restart the dev server if the route is new`); }
  if (!res.ok) throw new Error(data.details || data.error || `${route} failed (HTTP ${res.status})`);
  return data;
};

const planShots = async ({ idea, style, seconds, window, refs, client, journal, reserve, attempt, rejected }) => {
  await reserve({ nodeId: 'plan', kind: 'reason', units: 1, justification: `plan the shots, attempt ${attempt}` });
  const system = [
    'You plan a film slice as a list of shots the video model renders one by one. Return ONLY a JSON object, no prose, no fences:',
    '{ "logline": "", "references": [{ "name": "", "role": "character"|"location"|"prop", "prompt": "<a reference still: a character sheet on a neutral background, or a location wide shot>" }], "shots": [{ "id": "s1", "subject": "<a reference name>", "force": "<the antagonism acting in this shot and how it is visible>", "change": "<first-frame state -> last-frame state>", "setup": "<camera setup>", "seconds": <integer>, "prompt": "<the full prompt for the video model: who, doing what, where, shot how, what changes>" }] }',
    '',
    `STRUCTURE IS LAW: between ${window.kMin} and ${window.kMax} shots; every shot ${window.dMin} to ${window.dMax} seconds; the seconds sum to exactly ${seconds}. Every shot names a subject from the references, a visible force, and a change. The story turns; the opposition acts on screen.`,
    `STYLE: ${JSON.stringify(style.look)}. Constraints: ${(style.constraints || []).join('; ') || 'none'}. ${(style.doctrine || []).join(' ')}`,
    'Describe people by role, build, wardrobe and expression, never by resemblance to anyone real; no brands, logos, titles or on-screen text.',
  ].join('\n');
  const prompt = `THE IDEA:\n${idea}\n\nKNOWN REFERENCES (reuse these names when they fit): ${JSON.stringify(refs.map((r) => r.name))}${rejected ? `\n\nYOUR LAST PLAN WAS REJECTED:\n${rejected}\n\nReturn the corrected JSON only.` : ''}`;
  const { content } = await client.reason({ prompt, systemPrompt: system, nodeId: 'plan' });
  const plan = json(content, 'the plan');
  const problems = [];
  if (!Array.isArray(plan.shots)) problems.push('"shots" must be an array');
  if (plan.references !== undefined && !Array.isArray(plan.references)) problems.push('"references" must be an array of { name, role, prompt }');
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  const references = Array.isArray(plan.references) ? plan.references : [];
  if (shots.length < window.kMin || shots.length > window.kMax) problems.push(`${shots.length} shots; the law allows ${window.kMin} to ${window.kMax}`);
  const sum = shots.reduce((a, s) => a + (Number.isInteger(s.seconds) ? s.seconds : 0), 0);
  if (sum !== seconds) problems.push(`the shots sum to ${sum}s, the target is ${seconds}s`);
  shots.forEach((s, i) => {
    if (!Number.isInteger(s.seconds) || s.seconds < window.dMin || s.seconds > window.dMax) problems.push(`shot ${s.id || i + 1}: ${JSON.stringify(s.seconds)}s is outside ${window.dMin}-${window.dMax}`);
    for (const k of ['id', 'subject', 'force', 'change', 'setup', 'prompt']) if (!String(s[k] || '').trim()) problems.push(`shot ${s.id || i + 1}: no ${k}`);
  });
  const names = new Set(references.map((r) => r.name).concat(refs.map((r) => r.name)));
  shots.forEach((s) => { if (s.subject && !names.has(s.subject)) problems.push(`shot ${s.id}: subject ${JSON.stringify(s.subject)} is not a reference`); });
  await journal.write('plan', { attempt, logline: plan.logline || null, shotCount: shots.length, shots: shots.map((s) => ({ id: String(s.id ?? ''), seconds: s.seconds, subject: s.subject, force: s.force, change: s.change, setup: s.setup })), seconds: sum, references: references.map((r) => r.name), problems, prompt, response: content });
  if (problems.length) return { problems };
  return { plan: { logline: plan.logline || '', references, shots: shots.map((s) => ({ ...s, id: String(s.id) })) } };
};

const renderReference = async ({ ref, policy, client, journal, reserve, runId }) => {
  const nodeId = `reference:${ref.name}`;
  const tries = [];
  for (let attempt = 1; attempt <= policy.attempts.plate; attempt += 1) {
    const reservation = await reserve({ nodeId, kind: 'still', units: 1, justification: `reference for ${ref.name}, attempt ${attempt}` });
    const reservationId = reservationIdOf(reservation, nodeId);
    const intentId = await journal.intent('render.image', { nodeId, name: ref.name, role: ref.role, prompt: ref.prompt, attempt });
    let out;
    try { out = await client.generateImage({ prompt: ref.prompt, referenceImages: [], size: '2K', model: undefined }); } catch (err) {
      await journal.result(intentId, { url: null, error: err.message });
      await journal.cost({ nodeId, kind: 'still', units: 1, disposition: 'refused', code: faultKind(err) === 'refused' ? 'E-PROVIDER-REFUSED' : 'E-FAULT', attempt, reservationId, detail: err.message });
      await journal.write('fault', { node: nodeId, attempt, kind: faultKind(err), reason: err.message });
      continue;
    }
    const url = out.cacheUrl || out.url;
    let assetId = out.assetId || null;
    if (!assetId) {
      const preserved = await post('/api/film/preserve', { url, name: `reference-${ref.name.replace(/[^a-z0-9]+/gi, '_')}-attempt${attempt}.jpg` });
      assetId = preserved.assetId || null;
    }
    if (!assetId) throw new Error(`E-REFERENCE-NO-ASSET: ${ref.name} could not be registered as an asset — every reference rides as an asset id`);
    out = { ...out, assetId };
    await journal.result(intentId, { url, assetId });
    await journal.cost({ nodeId, kind: 'still', units: 1, disposition: 'kept', attempt, reservationId });
    await journal.media(`reference-${ref.name.replace(/[^a-z0-9]+/gi, '_')}-attempt${attempt}.jpg`, url);
    const verdict = await referenceQC({ ref, url, client, journal, reserve, nodeId });
    tries.push({ url, assetId: out.assetId, attempt, pass: verdict.pass, score: verdict.score, reservationId });
    await journal.write('reference', { name: ref.name, role: ref.role, attempt, url, assetId: out.assetId, pass: verdict.pass, score: verdict.score });
    if (verdict.pass) break;
  }
  const best = [...tries].sort((a, b) => (Number(b.pass) - Number(a.pass)) || (b.score - a.score))[0];
  if (!best) {
    await journal.finding({ finding_id: `fnd_${runId}_ref_${ref.name.replace(/[^a-z0-9]+/gi, '_')}`, runId, at: new Date().toISOString(), family: 'shortfall', stage: 'plate', severity: 'blocker', code: 'E-REFERENCE-ABSENT', detail: `no reference rendered for ${ref.name}`, evidence: [] });
    return null;
  }
  for (const t of tries) if (t !== best) await journal.cost({ nodeId, kind: 'still', units: 1, disposition: 'wasted', code: 'E-WASTE-QC-REGENERATED', attempt: t.attempt, reservationId: t.reservationId, detail: `lost to attempt ${best.attempt}` });
  return { name: ref.name, role: ref.role, url: best.url, assetId: best.assetId };
};

const renderTake = async ({ shot, motion, sourceAssetId, refs, params, slot, seed, client, journal, reserve, attempt }) => {
  const nodeId = `shot:${shot.id}`;
  const reservation = await reserve({ nodeId, kind: 'take', units: shot.seconds, justification: `${sourceAssetId ? 'edit' : 'take'} for shot ${shot.id}, attempt ${attempt}` });
  const reservationId = reservationIdOf(reservation, nodeId);
  const refAssetIds = refs.map((r) => r.assetId);
  const intentId = await journal.intent('render.take', { nodeId, shotId: shot.id, attempt, mode: sourceAssetId ? 'edit' : 'generate', motion, sourceAssetId: sourceAssetId || null, refAssetIds, slot, params });
  let started;
  try {
    started = await animate(sourceAssetId
      ? { motion, videoRefUrls: [`asset://${sourceAssetId}`], refUrls: refs.map((r) => r.url), refAssetIds, duration: 'auto', ratio: null, resolution: params.resolution, generateAudio: params.audio, seed, modelKey: slot }
      : { motion, refUrls: refs.map((r) => r.url), refAssetIds, duration: shot.seconds, resolution: params.resolution, ratio: params.ratio, generateAudio: params.audio, seed, modelKey: slot }, { client });
  } catch (err) { await journal.result(intentId, { taskId: null, error: err.message }); throw err; }
  await journal.result(intentId, { taskId: started.taskId, promptUsed: started.prompt });
  const polled = await client.pollVideo({ taskId: started.taskId });
  const url = polled.videoCacheUrl || polled.videoUrl;
  const preserved = await post('/api/film/preserve', { url, name: `shot-${shot.id}-attempt${attempt}.mp4` });
  if (!preserved.assetId) throw new Error(`E-TAKE-NO-ASSET: shot ${shot.id} attempt ${attempt} could not be registered as an asset — an edit needs an asset id`);
  await journal.write('render.done', { nodeId, shotId: shot.id, attempt, taskId: started.taskId, url, assetId: preserved.assetId });
  await journal.cost({ nodeId, kind: 'take', units: shot.seconds, disposition: 'kept', shotId: shot.id, taskId: started.taskId, attempt, reservationId });
  await journal.media(`shot-${shot.id}-attempt${attempt}.mp4`, url);
  return { taskId: started.taskId, url, assetId: preserved.assetId, promptUsed: started.prompt, attempt, reservationId, sourceAssetId: sourceAssetId || null };
};

const judgeRound = async ({ shots, current, client, journal, reserve, round }) => {
  await reserve({ nodeId: 'judge', kind: 'reason', units: 1, justification: `judge round ${round}` });
  const system = [
    'You are the director reviewing every take of the film after QC. For each shot that did not pass, decide. Return ONLY a JSON object, no prose, no fences:',
    '{ "decisions": [{ "id": "<shot id>", "decision": "keep"|"edit"|"regenerate", "instruction": "<for edit: the exact change the video model applies to this clip keeping everything else; for regenerate: the corrected full prompt>", "reason": "<one sentence>" }] }',
    'keep means the take realizes the shot despite QC notes. edit when one concrete change fixes it. regenerate when it is wrong at its root. Think of the film as a whole: continuity of subject and place across shots matters.',
  ].join('\n');
  const prompt = shots.map((s) => {
    const c = current[s.id];
    return `SHOT ${s.id}: ${JSON.stringify({ subject: s.subject, force: s.force, change: s.change, setup: s.setup, seconds: s.seconds })}\nPROMPT: ${c.take.promptUsed}\nMEASURED: ${JSON.stringify(c.take.measure)}\nQC: ${JSON.stringify({ pass: c.qc.pass, score: c.qc.score, findings: c.qc.findings.map((f) => `${f.rule}: ${f.detail}`) })}`;
  }).join('\n\n');
  const { content } = await client.reason({ prompt, systemPrompt: system, nodeId: 'judge' });
  const parsed = json(content, 'the judgment');
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  for (const d of decisions) if (!['keep', 'edit', 'regenerate'].includes(d.decision) || (d.decision !== 'keep' && !String(d.instruction || '').trim())) throw new Error(`judgment for shot ${d.id} is malformed: ${JSON.stringify(d)}`);
  await journal.write('judgment', { round, decisions, prompt, response: content });
  return Object.fromEntries(decisions.map((d) => [String(d.id), d]));
};

export const runFilm = async ({ idea, style, seconds, policy, rules, client, journal, reserve, runId, refs, slot, onPlan }) => {
  need('onPlan', onPlan, (f) => typeof f === 'function');
  need('journal', journal, (j) => j && typeof j.write === 'function');
  need('reserve', reserve, (f) => typeof f === 'function');
  need('rules', rules, (r) => r && r.byId && r.byId['FILM-001']);
  need('policy.shots', policy?.shots, (v) => v && [v.min, v.max, v.secondsMin, v.secondsMax].every(Number.isInteger));
  need('policy.attempts.shot', policy?.attempts?.shot, Number.isInteger);
  need('policy.attempts.fault', policy?.attempts?.fault, Number.isInteger);
  need('policy.attempts.plate', policy?.attempts?.plate, Number.isInteger);
  need('policy.concurrency.chains', policy?.concurrency?.chains, Number.isInteger);
  need('policy.resume.backoffMs', policy?.resume?.backoffMs, Number.isInteger);
  need('refs', refs, Array.isArray);
  need('slot', slot, (s) => typeof s === 'string' && s);
  const window = { kMin: policy.shots.min, kMax: policy.shots.max, dMin: policy.shots.secondsMin, dMax: Math.min(policy.shots.secondsMax, maxShotSeconds(slot)) };
  need('style.format.resolution', style?.format?.resolution, (v) => typeof v === 'string' && v);
  need('style.format.ratio', style?.format?.ratio, (v) => typeof v === 'string' && v);
  const params = { resolution: style.format.resolution, ratio: style.format.ratio, audio: style.audio === true };

  let plan = null;
  let rejected = null;
  for (let attempt = 1; attempt <= policy.attempts.fault && !plan; attempt += 1) {
    const r = await planShots({ idea, style, seconds, window, refs, client, journal, reserve, attempt, rejected });
    if (r.plan) plan = r.plan; else rejected = r.problems.join('\n');
  }
  if (!plan) throw new Error(`E-PLAN-EXHAUSTED: no lawful plan in ${policy.attempts.fault} attempts — last problems: ${rejected}`);
  await onPlan(plan);

  const known = new Set(refs.map((r) => r.name));
  const allRefs = [...refs];
  for (const ref of plan.references.filter((r) => !known.has(r.name))) {
    const made = await renderReference({ ref, policy, client, journal, reserve, runId });
    if (made) allRefs.push(made);
  }
  await journal.write('references', { count: allRefs.length, names: allRefs.map((r) => r.name), assetIds: allRefs.map((r) => r.assetId) });
  const refsFor = (shot) => allRefs.filter((r) => r.role !== 'character' || r.name === shot.subject).slice(0, 30);

  const current = {};
  const history = Object.fromEntries(plan.shots.map((s) => [s.id, []]));
  const attemptOf = Object.fromEntries(plan.shots.map((s) => [s.id, 0]));
  const shootOne = async (shot, motion, sourceAssetId) => {
    attemptOf[shot.id] += 1;
    const attempt = attemptOf[shot.id];
    let faults = 0;
    let take = null;
    let text = motion;
    while (!take) {
      try {
        take = await renderTake({ shot, motion: text, sourceAssetId, refs: refsFor(shot), params, slot, seed: null, client, journal, reserve, attempt });
      } catch (err) {
        faults += 1;
        const kind = faultKind(err);
        await journal.write('fault', { node: `shot:${shot.id}`, shotId: shot.id, attempt, faults, budget: policy.attempts.fault, kind, reason: err.message });
        await journal.cost({ nodeId: `shot:${shot.id}`, kind: 'take', units: shot.seconds, disposition: 'refused', code: kind === 'refused' ? 'E-PROVIDER-REFUSED' : 'E-FAULT', shotId: shot.id, attempt, detail: err.message });
        if (faults >= policy.attempts.fault) return null;
        if (kind === 'refused') {
          await reserve({ nodeId: `shot:${shot.id}`, kind: 'reason', units: 1, justification: `rewrite after a provider refusal, shot ${shot.id}` });
          const { content } = await client.reason({ prompt: `THE SHOT: ${JSON.stringify(shot)}\n\nTHE REFUSED PROMPT: ${text}\n\nTHE PROVIDER SAID: ${err.message}`, systemPrompt: 'The video model refused this prompt. Rewrite it so the same beat renders without the refused element: keep subject, force, change and setup; describe people by role, build, wardrobe and expression, never by resemblance; no brands, logos, titles or on-screen text. Return ONLY {"prompt": "..."} as JSON.', nodeId: `shot:${shot.id}` });
          text = String(json(content, 'the rewrite').prompt || '').trim() || text;
          sourceAssetId = null;
          await journal.write('decision', { shotId: shot.id, attempt, decision: 'rewrite', instruction: text, reason: err.message });
        } else await sleep(policy.resume.backoffMs);
      }
    }
    let qc = null;
    let qcFaults = 0;
    while (!qc) {
      try {
        take.measure = take.measure || await measure(take.url);
        qc = await takeQC({ rules, shot, take, refs: refsFor(shot), client, journal, reserve, nodeId: `shot:${shot.id}` });
      } catch (err) {
        qcFaults += 1;
        await journal.write('fault', { node: `qc:${shot.id}`, shotId: shot.id, attempt, faults: qcFaults, budget: policy.attempts.fault, kind: 'transient', reason: err.message });
        if (qcFaults >= policy.attempts.fault) {
          await journal.finding({ finding_id: `fnd_${runId}_${shot.id}_a${attempt}_unjudged`, runId, at: new Date().toISOString(), family: 'fault', stage: 'qc', severity: 'blocker', code: 'E-TAKE-UNJUDGED', shotId: shot.id, attempt, detail: `shot ${shot.id} attempt ${attempt} could not be measured or judged after ${qcFaults} faults (${err.message}) — the paid take is kept unjudged`, evidence: [{ url: take.url, assetId: take.assetId }] });
          qc = { pass: false, score: null, findings: [{ rule: 'FILM-001', detail: `unjudged: ${err.message}` }], unjudged: true };
          break;
        }
        await sleep(policy.resume.backoffMs);
      }
    }
    const entry = { take, qc: { pass: qc.pass, score: qc.score, findings: qc.findings, unjudged: qc.unjudged === true } };
    history[shot.id].push(entry);
    current[shot.id] = entry;
    return entry;
  };
  const inParallel = async (jobs) => {
    const queue = [...jobs];
    await Promise.all(Array.from({ length: Math.min(policy.concurrency.chains, queue.length) }, async () => { while (queue.length) await queue.shift()(); }));
  };

  await journal.write('round', { round: 1, shots: plan.shots.map((s) => s.id), mode: 'generate' });
  await inParallel(plan.shots.map((shot) => () => shootOne(shot, shot.prompt, null)));

  for (let round = 2; round <= policy.attempts.shot; round += 1) {
    const open = plan.shots.filter((s) => current[s.id] && !current[s.id].qc.pass && !current[s.id].qc.unjudged);
    if (!open.length) break;
    const decisions = await judgeRound({ shots: open, current, client, journal, reserve, round });
    const jobs = [];
    for (const shot of open) {
      const d = decisions[shot.id];
      if (!d || d.decision === 'keep') { await journal.write('decision', { shotId: shot.id, round, decision: 'keep', reason: d?.reason || 'the judge returned no decision for this shot; the take stands' }); continue; }
      const src = current[shot.id].take;
      await journal.write('regeneration', { shotId: shot.id, round, attempt: attemptOf[shot.id] + 1, n: attemptOf[shot.id] + 1, mode: d.decision, cause: d.reason, instruction: d.instruction, sourceAssetId: d.decision === 'edit' ? src.assetId : null, ruleId: null, invalidatedShots: [] });
      await journal.cost({ nodeId: `shot:${shot.id}`, kind: 'take', units: shot.seconds, disposition: 'wasted', code: d.decision === 'edit' ? 'E-WASTE-EDITED' : 'E-WASTE-REGENERATED', shotId: shot.id, taskId: src.taskId, attempt: src.attempt, reservationId: src.reservationId, detail: d.reason });
      jobs.push(() => shootOne(shot, d.instruction, d.decision === 'edit' ? src.assetId : null));
    }
    if (!jobs.length) break;
    await journal.write('round', { round, shots: open.map((s) => s.id), mode: 'edit' });
    await inParallel(jobs);
  }

  const shipped = plan.shots.map((shot) => {
    const takes = history[shot.id];
    if (!takes.length) return { shot, entry: null };
    const passing = takes.filter((t) => t.qc.pass);
    const best = (passing.length ? passing : takes).sort((a, b) => (b.qc.score ?? -1) - (a.qc.score ?? -1))[0];
    return { shot, entry: best };
  });
  for (const s of shipped) {
    if (!s.entry) await journal.finding({ finding_id: `fnd_${runId}_${s.shot.id}_absent`, runId, at: new Date().toISOString(), family: 'shortfall', stage: 'shoot', severity: 'blocker', code: 'E-SHOT-ABSENT', shotId: s.shot.id, detail: `shot ${s.shot.id} never rendered`, evidence: [] });
    else if (!s.entry.qc.pass) await journal.finding({ finding_id: `fnd_${runId}_${s.shot.id}_exhausted`, runId, at: new Date().toISOString(), family: 'shortfall', stage: 'shoot', severity: 'blocker', code: 'E-SHOT-EXHAUSTED', shotId: s.shot.id, attempt: s.entry.take.attempt, detail: `shot ${s.shot.id} ships attempt ${s.entry.take.attempt} (score ${s.entry.qc.score}) without passing QC`, evidence: history[s.shot.id].map((t) => ({ attempt: t.take.attempt, url: t.take.url, score: t.qc.score, findings: t.qc.findings.map((f) => `${f.rule}: ${f.detail}`) })) });
    await journal.write('node', { id: `shot:${s.shot.id}`, status: 'done', attempt: s.entry?.take.attempt ?? null, takeId: s.entry?.take.taskId ?? null, url: s.entry?.take.url ?? null, shipped: s.entry ? (s.entry.qc.pass ? 'passed' : 'promote-best') : 'absent' });
  }
  const present = shipped.filter((s) => s.entry);
  if (!present.length) throw new Error('E-ASSEMBLE-NOTHING: no shot rendered');
  await journal.write('node', { id: 'assemble', status: 'running', shots: present.length });
  const stitched = await post('/api/film/stitch', { shots: present.map((s) => s.entry.take.url), name: `slice-${runId}` });
  const sliceUrl = stitched.cacheUrl || stitched.url;
  await journal.media('slice.mp4', sliceUrl);
  await journal.write('node', { id: 'assemble', status: 'done', url: sliceUrl });
  const m = await measure(sliceUrl);
  const timeline = filmTimingOf({ rules, seconds, shotCount: plan.shots.length, measured: m });
  await journal.write('final', { totalMeasured: m.duration, targetSeconds: seconds, fps: m.fps, tolerance: timeline.tolerance, delta: timeline.delta, pass: timeline.pass, rule: 'FILM-001' });
  if (!timeline.pass) await journal.finding({ finding_id: `fnd_${runId}_timeline`, runId, at: new Date().toISOString(), family: 'gate', stage: 'final', severity: 'blocker', code: 'FILM-001', ruleId: 'FILM-001', detail: timeline.detail, evidence: [{ totalMeasured: m.duration, targetSeconds: seconds }] });
  return {
    plan,
    references: allRefs,
    slice: { url: sliceUrl, totalMeasured: m.duration, fps: m.fps },
    shots: shipped.map((s) => ({ shotId: s.shot.id, seconds: s.shot.seconds, prompt: s.shot.prompt, takeId: s.entry?.take.taskId ?? null, assetId: s.entry?.take.assetId ?? null, url: s.entry?.take.url ?? null, attempts: history[s.shot.id].length, shipped: s.entry ? (s.entry.qc.pass ? 'passed' : 'promote-best') : 'absent', score: s.entry?.qc.score ?? null })),
  };
};
