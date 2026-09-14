import { animate } from '../utils/film/core/operations.js';
import { maxShotSeconds } from '../utils/film/suiteConfig.js';
import { reservationIdOf } from './director/policy.js';
import { filmTimingOf, measure, takeQC } from './film-qc.js';

const need = (name, value, ok) => { if (!ok(value)) throw new Error(`E-EXTEND-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}: the extension loop needs ${name}`); return value; };
const json = (content, what) => {
  const body = String(content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
  try { return JSON.parse(body); } catch (err) { throw new Error(`${what} is not JSON (${err.message})`); }
};
const REFUSAL = /copyright|sensitive|prohibited|policy|violat|not allowed|inappropriate|SensitiveContent|content/i;
const CONSTRAINT = /TaskTypeConstraint|duration|ratio/i;
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

export const shotWindow = ({ seconds, secondsMin, secondsMax }) => {
  const kMin = Math.ceil(seconds / secondsMax);
  const kMax = Math.floor(seconds / secondsMin);
  if (kMin > kMax) throw new Error(`E-EXTEND-SECONDS: ${seconds}s cannot be cut into shots of ${secondsMin}-${secondsMax}s`);
  return { kMin, kMax, dMin: secondsMin, dMax: secondsMax };
};

const planShots = async ({ idea, style, seconds, window, client, journal, reserve, attempt, rejected }) => {
  await reserve({ nodeId: 'plan', kind: 'reason', units: 1, justification: `plan the shots, attempt ${attempt}` });
  const system = [
    'You plan a short film as a chain of shots. The video model renders shot one from its prompt; every later shot is rendered as a continuation of the previous shot\'s footage, so each prompt must describe what happens NEXT, picking up exactly where the previous shot ends, with the same people in the same place unless the story moves them. Return ONLY a JSON object, no prose, no fences:',
    '{ "logline": "", "shots": [{ "id": "s1", "subject": "<who is in frame>", "force": "<the antagonism acting in this shot and how it is visible>", "change": "<state at the start -> state at the end>", "setup": "<camera setup>", "seconds": <integer>, "prompt": "<the full prompt: who, doing what, where, shot how, what changes; for shots after the first, begin with what continues from the previous shot>" }] }',
    '',
    `STRUCTURE IS LAW: between ${window.kMin} and ${window.kMax} shots; every shot ${window.dMin} to ${window.dMax} seconds; the seconds sum to exactly ${seconds}. The story turns; the opposition acts on screen. Write in English.`,
    `STYLE: ${JSON.stringify(style.look)}. Constraints: ${(style.constraints || []).join('; ') || 'none'}. ${(style.doctrine || []).join(' ')}`,
    'Describe people by role, build, wardrobe and expression, never by resemblance to anyone real; no brands, logos, titles or on-screen text.',
  ].join('\n');
  const prompt = `THE STORY:\n${idea}${rejected ? `\n\nYOUR LAST PLAN WAS REJECTED:\n${rejected}\n\nReturn the corrected JSON only.` : ''}`;
  const { content } = await client.reason({ prompt, systemPrompt: system, nodeId: 'plan' });
  const plan = json(content, 'the plan');
  const problems = [];
  if (!Array.isArray(plan.shots)) problems.push('"shots" must be an array');
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  if (shots.length < window.kMin || shots.length > window.kMax) problems.push(`${shots.length} shots; ${seconds}s allows ${window.kMin} to ${window.kMax}`);
  const sum = shots.reduce((a, s) => a + (Number.isInteger(s.seconds) ? s.seconds : 0), 0);
  if (sum !== seconds) problems.push(`the shots sum to ${sum}s, the target is ${seconds}s`);
  shots.forEach((s, i) => {
    if (!Number.isInteger(s.seconds) || s.seconds < window.dMin || s.seconds > window.dMax) problems.push(`shot ${s.id || i + 1}: ${JSON.stringify(s.seconds)}s is outside ${window.dMin}-${window.dMax}`);
    for (const k of ['id', 'subject', 'force', 'change', 'setup', 'prompt']) if (!String(s[k] || '').trim()) problems.push(`shot ${s.id || i + 1}: no ${k}`);
  });
  await journal.write('plan', { attempt, logline: plan.logline || null, shotCount: shots.length, shots: shots.map((s) => ({ id: String(s.id ?? ''), seconds: s.seconds, subject: s.subject, force: s.force, change: s.change, setup: s.setup })), seconds: sum, problems, prompt, response: content });
  if (problems.length) return { problems };
  return { plan: { logline: plan.logline || '', shots: shots.map((s) => ({ ...s, id: String(s.id) })) } };
};

const renderTake = async ({ shot, motion, previous, editOf, params, slot, client, journal, reserve, attempt, runId }) => {
  const nodeId = `shot:${shot.id}`;
  const reservation = await reserve({ nodeId, kind: 'take', units: shot.seconds, justification: `${editOf ? 'edit of' : previous ? 'extension for' : 'take for'} shot ${shot.id}, attempt ${attempt}` });
  const reservationId = reservationIdOf(reservation, nodeId);
  const source = editOf || previous || null;
  const mode = editOf ? 'edit' : previous ? 'extend' : 'generate';
  const request = (withDuration) => (source
    ? { motion, videoRefUrls: [`asset://${source}`], duration: withDuration ? shot.seconds : 'auto', ratio: withDuration ? params.ratio : null, resolution: params.resolution, generateAudio: params.audio, seed: null, modelKey: slot }
    : { motion, duration: shot.seconds, resolution: params.resolution, ratio: params.ratio, generateAudio: params.audio, seed: null, modelKey: slot });
  const intentId = await journal.intent('render.take', { nodeId, shotId: shot.id, attempt, mode, motion, sourceAssetId: source, slot, params, seconds: shot.seconds });
  let started;
  try {
    started = await animate(request(mode !== 'edit'), { client });
  } catch (err) {
    if (mode === 'extend' && CONSTRAINT.test(err.message)) {
      await journal.write('fault', { node: nodeId, shotId: shot.id, attempt, kind: 'constraint', reason: err.message, adaptation: 'the provider locks duration and ratio to the source clip; re-sent without them' });
      try { started = await animate(request(false), { client }); } catch (err2) { await journal.result(intentId, { taskId: null, error: err2.message }); throw err2; }
    } else { await journal.result(intentId, { taskId: null, error: err.message }); throw err; }
  }
  await journal.result(intentId, { taskId: started.taskId, promptUsed: started.prompt });
  const polled = await client.pollVideo({ taskId: started.taskId });
  const url = polled.videoCacheUrl || polled.videoUrl;
  const preserved = await post('/api/film/preserve', { url, name: `shot-${shot.id}-attempt${attempt}.mp4` });
  if (!preserved.assetId) throw new Error(`E-TAKE-NO-ASSET: shot ${shot.id} attempt ${attempt} could not be registered as an asset — the next shot extends from an asset id`);
  await journal.write('render.done', { nodeId, shotId: shot.id, attempt, mode, taskId: started.taskId, url, assetId: preserved.assetId, lastFrameUrl: polled.lastFrameCacheUrl || polled.lastFrameUrl || null });
  await journal.cost({ nodeId, kind: 'take', units: shot.seconds, disposition: 'kept', shotId: shot.id, taskId: started.taskId, attempt, reservationId });
  await journal.media(`shot-${shot.id}-attempt${attempt}.mp4`, url);
  return { taskId: started.taskId, url, assetId: preserved.assetId, promptUsed: started.prompt, attempt, reservationId, mode };
};

const judge = async ({ shot, entry, client, journal, reserve, attempt, budget }) => {
  const nodeId = `shot:${shot.id}`;
  await reserve({ nodeId, kind: 'reason', units: 1, justification: `judge shot ${shot.id}, attempt ${attempt}` });
  const system = [
    'You are the director judging one rendered take against its plan. Return ONLY a JSON object, no prose, no fences:',
    '{ "decision": "keep"|"edit"|"regenerate", "instruction": "<for edit: the exact change to apply to this clip keeping everything else; for regenerate: the corrected full prompt>", "reason": "<one sentence>" }',
    `keep: it realizes the shot. edit: one concrete change fixes it. regenerate: wrong at the root. This is attempt ${attempt} of ${budget}; the next shot will continue from whatever ships.`,
  ].join('\n');
  const prompt = `THE SHOT: ${JSON.stringify({ id: shot.id, subject: shot.subject, force: shot.force, change: shot.change, setup: shot.setup, seconds: shot.seconds })}\nPROMPT: ${entry.take.promptUsed}\nMEASURED: ${JSON.stringify(entry.take.measure)}\nQC: ${JSON.stringify({ pass: entry.qc.pass, score: entry.qc.score, findings: entry.qc.findings.map((f) => `${f.rule}: ${f.detail}`) })}`;
  const { content } = await client.reason({ prompt, systemPrompt: system, nodeId });
  const d = json(content, 'the judgment');
  if (!['keep', 'edit', 'regenerate'].includes(d.decision) || (d.decision !== 'keep' && !String(d.instruction || '').trim())) throw new Error(`the judgment for shot ${shot.id} is malformed: ${JSON.stringify(d)}`);
  await journal.write('decision', { shotId: shot.id, attempt, decision: d.decision, instruction: d.instruction || '', reason: d.reason || '', prompt, response: content });
  return d;
};

export const runExtend = async ({ idea, style, seconds, policy, rules, client, journal, reserve, runId, slot, onPlan }) => {
  need('journal', journal, (j) => j && typeof j.write === 'function');
  need('reserve', reserve, (f) => typeof f === 'function');
  need('rules', rules, (r) => r && r.byId && r.byId['FILM-001']);
  need('onPlan', onPlan, (f) => typeof f === 'function');
  need('policy.attempts.shot', policy?.attempts?.shot, Number.isInteger);
  need('policy.attempts.fault', policy?.attempts?.fault, Number.isInteger);
  need('policy.resume.backoffMs', policy?.resume?.backoffMs, Number.isInteger);
  need('policy.shots.secondsMin', policy?.shots?.secondsMin, Number.isInteger);
  need('policy.shots.secondsMax', policy?.shots?.secondsMax, Number.isInteger);
  need('style.format', style?.format?.resolution && style?.format?.ratio, Boolean);
  need('slot', slot, (s) => typeof s === 'string' && s);
  const window = shotWindow({ seconds, secondsMin: policy.shots.secondsMin, secondsMax: Math.min(policy.shots.secondsMax, maxShotSeconds(slot)) });
  await journal.write('window', { seconds, ...window });
  const params = { resolution: style.format.resolution, ratio: style.format.ratio, audio: style.audio === true };

  let plan = null;
  let rejected = null;
  for (let attempt = 1; attempt <= policy.attempts.fault && !plan; attempt += 1) {
    const r = await planShots({ idea, style, seconds, window, client, journal, reserve, attempt, rejected });
    if (r.plan) plan = r.plan; else rejected = r.problems.join('\n');
  }
  if (!plan) throw new Error(`E-PLAN-EXHAUSTED: no lawful plan in ${policy.attempts.fault} attempts — last problems: ${rejected}`);
  await onPlan(plan);

  const shipped = [];
  let previous = null;
  for (const shot of plan.shots) {
    const nodeId = `shot:${shot.id}`;
    const history = [];
    let motion = shot.prompt;
    let editOf = null;
    for (let attempt = 1; attempt <= policy.attempts.shot; attempt += 1) {
      await journal.write('node', { id: nodeId, status: 'running', attempt, extendsFrom: previous, editOf });
      let take = null;
      let faults = 0;
      while (!take) {
        try { take = await renderTake({ shot, motion, previous, editOf, params, slot, client, journal, reserve, attempt, runId }); } catch (err) {
          faults += 1;
          const kind = faultKind(err);
          await journal.write('fault', { node: nodeId, shotId: shot.id, attempt, faults, budget: policy.attempts.fault, kind, reason: err.message });
          await journal.cost({ nodeId, kind: 'take', units: shot.seconds, disposition: 'refused', code: kind === 'refused' ? 'E-PROVIDER-REFUSED' : 'E-FAULT', shotId: shot.id, attempt, detail: err.message });
          if (faults >= policy.attempts.fault) break;
          if (kind === 'refused') {
            await reserve({ nodeId, kind: 'reason', units: 1, justification: `rewrite after a provider refusal, shot ${shot.id}` });
            const { content } = await client.reason({ prompt: `THE SHOT: ${JSON.stringify(shot)}\n\nTHE REFUSED PROMPT: ${motion}\n\nTHE PROVIDER SAID: ${err.message}`, systemPrompt: 'The video model refused this prompt. Rewrite it so the same beat renders without the refused element: keep subject, force, change and setup; describe people by role, build, wardrobe and expression, never by resemblance; no brands, logos, titles or on-screen text. Return ONLY {"prompt": "..."} as JSON.', nodeId });
            motion = String(json(content, 'the rewrite').prompt || '').trim() || motion;
            editOf = null;
            await journal.write('decision', { shotId: shot.id, attempt, decision: 'rewrite', instruction: motion, reason: err.message });
          } else await sleep(policy.resume.backoffMs);
        }
      }
      if (!take) break;
      let qc = null;
      let qcFaults = 0;
      while (!qc) {
        try {
          take.measure = take.measure || await measure(take.url);
          qc = await takeQC({ rules, shot, take, refs: [], client, journal, reserve, nodeId });
        } catch (err) {
          qcFaults += 1;
          await journal.write('fault', { node: `qc:${shot.id}`, shotId: shot.id, attempt, faults: qcFaults, budget: policy.attempts.fault, kind: 'transient', reason: err.message });
          if (qcFaults >= policy.attempts.fault) { qc = { pass: false, score: null, findings: [{ rule: 'FILM-001', detail: `unjudged: ${err.message}` }], unjudged: true }; break; }
          await sleep(policy.resume.backoffMs);
        }
      }
      const entry = { take, qc: { pass: qc.pass, score: qc.score, findings: qc.findings, unjudged: qc.unjudged === true } };
      history.push(entry);
      if (qc.pass || qc.unjudged || attempt === policy.attempts.shot) break;
      const d = await judge({ shot, entry, client, journal, reserve, attempt, budget: policy.attempts.shot });
      if (d.decision === 'keep') break;
      await journal.write('regeneration', { shotId: shot.id, attempt: attempt + 1, n: attempt + 1, mode: d.decision, cause: d.reason, instruction: d.instruction, sourceAssetId: d.decision === 'edit' ? take.assetId : null, ruleId: null, invalidatedShots: [] });
      await journal.cost({ nodeId, kind: 'take', units: shot.seconds, disposition: 'wasted', code: d.decision === 'edit' ? 'E-WASTE-EDITED' : 'E-WASTE-REGENERATED', shotId: shot.id, taskId: take.taskId, attempt, reservationId: take.reservationId, detail: d.reason });
      motion = d.instruction;
      editOf = d.decision === 'edit' ? take.assetId : null;
    }
    if (!history.length) {
      await journal.finding({ finding_id: `fnd_${runId}_${shot.id}_absent`, runId, at: new Date().toISOString(), family: 'shortfall', stage: 'shoot', severity: 'blocker', code: 'E-SHOT-ABSENT', shotId: shot.id, detail: `shot ${shot.id} never rendered — the chain continues from the previous take`, evidence: [] });
      await journal.write('node', { id: nodeId, status: 'done', attempt: null, takeId: null, url: null, shipped: 'absent' });
      shipped.push({ shot, entry: null });
      continue;
    }
    const passing = history.filter((t) => t.qc.pass);
    const best = (passing.length ? passing : history).sort((a, b) => (b.qc.score ?? -1) - (a.qc.score ?? -1))[0];
    if (!best.qc.pass) await journal.finding({ finding_id: `fnd_${runId}_${shot.id}_exhausted`, runId, at: new Date().toISOString(), family: 'shortfall', stage: 'shoot', severity: 'blocker', code: 'E-SHOT-EXHAUSTED', shotId: shot.id, attempt: best.take.attempt, detail: `shot ${shot.id} ships attempt ${best.take.attempt} (score ${best.qc.score}) without passing QC`, evidence: history.map((t) => ({ attempt: t.take.attempt, url: t.take.url, score: t.qc.score, findings: t.qc.findings.map((f) => `${f.rule}: ${f.detail}`) })) });
    await journal.write('node', { id: nodeId, status: 'done', attempt: best.take.attempt, takeId: best.take.taskId, assetId: best.take.assetId, url: best.take.url, shipped: best.qc.pass ? 'passed' : 'promote-best' });
    shipped.push({ shot, entry: best });
    previous = best.take.assetId;
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
    references: [],
    slice: { url: sliceUrl, totalMeasured: m.duration, fps: m.fps },
    shots: shipped.map((s) => ({ shotId: s.shot.id, seconds: s.shot.seconds, prompt: s.shot.prompt, takeId: s.entry?.take.taskId ?? null, assetId: s.entry?.take.assetId ?? null, url: s.entry?.take.url ?? null, attempts: s.entry ? s.entry.take.attempt : 0, shipped: s.entry ? (s.entry.qc.pass ? 'passed' : 'promote-best') : 'absent', score: s.entry?.qc.score ?? null })),
  };
};
