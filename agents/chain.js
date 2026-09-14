import { getModel } from '../utils/film/suiteConfig.js';
import { fill } from './persona.js';

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

const render = async ({ shot, prompt, variant, previous, params, slot, journal, client, attempt }) => {
  const nodeId = `shot:${shot.id}`;
  const model = getModel(slot);
  const text = previous ? `Extend @Video 1 by ${shot.seconds} seconds. ${prompt}` : prompt;
  const sourceRef = previous ? (previous.assetId ? `asset://${previous.assetId}` : previous.url) : null;
  const content = previous
    ? [{ type: 'text', text }, { type: 'video_url', video_url: { url: sourceRef }, role: 'reference_video' }]
    : [{ type: 'text', text }];
  const body = { model, content, resolution: params.resolution, ratio: previous ? 'adaptive' : params.ratio, duration: shot.seconds, generate_audio: params.audio, watermark: false, return_last_frame: true, output_format: 'mov' };
  const intentId = await journal.intent('render.take', { nodeId, shotId: shot.id, attempt, variant, mode: previous ? 'extend' : 'generate', sourceRef, body });
  let started;
  try {
    started = await post('/api/seedance', body);
  } catch (err) { await journal.result(intentId, { error: err.message }); throw err; }
  const taskId = started.id || started.task_id;
  if (!taskId) throw new Error('E-SEEDANCE: no task id returned');
  await journal.result(intentId, { taskId });
  const polled = await client.pollVideo({ taskId });
  await journal.write('render.polled', { nodeId, shotId: shot.id, attempt, variant, taskId, videoUrl: polled.videoUrl, videoCacheUrl: polled.videoCacheUrl || null, lastFrameUrl: polled.lastFrameUrl || null });
  return { taskId, variant, prompt, file: `shot-${shot.id}-attempt${attempt}-v${variant}.mov`, url: polled.videoCacheUrl || polled.videoUrl, providerUrl: polled.videoUrl };
};

