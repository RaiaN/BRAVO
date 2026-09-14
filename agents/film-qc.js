import fs from 'node:fs';

const IDS = ['FILM-001', 'FILM-002', 'FILM-003', 'FILM-004', 'FILM-005'];

export const loadFilmRules = (file) => {
  if (!fs.existsSync(file)) throw new Error(`E-RULES-MISSING: ${file} — the film loop refuses to judge without its five rules`);
  const book = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rules = Array.isArray(book.rules) ? book.rules : [];
  const ids = rules.map((r) => r.id);
  for (const id of IDS) if (!ids.includes(id)) throw new Error(`E-RULES-INCOMPLETE: ${file} lacks ${id}`);
  if (rules.length !== IDS.length) throw new Error(`E-RULES-TOO-MANY: ${file} carries ${rules.length} rules; the film loop judges by exactly five`);
  for (const r of rules) {
    for (const k of ['id', 'title', 'statement', 'class', 'params', 'provenance', 'status']) if (!(k in r)) throw new Error(`E-RULES-SHAPE: ${r.id || '?'} lacks ${k}`);
    if (!['measure', 'judgment'].includes(r.class)) throw new Error(`E-RULES-CLASS: ${r.id} is ${JSON.stringify(r.class)}`);
    if (!r.provenance?.origin) throw new Error(`E-RULES-PROVENANCE: ${r.id} names no origin`);
    if (r.provenance.origin === 'note' && !(r.provenance.iteration && r.provenance.note)) throw new Error(`E-RULES-PROVENANCE: ${r.id} is learned but names no iteration and note`);
  }
  const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  return { version: book.version, rules, byId, doctrine: () => rules.map((r) => `${r.id} ${r.title}: ${r.statement}`).join('\n') };
};

const post = async (route, body) => {
  const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`E-ROUTE-${res.status}: POST ${route} answered HTTP ${res.status} with a non-JSON body — restart the dev server if the route is new`); }
  if (!res.ok) throw new Error(data.details || data.error || `${route} failed (HTTP ${res.status})`);
  return data;
};

export const measure = (url) => post('/api/film/measure', { url, hashes: false });

const hamming = (a, b) => { if (!a || !b || a.length !== b.length) return null; let d = 0; for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1; return d; };

export const timingOf = ({ rules, shot, measured }) => {
  const p = rules.byId['FILM-001'].params;
  const problems = [];
  if (Math.round(measured.fps) !== p.fps) problems.push(`decodes at ${measured.fps} fps, the declared rate is ${p.fps}`);
  if (measured.duration < shot.seconds) problems.push(`measures ${measured.duration}s for a ${shot.seconds}s shot — short`);
  if (measured.duration - shot.seconds > p.perShotOvershoot) problems.push(`overshoots by ${(measured.duration - shot.seconds).toFixed(3)}s, allowance ${p.perShotOvershoot}s`);
  return { pass: problems.length === 0, problems };
};

export const filmTimingOf = ({ rules, seconds, shotCount, measured }) => {
  const p = rules.byId['FILM-001'].params;
  const tolerance = Math.max(p.toleranceBase, p.tolerancePerShot * shotCount);
  const delta = Math.abs(measured.duration - seconds);
  return { pass: delta <= tolerance, tolerance, delta, detail: delta <= tolerance ? null : `the film measures ${measured.duration}s against ${seconds}s (tolerance ${tolerance.toFixed(2)}s)` };
};

const sampleFrames = async ({ url, seconds, count }) => {
  const timestamps = Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * seconds / count) * 100) / 100);
  const { frames } = await post('/api/film/frames', { url, timestamps, maxWidth: 512 });
  const stats = [];
  for (const f of frames) stats.push({ ...f, ...(await post('/api/film/image-stats', { url: f.url })) });
  return stats;
};

const measuredImage = ({ rules, frames }) => {
  const p = rules.byId['FILM-002'].params;
  const problems = [];
  const black = frames.filter((f) => f.meanLuma < p.blackLuma);
  if (black.length) problems.push(`${black.length} black frame(s) at ${black.map((f) => f.t + 's').join(', ')}`);
  let run = 1;
  for (let i = 1; i < frames.length; i += 1) {
    run = hamming(frames[i - 1].dhash, frames[i].dhash) === 0 ? run + 1 : 1;
    if (run >= p.frozenFrames) { problems.push(`frozen from ${frames[i - run + 1].t}s to ${frames[i].t}s`); break; }
  }
  return problems;
};

