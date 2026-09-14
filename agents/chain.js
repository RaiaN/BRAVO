import { animate } from '../utils/film/core/operations.js';

const json = (content, what) => {
  const body = String(content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
  try { return JSON.parse(body); } catch (err) { throw new Error(`${what} is not JSON (${err.message})`); }
};
const post = async (route, body) => {
  const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`E-ROUTE-${res.status}: POST ${route} answered a non-JSON body`); }
  if (!res.ok) throw new Error(data.details || data.error || `${route} failed (HTTP ${res.status})`);
  return data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONSTRAINT = /TaskTypeConstraint|duration|ratio/i;

const plan = async ({ idea, style, seconds, dMin, dMax, client, journal }) => {
  const kMin = Math.ceil(seconds / dMax);
  const kMax = Math.floor(seconds / dMin);
  if (kMin > kMax) throw new Error(`E-SECONDS: ${seconds}s cannot be cut into ${dMin}-${dMax}s shots`);
  const system = [
    'You plan a short film as a chain of shots. The video model renders shot one from its prompt; every later shot is rendered as a continuation of the previous shot\'s footage, so each prompt describes what happens NEXT, picking up exactly where the previous shot ends. Return ONLY a JSON object, no prose, no fences:',
    '{ "logline": "", "shots": [{ "id": "s1", "seconds": <integer>, "prompt": "<who, doing what, where, shot how, what changes; for shots after the first, begin with what continues from the previous shot>" }] }',
    `Between ${kMin} and ${kMax} shots, each ${dMin} to ${dMax} seconds, summing to exactly ${seconds}. Write in English. Style: ${JSON.stringify(style.look)}. Describe people by role, build, wardrobe and expression, never by resemblance to anyone real; no brands, logos, titles or on-screen text.`,
  ].join('\n');
  let rejected = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { content } = await client.reason({ prompt: `THE STORY:\n${idea}${rejected ? `\n\nYOUR LAST PLAN WAS REJECTED:\n${rejected}\n\nReturn the corrected JSON only.` : ''}`, systemPrompt: system });
    const p = json(content, 'the plan');
    const shots = Array.isArray(p.shots) ? p.shots : [];
    const sum = shots.reduce((a, s) => a + (Number.isInteger(s.seconds) ? s.seconds : 0), 0);
    const problems = [];
    if (shots.length < kMin || shots.length > kMax) problems.push(`${shots.length} shots; allowed ${kMin}-${kMax}`);
    if (sum !== seconds) problems.push(`shots sum to ${sum}s, target ${seconds}s`);
    shots.forEach((s, i) => { if (!Number.isInteger(s.seconds) || s.seconds < dMin || s.seconds > dMax) problems.push(`shot ${i + 1}: ${JSON.stringify(s.seconds)}s outside ${dMin}-${dMax}`); if (!String(s.prompt || '').trim()) problems.push(`shot ${i + 1}: no prompt`); });
    await journal.write('plan', { attempt, logline: p.logline || null, shots: shots.map((s, i) => ({ id: String(s.id || `s${i + 1}`), seconds: s.seconds, prompt: s.prompt })), problems, prompt: idea, response: content });
    if (!problems.length) return { logline: p.logline || '', shots: shots.map((s, i) => ({ id: String(s.id || `s${i + 1}`), seconds: s.seconds, prompt: s.prompt })) };
    rejected = problems.join('\n');
  }
  throw new Error(`E-PLAN: no lawful plan in 3 attempts — ${rejected}`);
};

const render = async ({ shot, previous, params, slot, client, journal, attempt }) => {
  const nodeId = `shot:${shot.id}`;
  const request = (withDuration) => (previous
    ? { motion: shot.prompt, videoRefUrls: [`asset://${previous}`], duration: withDuration ? shot.seconds : 'auto', ratio: withDuration ? params.ratio : null, resolution: params.resolution, generateAudio: params.audio, modelKey: slot }
    : { motion: shot.prompt, duration: shot.seconds, resolution: params.resolution, ratio: params.ratio, generateAudio: params.audio, modelKey: slot });
  const intentId = await journal.intent('render.take', { nodeId, shotId: shot.id, attempt, mode: previous ? 'extend' : 'generate', motion: shot.prompt, sourceAssetId: previous || null, seconds: shot.seconds });
  let started;
  try { started = await animate(request(true), { client }); } catch (err) {
    if (previous && CONSTRAINT.test(err.message)) {
      await journal.write('fault', { node: nodeId, kind: 'constraint', reason: err.message, adaptation: 're-sent without duration and ratio' });
      started = await animate(request(false), { client });
    } else { await journal.result(intentId, { error: err.message }); throw err; }
  }
  await journal.result(intentId, { taskId: started.taskId, promptUsed: started.prompt });
  const polled = await client.pollVideo({ taskId: started.taskId });
  const url = polled.videoCacheUrl || polled.videoUrl;
  const preserved = await post('/api/film/preserve', { url, name: `shot-${shot.id}-attempt${attempt}.mp4` });
  if (!preserved.assetId) throw new Error(`E-TAKE-NO-ASSET: shot ${shot.id} could not be registered as an asset`);
  await journal.write('render.done', { nodeId, shotId: shot.id, attempt, taskId: started.taskId, url, assetId: preserved.assetId });
  await journal.media(`shot-${shot.id}-attempt${attempt}.mp4`, url);
  return { taskId: started.taskId, url, assetId: preserved.assetId };
};

export const runChain = async ({ idea, style, seconds, client, journal, runId, slot = 'seedance25', dMin = 20, dMax = 30, attempts = 3, backoffMs = 20000 }) => {
  const params = { resolution: style.format.resolution, ratio: style.format.ratio, audio: style.audio === true };
  const p = await plan({ idea, style, seconds, dMin, dMax, client, journal });
  const takes = [];
  let previous = null;
  for (const shot of p.shots) {
    await journal.write('node', { id: `shot:${shot.id}`, status: 'running', extendsFrom: previous });
    let take = null;
    for (let attempt = 1; attempt <= attempts && !take; attempt += 1) {
      try { take = await render({ shot, previous, params, slot, client, journal, attempt }); } catch (err) {
        await journal.write('fault', { node: `shot:${shot.id}`, shotId: shot.id, attempt, reason: err.message });
        if (attempt < attempts) await sleep(backoffMs);
      }
    }
    if (!take) { await journal.write('node', { id: `shot:${shot.id}`, status: 'done', shipped: 'absent' }); continue; }
    await journal.write('node', { id: `shot:${shot.id}`, status: 'done', shipped: 'rendered', takeId: take.taskId, assetId: take.assetId, url: take.url });
    takes.push({ shot, take });
    previous = take.assetId;
  }
  if (!takes.length) throw new Error('E-NOTHING: no shot rendered');
  await journal.write('node', { id: 'assemble', status: 'running' });
  const stitched = await post('/api/film/stitch', { shots: takes.map((t) => t.take.url), name: `slice-${runId}` });
  const sliceUrl = stitched.cacheUrl || stitched.url;
  await journal.media('slice.mp4', sliceUrl);
  const m = await post('/api/film/measure', { url: sliceUrl, hashes: false });
  await journal.write('node', { id: 'assemble', status: 'done', url: sliceUrl });
  await journal.write('final', { totalMeasured: m.duration, targetSeconds: seconds, fps: m.fps });
  return { plan: p, slice: { url: sliceUrl, totalMeasured: m.duration, fps: m.fps }, shots: takes.map((t) => ({ shotId: t.shot.id, seconds: t.shot.seconds, url: t.take.url, assetId: t.take.assetId })) };
};