const register = async ({ shot, take, journal, attempt }) => {
  const nodeId = `shot:${shot.id}`;
  const res = await fetch(take.url);
  if (!res.ok) throw new Error(`E-TAKE-FETCH: the take at ${take.url} responded ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await journal.media(take.file, bytes);
  const dataUrl = `data:video/quicktime;base64,${bytes.toString('base64')}`;
  let uploaded = null;
  for (let tryN = 1; tryN <= 3 && !uploaded?.assetId; tryN += 1) {
    if (tryN > 1) await sleep(5000);
    uploaded = await post('/api/film/upload', { dataUrl, name: take.file });
    await journal.write('render.registered', { nodeId, shotId: shot.id, attempt, variant: take.variant, try: tryN, bytes: bytes.length, response: uploaded });
  }
  const stableUrl = uploaded?.cacheUrl || uploaded?.url || take.url;
  if (!uploaded?.assetId) {
    await journal.write('fault', { node: nodeId, shotId: shot.id, attempt, variant: take.variant, kind: 'asset-registration', reason: `the Assets API registered no asset for shot ${shot.id} variant ${take.variant} in 3 tries (the dev-server log line "[film/upload] Assets API registration skipped:" holds the provider's reason); if this take is chosen, the next shot extends from its url instead of an asset id`, response: uploaded });
  }
  await journal.write('render.done', { nodeId, shotId: shot.id, attempt, variant: take.variant, taskId: take.taskId, url: take.url, stableUrl, assetId: uploaded?.assetId || null });
  return { url: stableUrl, assetId: uploaded?.assetId || null };
};

const variate = async ({ shot, previous, idea, candidates, client, journal, attempt }) => {
  const system = [
    `You rewrite one shot description of a film into ${candidates} distinct variants for a video model. Every variant keeps the same people, place, action and duration and, when the shot continues previous footage, keeps that continuity; they differ in wording, camera treatment, light, blocking detail and the small beats that make the moment interesting. Return ONLY a JSON object, no prose, no fences:`,
    '{ "prompts": ["", ""] }',
    'Write in English. Describe people by role, build, wardrobe and expression, never by resemblance to anyone real. Never name brands, products, titles, artworks, characters, songs, celebrities or any on-screen text; a video model refuses prompts that resemble protected material, so keep everything generic and original.',
  ].join('\n');
  let rejected = null;
  for (let ask = 1; ask <= 3; ask += 1) {
    const { content } = await client.reason({ prompt: `THE STORY:\n${idea}\n\nTHE SHOT (${shot.seconds}s${previous ? ', continues the previous shot' : ', opens the film'}):\n${shot.prompt}${rejected ? `\n\nYOUR LAST ANSWER WAS REJECTED:\n${rejected}\n\nReturn the corrected JSON only.` : ''}`, systemPrompt: system });
    const v = json(content, 'the variants');
    const prompts = Array.isArray(v.prompts) ? v.prompts.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const problems = prompts.length === candidates ? [] : [`${prompts.length} prompts; need exactly ${candidates}`];
    await journal.write('variate', { shotId: shot.id, attempt, ask, prompts, problems, response: content });
    if (!problems.length) return prompts;
    rejected = problems.join('\n');
  }
  throw new Error(`E-VARIATE: no lawful variants for shot ${shot.id} in 3 asks`);
};

const review = async ({ shot, take, idea, logline, persona, client, journal, attempt }) => {
  const { content } = await client.reason({
    prompt: fill(persona.review, { logline, story: idea, seconds: shot.seconds, shot: shot.prompt, prompt: take.prompt }),
    systemPrompt: persona.system,
    video: take.providerUrl,
  });
  const r = json(content, `Persona's review of variant ${take.variant}`);
  const score = Number(r.score);
  if (!Number.isFinite(score)) throw new Error(`E-PERSONA: variant ${take.variant} review has no numeric score`);
  const notes = String(r.notes || '');
  await journal.write('persona.review', { shotId: shot.id, attempt, variant: take.variant, file: take.file, score, notes, response: content });
  return { variant: take.variant, score, notes };
};

const choose = async ({ shot, candidates, logline, persona, client, journal, attempt }) => {
  let chosen = null; let reason = '';
  if (candidates.length === 1) { chosen = candidates[0]; reason = 'the only take that rendered'; } else {
    const { content } = await client.reason({
      prompt: fill(persona.choice, { logline, seconds: shot.seconds, shot: shot.prompt, reviews: candidates.map((c) => `variant ${c.variant} — score ${c.review.score} — ${c.review.notes}`).join('\n') }),
      systemPrompt: persona.system,
    });
    const d = json(content, "Persona's choice");
    chosen = candidates.find((c) => c.variant === Number(d.variant)) || null;
    if (!chosen) throw new Error(`E-PERSONA: chose variant ${JSON.stringify(d.variant)}, which did not render`);
    reason = String(d.reason || '');
  }
  await journal.write('persona.choice', { shotId: shot.id, attempt, variant: chosen.variant, file: chosen.file, reason, reviews: candidates.map((c) => c.review) });
  return chosen;
};

const renderShot = async ({ shot, previous, prompts, idea, logline, persona, params, slot, client, journal, attempt }) => {
  const settled = await Promise.allSettled(prompts.map(async (prompt, i) => {
    const take = await render({ shot, prompt, variant: i + 1, previous, params, slot, client, journal, attempt });
    const [registered, reviewed] = await Promise.all([
      register({ shot, take, journal, attempt }),
      review({ shot, take, idea, logline, persona, client, journal, attempt }),
    ]);
    return { ...take, ...registered, review: reviewed };
  }));
  const candidates = [];
  for (const [i, r] of settled.entries()) {
    if (r.status === 'fulfilled') candidates.push(r.value);
    else await journal.write('fault', { node: `shot:${shot.id}`, shotId: shot.id, attempt, variant: i + 1, reason: r.reason?.message || String(r.reason) });
  }
  if (!candidates.length) throw new Error(`E-SHOT: none of ${prompts.length} variants made it to Persona`);
  return choose({ shot, candidates, logline, persona, client, journal, attempt });
};

export const runChain = async ({ idea, style, seconds, client, journal, runId, slot = 'seedance25', dMin = 20, dMax = 30, attempts = 3, backoffMs = 20000, candidates = 5, persona }) => {
  if (!persona) throw new Error('E-PERSONA: runChain needs the persona configuration');
  const params = { resolution: style.format.resolution, ratio: style.format.ratio, audio: style.audio === true };
  const p = await plan({ idea, style, seconds, dMin, dMax, client, journal });
  const firstVariants = await Promise.all(p.shots.map((shot, i) => variate({ shot, previous: i > 0, idea, candidates, client, journal, attempt: 1 })));
  const takes = [];
  let previous = null;
  for (const [i, shot] of p.shots.entries()) {
    await journal.write('node', { id: `shot:${shot.id}`, status: 'running', extendsFrom: previous });
    let take = null;
    for (let attempt = 1; attempt <= attempts && !take; attempt += 1) {
      try {
        const prompts = attempt === 1 ? firstVariants[i] : await variate({ shot, previous: i > 0, idea, candidates, client, journal, attempt });
        take = await renderShot({ shot, previous, prompts, idea, logline: p.logline, persona, params, slot, client, journal, attempt });
      } catch (err) {
        await journal.write('fault', { node: `shot:${shot.id}`, shotId: shot.id, attempt, reason: err.message });
        if (attempt < attempts) await sleep(backoffMs);
      }
    }
    if (!take) { await journal.write('node', { id: `shot:${shot.id}`, status: 'done', shipped: 'absent' }); continue; }
    await journal.write('node', { id: `shot:${shot.id}`, status: 'done', shipped: 'rendered', takeId: take.taskId, variant: take.variant, file: take.file, assetId: take.assetId, url: take.url });
    takes.push({ shot, take });
    previous = { assetId: take.assetId, url: take.url };
  }
  if (!takes.length) throw new Error('E-NOTHING: no shot rendered');
  await journal.write('node', { id: 'assemble', status: 'running' });
  const stitched = await post('/api/film/stitch', { shots: takes.map((t) => t.take.url), name: `slice-${runId}` });
  const sliceUrl = stitched.cacheUrl || stitched.url;
  const [, m] = await Promise.all([journal.media('slice.mp4', sliceUrl), post('/api/film/measure', { url: sliceUrl, hashes: false })]);
  await journal.write('node', { id: 'assemble', status: 'done', url: sliceUrl });
  await journal.write('final', { totalMeasured: m.duration, targetSeconds: seconds, fps: m.fps });
  return { plan: p, slice: { url: sliceUrl, totalMeasured: m.duration, fps: m.fps }, shots: takes.map((t) => ({ shotId: t.shot.id, seconds: t.shot.seconds, url: t.take.url, assetId: t.take.assetId })) };
};