const QUESTIONS = [
  { rule: 'FILM-002', id: 'clean', text: 'Is the image clean: no broken anatomy, no morphing between things, no garbled writing, no unplanned stranger?' },
  { rule: 'FILM-003', id: 'change', text: 'Does the state at the end differ from the state at the start in the way the plan declared?' },
  { rule: 'FILM-004', id: 'force', text: 'Is the named force visibly acting against the subject on screen?' },
  { rule: 'FILM-005', id: 'hold', text: 'Does the subject look like its reference image, and does the place look like the same place as the reference?' },
];

export const takeQC = async ({ rules, shot, take, refs, client, journal, reserve, nodeId }) => {
  const timing = timingOf({ rules, shot, measured: take.measure });
  const frames = await sampleFrames({ url: take.url, seconds: take.measure.duration, count: 6 });
  const imageProblems = measuredImage({ rules, frames });
  await reserve({ nodeId, kind: 'judge', units: 1, justification: `QC for shot ${shot.id}, attempt ${take.attempt}` });
  const system = [
    'You are the QC judge for one rendered take. Answer each question yes or no with the frame index (0-based) that shows it and one sentence. Return ONLY a JSON object, no prose, no fences:',
    `{ ${QUESTIONS.map((q) => `"${q.id}": { "yes": true|false, "frame": <index>, "note": "<one sentence>" }`).join(', ')} }`,
    '',
    'The first images are the reference assets the take was rendered with; the rest are frames of the take in time order.',
    'Judge only what is visible. Do not infer from the plan text what you cannot see.',
  ].join('\n');
  const prompt = [
    `THE PLAN FOR THIS SHOT: ${JSON.stringify({ subject: shot.subject, force: shot.force, change: shot.change, setup: shot.setup })}`,
    `REFERENCE IMAGES: ${refs.length} (${refs.map((r) => r.name).join(', ') || 'none'})`,
    `FRAMES: ${frames.length}, at ${frames.map((f) => f.t + 's').join(', ')}`,
    ...QUESTIONS.map((q, i) => `${i + 1}. [${q.id}] ${q.text}`),
  ].join('\n');
  const { content } = await client.reason({ prompt, systemPrompt: system, images: [...refs.map((r) => r.url), ...frames.map((f) => f.url)], nodeId });
  let answers;
  try { answers = JSON.parse(String(content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim()); } catch (err) { throw new Error(`the QC answer is not JSON (${err.message})`); }
  const findings = [];
  if (!timing.pass) findings.push({ rule: 'FILM-001', detail: timing.problems.join('; ') });
  for (const p of imageProblems) findings.push({ rule: 'FILM-002', detail: p });
  for (const q of QUESTIONS) {
    const a = answers?.[q.id];
    if (!a || typeof a.yes !== 'boolean') throw new Error(`the QC answer for ${q.id} is malformed: ${JSON.stringify(a)}`);
    if (!a.yes) findings.push({ rule: q.rule, detail: `${q.id}: ${a.note || 'no'}${Number.isInteger(a.frame) ? ` (frame ${a.frame}, ${frames[a.frame]?.t ?? '?'}s)` : ''}` });
  }
  const pass = findings.length === 0;
  const score = Math.round(((QUESTIONS.length - findings.filter((f) => f.rule !== 'FILM-001').length) / QUESTIONS.length) * 1000) / 1000;
  await journal.write('qc.take', { shotId: shot.id, attempt: take.attempt, pass, score, timing, frames: frames.map((f) => ({ t: f.t, url: f.url, meanLuma: f.meanLuma })), answers, findings, prompt, response: content });
  return { pass, score, findings, frames };
};

export const referenceQC = async ({ ref, url, client, journal, reserve, nodeId }) => {
  await reserve({ nodeId, kind: 'judge', units: 1, justification: `QC for reference ${ref.name}` });
  const system = 'You are the QC judge for one reference still. Answer yes or no with one sentence. Return ONLY a JSON object, no prose, no fences: { "matches": { "yes": true|false, "note": "" }, "clean": { "yes": true|false, "note": "" } }';
  const prompt = `THE REFERENCE: ${JSON.stringify({ name: ref.name, role: ref.role, prompt: ref.prompt })}\n1. [matches] Does the image show what the prompt describes (a ${ref.role}, on a neutral background when it is a character sheet)?\n2. [clean] Is the image free of broken anatomy, garbled writing and stray objects?`;
  const { content } = await client.reason({ prompt, systemPrompt: system, images: [url], nodeId });
  let a;
  try { a = JSON.parse(String(content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim()); } catch (err) { throw new Error(`the reference QC answer is not JSON (${err.message})`); }
  const pass = a?.matches?.yes === true && a?.clean?.yes === true;
  await journal.write('qc.reference', { name: ref.name, pass, answers: a, prompt, response: content });
  return { pass, score: pass ? 1 : 0, answers: a };
};
