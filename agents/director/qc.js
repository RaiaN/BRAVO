import { CHECKS } from './gates.js';
import { fillQuestion, authorityOf, passesOf, BINARY_ANSWERS } from './rubrics.js';

const FRAMES_PER_REQUEST = 30;
const JOIN_TYPES = ['cut', 'continuous'];

const round3 = (v) => Math.round(v * 1000) / 1000;

const post = async (route, body) => {
  const res = await fetch(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`E-ROUTE-${res.status}: POST ${route} answered HTTP ${res.status} with a non-JSON body (${text.slice(0, 40).replace(/\s+/g, ' ')}…) — the server does not serve this route; a dev server started before the route existed must be restarted`);
  }
  if (!res.ok) throw new Error(data.details || data.error || `${route} failed (HTTP ${res.status})`);
  return data;
};

export const measureUrl = (url, hashes) => post('/api/film/measure', { url, hashes });

export const imageStats = async (url) => {
  const s = await post('/api/film/image-stats', { url });
  for (const k of ['width', 'height', 'meanLuma', 'blur']) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) throw new Error(`image-stats of ${url}: ${k} is ${JSON.stringify(s[k])}`);
  }
  if (!/^[01]{64}$/.test(String(s.dhash))) throw new Error(`image-stats of ${url}: dhash is ${JSON.stringify(s.dhash)}`);
  return s;
};

export const extractFrames = async (url, timestamps, maxWidth) => {
  if (!Array.isArray(timestamps) || !timestamps.length) throw new Error(`frames of ${url}: no timestamps`);
  if (typeof maxWidth !== 'number') throw new Error(`frames of ${url}: maxWidth is required`);
  const out = [];
  for (let i = 0; i < timestamps.length; i += FRAMES_PER_REQUEST) {
    const chunk = timestamps.slice(i, i + FRAMES_PER_REQUEST);
    const { frames } = await post('/api/film/frames', { url, timestamps: chunk, maxWidth });
    if (!Array.isArray(frames) || frames.length !== chunk.length) {
      throw new Error(`frames of ${url}: asked ${chunk.length} timestamps, got ${Array.isArray(frames) ? frames.length : 'none'} — a frame the judge cannot see is a broken take, not a shorter one`);
    }
    out.push(...frames.map((f, j) => ({ t: chunk[j], url: f.url })));
  }
  return out;
};

export const hamming = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.length || a.length !== b.length) {
    throw new Error(`hamming: hashes must be equal-length strings, got ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
  return d;
};

export const sampleTimestamps = (duration, fps, offset = 0) => {
  if (!(duration > 0)) throw new Error(`sampleTimestamps: duration must be positive, got ${JSON.stringify(duration)}`);
  if (!(fps > 0)) throw new Error(`sampleTimestamps: fps must be positive, got ${JSON.stringify(fps)}`);
  const ts = [];
  for (let t = offset; t < duration; t += 1 / fps) ts.push(round3(t));
  return ts;
};

export const frozenSegments = (frames, { maxBits, minSeconds }) => {
  if (typeof maxBits !== 'number' || typeof minSeconds !== 'number') throw new Error('frozenSegments: maxBits and minSeconds are required');
  const segments = [];
  let run = null;
  const close = () => {
    if (run && run.to - run.from >= minSeconds) segments.push({ ...run, seconds: round3(run.to - run.from) });
    run = null;
  };
  for (let i = 1; i < frames.length; i += 1) {
    const delta = hamming(frames[i - 1].dhash, frames[i].dhash);
    if (delta <= maxBits) {
      if (!run) run = { from: frames[i - 1].t, to: frames[i].t, deltas: [] };
      run.to = frames[i].t;
      run.deltas.push(delta);
    } else close();
  }
  close();
  return segments;
};

export const exposureFrames = (frames, { black, blown }) => ({
  black: frames.filter((f) => f.meanLuma <= black.maxLuma).map((f) => f.t),
  blown: frames.filter((f) => f.meanLuma >= blown.minLuma).map((f) => f.t),
});

export const lookLine = (style) => {
  const look = style?.look;
  if (!look || typeof look.style !== 'string' || !look.style.trim() || typeof look.grade !== 'string' || !look.grade.trim()) {
    throw new Error('style.look.style and style.look.grade are required — the judge anchors look questions to the style line');
  }
  return `${look.style.trim()} — ${look.grade.trim()}`;
};

let findingCounter = 0;
export const findingRow = (row) => {
  findingCounter += 1;
  return { finding_id: `f_${Date.now().toString(36)}${findingCounter.toString(36)}`, at: new Date().toISOString(), ...row };
};

const file = async (journal, row) => {
  const full = findingRow(row);
  await journal.finding(full);
  return full;
};

const parseJson = (text) => {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in the answer');
  return JSON.parse(m[0]);
};

const answersOf = (q) => (q.form === 'choice' ? q.options : BINARY_ANSWERS);

const parseAnswers = (content, questions, frameCount) => {
  const answers = {};
  const malformed = [];
  let parsed;
  try { parsed = parseJson(content); } catch (err) {
    return { answers, malformed: questions.map((q) => ({ id: q.id, reason: `unparseable: ${err.message}` })) };
  }
  const list = Array.isArray(parsed?.answers) ? parsed.answers : [];
  for (const q of questions) {
    const a = list.find((x) => x && x.id === q.id);
    if (!a) { malformed.push({ id: q.id, reason: 'no answer' }); continue; }
    const answer = typeof a.answer === 'string' ? a.answer.trim().toLowerCase() : null;
    const legal = answersOf(q).map((x) => x.toLowerCase());
    if (!legal.includes(answer)) { malformed.push({ id: q.id, reason: `answer ${JSON.stringify(a.answer)} is not one of ${answersOf(q).join(', ')}` }); continue; }
    if (!Number.isInteger(a.frame) || a.frame < 0 || a.frame >= frameCount) { malformed.push({ id: q.id, reason: `frame ${JSON.stringify(a.frame)} is not an index in 0..${frameCount - 1}` }); continue; }
    answers[q.id] = { answer: answersOf(q)[legal.indexOf(answer)], frame: a.frame, note: typeof a.note === 'string' ? a.note : '' };
  }
  return { answers, malformed };
};

const systemPromptFor = (rubrics, questions) => {
  const cited = [...new Set(questions.map((q) => q.ruleRef))].map((id) => rubrics.rulebook.ruleById(id));
  return [
    'You are the witness judge of a film pass. You answer fixed questions about the frames you are shown and point at the frame that shows each answer.',
    'Answer from the frames alone. Every answer names one frame index. Reply with strict JSON and nothing else.',
    'The rules each question serves:',
    ...cited.map((r) => `- [${r.id}] ${r.title}: ${r.statement}`),
  ].join('\n');
};

const framesBlock = (frames, references) => [
  ...(references.length ? ['Reference plates come first, one image each, before the frames:', ...references.map((r, i) => `R${i + 1}: ${r.label}`)] : []),
  `Frames follow, in order. Frame indices count from 0 and refer to frames only:`,
  ...frames.map((f, i) => `${i}: ${f.t}s`),
].join('\n');

const fnv1a = (s) => {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(s)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

export const blindControlOf = (label, blind) => {
  const key = blind?.key;
  const fraction = blind?.fraction;
  if (typeof key !== 'string' || !key.trim()) throw new Error(`E-JUDGE-BLIND-KEY: ${label}: blind.key must name the shot (or the film) the control is drawn for; got ${JSON.stringify(key)}`);
  if (typeof fraction !== 'number' || !(fraction >= 0 && fraction <= 1)) throw new Error(`E-JUDGE-BLIND-FRACTION: ${label}: blind.fraction must be a number in [0, 1]; got ${JSON.stringify(fraction)}`);
  const hash = fnv1a(key);
  const draw = hash / 2 ** 32;
  return { key, fraction, hash, draw: Math.round(draw * 1e6) / 1e6, selected: draw < fraction };
};

const contextBlock = (context, description, blind) => [
  `Context: ${context}`,
  ...(blind.selected ? [] : [`Description: ${description}`]),
].join('\n');

const askOnce = async ({ client, journal, rubrics, questions, frames, references, context, description, order, label, frameRate, nodeId, kind, blind }) => {
  const ordered = order === 'reversed' ? [...questions].reverse() : questions;
  const systemPrompt = systemPromptFor(rubrics, questions);
  const prompt = [
    contextBlock(context, description, blind),
    '',
    framesBlock(frames, references),
    '',
    'Questions:',
    ...ordered.map((q, i) => `${i + 1}. [${q.id}] ${q.text} Answer with one of: ${answersOf(q).join(' | ')}`),
    '',
    'Reply with strict JSON only: {"answers":[{"id":"<question id>","answer":"<one of the listed answers>","frame":<index of the frame that shows it>,"note":"<one sentence>"}]} — one entry per question, in the order asked.',
  ].join('\n');
  const t0 = Date.now();
  const res = await client.reason({ prompt, systemPrompt, images: [...references.map((r) => r.url), ...frames.map((f) => f.url)], nodeId });
  const parsed = parseAnswers(res.content, ordered, frames.length);
  await journal.write('judge', {
    label, kind, order, blind, description: blind.selected ? null : description, frameRate, rubricVersion: rubrics.version,
    questions: ordered.map((q) => q.id), frames, references, systemPrompt, prompt,
    response: res.content, answers: parsed.answers, malformed: parsed.malformed, ms: Date.now() - t0,
  });
  return parsed;
};

const askFalsification = async ({ client, journal, rubrics, held, verdicts, frames, references, context, description, label, nodeId, blind }) => {
  const prompt = [
    contextBlock(context, description, blind),
    '',
    framesBlock(frames, references),
    '',
    'Earlier you gave these answers. For each, point at the single frame index that shows it, or say you cannot see it in any frame:',
    ...held.map((q, i) => `${i + 1}. [${q.id}] ${q.text} Your answer: ${verdicts[q.id].answer}`),
    '',
    'Reply with strict JSON only: {"falsifications":[{"id":"<question id>","seen":true|false,"frame":<index or null>,"note":"<one sentence>"}]}',
  ].join('\n');
  const t0 = Date.now();
  const res = await client.reason({ prompt, systemPrompt: systemPromptFor(rubrics, held), images: [...references.map((r) => r.url), ...frames.map((f) => f.url)], nodeId });
  let parsed = null;
  let malformed = null;
  try { parsed = parseJson(res.content); } catch (err) { malformed = err.message; }
  if (!malformed && !Array.isArray(parsed?.falsifications)) malformed = 'reply carries no "falsifications" array';
  const list = malformed ? [] : parsed.falsifications;
  const results = {};
  for (const q of held) {
    const f = list.find((x) => x && x.id === q.id);
    const pointed = f && f.seen === true && Number.isInteger(f.frame) && f.frame >= 0 && f.frame < frames.length;
    results[q.id] = pointed ? { pointed: true, frame: f.frame, note: typeof f.note === 'string' ? f.note : '' } : { pointed: false, raw: f || null };
  }
  await journal.write('judge', { label, kind: 'falsification', blind, description: blind.selected ? null : description, rubricVersion: rubrics.version, questions: held.map((q) => q.id), frames, references, prompt, response: res.content, malformed, result: results, ms: Date.now() - t0 });
  return { malformed, response: res.content, results };
};

export const judge = async ({ client, journal, rubrics, questions, frames, references, context, description, label, frameRate, offsetFrames, finding, nodeId, blind: blindArg }) => {
  if (typeof nodeId !== 'string' || !nodeId.trim()) throw new Error(`E-JUDGE-NO-NODE: ${label}: a judge call names the plan node that spends it`);
  if (typeof context !== 'string' || !context.trim()) throw new Error(`E-JUDGE-NO-CONTEXT: ${label}: a judge call states the harness facts it saw`);
  if (typeof description !== 'string' || !description.trim()) throw new Error(`E-JUDGE-NO-DESCRIPTION: ${label}: a judge call carries the plan's description so the blind control has something to withhold`);
  const blind = blindControlOf(label, blindArg);
  if (!questions.length) throw new Error(`${label}: no rubric questions to ask`);
  if (!frames.length) throw new Error(`${label}: no frames to judge`);
  const rounds = [];
  const askBoth = async (fr, offset) => {
    const listed = await askOnce({ client, journal, rubrics, questions, frames: fr, references, context, description, order: 'listed', label, frameRate, nodeId, kind: 'rubric', blind });
    const reversed = await askOnce({ client, journal, rubrics, questions, frames: fr, references, context, description, order: 'reversed', label, frameRate, nodeId, kind: 'rubric', blind });
    rounds.push({ offset, listed, reversed });
    return { listed, reversed };
  };
  const verdicts = {};
  const primary = await askBoth(frames, 'primary');
  for (const q of questions) {
    const a = primary.listed.answers[q.id];
    const b = primary.reversed.answers[q.id];
    if (!a || !b) verdicts[q.id] = { state: 'malformed', reasons: [...primary.listed.malformed, ...primary.reversed.malformed].filter((m) => m.id === q.id).map((m) => m.reason) };
    else if (a.answer !== b.answer) verdicts[q.id] = { state: 'unstable', answers: [a.answer, b.answer] };
    else verdicts[q.id] = { state: 'stable', answer: a.answer, pass: passesOf(q, a.answer), frames: [a.frame, b.frame], notes: [a.note, b.note] };
  }
  const failedFirst = questions.filter((q) => verdicts[q.id].state === 'stable' && !verdicts[q.id].pass);
  if (failedFirst.length) {
    const fr2 = await offsetFrames();
    const second = await askBoth(fr2, 'second');
    for (const q of failedFirst) {
      const a = second.listed.answers[q.id];
      const b = second.reversed.answers[q.id];
      const primaryVerdict = verdicts[q.id];
      if (!a || !b || a.answer !== b.answer) verdicts[q.id] = { state: 'unstable', answers: [primaryVerdict.answer, a?.answer ?? null, b?.answer ?? null], offset: 'second' };
      else if (passesOf(q, a.answer)) verdicts[q.id] = { state: 'stable', answer: a.answer, pass: true, frames: [a.frame, b.frame], notes: [a.note, b.note], overturnedAtOffset: primaryVerdict };
      else verdicts[q.id] = { ...primaryVerdict, confirmedAtOffset: { answer: a.answer, frames: [a.frame, b.frame] } };
    }
  }
  const held = questions.filter((q) => verdicts[q.id].state === 'stable' && !verdicts[q.id].pass);
  const findings = [];
  if (held.length) {
    const falsified = await askFalsification({ client, journal, rubrics, held, verdicts, frames, references, context, description, label, nodeId, blind });
    if (falsified.malformed) {
      for (const q of held) verdicts[q.id] = { ...verdicts[q.id], falsification: { pointed: false, malformed: falsified.malformed } };
      findings.push(await file(journal, {
        ...finding, family: 'judge-reliability', severity: 'note', code: 'E-JUDGE-MALFORMED', ruleId: held[0].ruleRef, rubricId: held.map((q) => q.id).join(','),
        detail: `falsification re-ask malformed, ${held.length} held failure(s) stand: ${falsified.malformed}`,
        evidence: [{ label, blind, frames: frames.map((f) => f.url), response: falsified.response, held: held.map((q) => q.id) }],
        disposition: 'record',
      }));
    } else {
      for (const q of held) {
        if (falsified.results[q.id].pointed) verdicts[q.id] = { ...verdicts[q.id], falsification: falsified.results[q.id] };
        else verdicts[q.id] = { state: 'unfalsified', answer: verdicts[q.id].answer, falsification: falsified.results[q.id] };
      }
    }
  }
  const CODES = { malformed: 'E-JUDGE-MALFORMED', unstable: 'E-JUDGE-UNSTABLE', unfalsified: 'E-JUDGE-UNFALSIFIED' };
  for (const q of questions) {
    const vq = verdicts[q.id];
    if (!CODES[vq.state]) continue;
    findings.push(await file(journal, {
      ...finding, family: 'judge-reliability', severity: 'note', code: CODES[vq.state], ruleId: q.ruleRef, rubricId: q.id,
      detail: `${q.id} ${vq.state}: ${JSON.stringify(vq.reasons || vq.answers || vq.falsification?.raw || null)}`,
      evidence: [{ label, blind, frames: frames.map((f) => f.url), verdict: vq }],
      disposition: 'record',
    }));
  }
  return { verdicts, rounds, findings, blind };
};

const offsetSampler = (url, duration, fps, maxWidth) => async () => extractFrames(url, sampleTimestamps(duration, fps, 0.5 / fps), maxWidth);

const rubricScoreOf = (questions, verdicts) => {
  if (!questions.length) return 0;
  const passed = questions.filter((q) => verdicts[q.id]?.state === 'stable' && verdicts[q.id].pass).length;
  return passed / questions.length;
};

const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const rubricFindings = async ({ journal, questions, verdicts, policy, finding, label, frames, blind }) => {
  const out = [];
  for (const q of questions) {
    const vq = verdicts[q.id];
    if (vq.state !== 'stable' || vq.pass) continue;
    const authority = authorityOf(q, policy);
    out.push(await file(journal, {
      ...finding, family: 'qc', severity: authority === 'spending' ? 'blocker' : 'note', code: 'E-RUBRIC-FAIL', ruleId: q.ruleRef, rubricId: q.id,
      detail: `${authority}: ${q.text} — ${vq.answer} (${vq.falsification.pointed ? `frame ${vq.falsification.frame}: ${vq.falsification.note}` : `falsification re-ask malformed: ${vq.falsification.malformed}`})`,
      evidence: [{ label, blind, frames: frames.map((f) => f.url), verdict: vq }],
      disposition: authority === 'spending' ? 'regenerate' : 'witness',
    }));
  }
  return out;
};

export const noForceLiteral = (rubrics) => {
  const literal = rubrics.rulebook.ruleById('SCR-013')?.params?.noForce;
  if (typeof literal !== 'string' || !literal.trim()) throw new Error('SCR-013 params.noForce is required — the literal a shot declares when the opposition is absent from the frame is a rule, not a constant');
  return literal;
};

export const blindOf = (policy, key) => {
  const fraction = policy?.judge?.blindFraction;
  if (typeof fraction !== 'number') throw new Error('policy.judge.blindFraction is required — the blind control covers that fraction of shots');
  return { key, fraction };
};

export const plateContext = (plates) => plates.map((p) => ({ label: `${p.entity} (${p.role})`, url: p.url }));

export const shotAnchors = (shot, style) => ({
  subject: shot.subject, force: shot.force, change: shot.change, setup: shot.setup, look: lookLine(style),
});

export const takeQC = async ({ take, shot, keyframe, plates, style, rubrics, policy, client, journal }) => {
  for (const [k, v] of Object.entries({ take, shot, plates, style, rubrics, policy, client, journal })) if (!v) throw new Error(`takeQC: ${k} is required`);
  if (!take.url || !take.id) throw new Error('takeQC: take.id and take.url are required');
  const fps = policy.judge.fps;
  const cap = policy.judge.maxFramesPerCall;
  if (!(fps > 0) || !Number.isInteger(cap)) throw new Error('takeQC: policy.judge.fps and policy.judge.maxFramesPerCall are required');
  const params = rubrics.params.take;
  const label = `take:${shot.id}:${take.id}`;
  const base = { stage: 'qc', shotId: shot.id, takeId: take.id };
  const findings = [];

  const m = await measureUrl(take.url, true);
  const timestamps = sampleTimestamps(m.duration, fps);
  if (timestamps.length > cap) throw new Error(`takeQC ${label}: ${timestamps.length} frames at ${fps} fps exceed policy.judge.maxFramesPerCall ${cap}`);
  const raw = await extractFrames(take.url, timestamps, params.frames.maxWidth);
  const frames = [];
  for (const f of raw) frames.push({ ...f, ...(await imageStats(f.url)) });
  const frozen = frozenSegments(frames, params.frozen);
  const exposure = exposureFrames(frames, params);
  const frozenFraction = round3(frozen.reduce((a, s) => a + s.seconds, 0) / m.duration);
  const blackFraction = round3(exposure.black.length / frames.length);
  const blownFraction = round3(exposure.blown.length / frames.length);
  const keyframeDistance = keyframe ? hamming((await imageStats(keyframe.url)).dhash, m.firstHash) : null;

  const perShot = [{ shotId: shot.id, requested: shot.seconds, measured: m.duration, fps: m.fps, nbReadFrames: m.nbReadFrames, blackFraction, frozenFraction }];
  const gates = [];
  for (const rule of rubrics.rulebook.rulesFor('perShot', 'measure')) {
    for (const r of CHECKS[rule.id]({ perShot }, rule.params)) gates.push({ ...r, class: rule.class, blocking: rule.blocking && rule.status === 'active', failureKind: rule.failureKind });
  }
  const deadAir = rubrics.rulebook.ruleById('CIN-009').params;
  const overBlack = deadAir.maxBlackFraction !== null && blackFraction > deadAir.maxBlackFraction;
  const overFrozen = deadAir.maxFrozenFraction !== null && frozenFraction > deadAir.maxFrozenFraction;
  for (const g of gates.filter((x) => !x.pass)) {
    const modelProperty = g.failureKind === 'deterministic';
    findings.push(await file(journal, {
      ...base, family: modelProperty ? 'shortfall' : 'gate', severity: g.blocking ? 'blocker' : 'note', code: g.ruleId === 'CIN-004' ? 'E-TAKE-FPS' : 'E-TAKE-DURATION', ruleId: g.ruleId, class: 'measure', failureKind: g.failureKind,
      value: g.value, threshold: g.threshold,
      detail: `${g.subject}: ${g.detail || g.value} (threshold ${g.threshold})${modelProperty ? ' — a model property, not retryable; the take ships with this shortfall named' : ''}`,
      evidence: [{ takeUrl: take.url, measure: m }], disposition: modelProperty ? 'ship' : (g.failureKind === 'retryable' ? 'regenerate' : 'record'),
    }));
  }
  for (const seg of frozen) {
    findings.push(await file(journal, {
      ...base, family: 'qc', severity: overFrozen ? 'blocker' : 'note', code: 'E-TAKE-FROZEN', ruleId: 'CIN-009',
      detail: `frozen ${seg.seconds}s from ${seg.from}s to ${seg.to}s (deltas ${seg.deltas.join(',')} <= ${params.frozen.maxBits} bits); fraction ${frozenFraction} vs ${JSON.stringify(deadAir.maxFrozenFraction)}`,
      timecode: seg.from, evidence: [{ segment: seg, frames: frames.filter((f) => f.t >= seg.from && f.t <= seg.to).map((f) => f.url) }], disposition: overFrozen ? 'regenerate' : 'record',
    }));
  }
  for (const [kind, ts] of [['black', exposure.black], ['blown', exposure.blown]]) {
    if (!ts.length) continue;
    const over = kind === 'black' ? overBlack : false;
    findings.push(await file(journal, {
      ...base, family: 'qc', severity: over ? 'blocker' : 'note', code: kind === 'black' ? 'E-TAKE-BLACK' : 'E-TAKE-BLOWN', ruleId: 'CIN-009',
      detail: `${ts.length} ${kind} frame(s) at ${ts.join(', ')}s; fraction ${kind === 'black' ? blackFraction : blownFraction}`,
      timecode: ts[0], evidence: [{ timestamps: ts, frames: frames.filter((f) => ts.includes(f.t)).map((f) => f.url) }], disposition: over ? 'regenerate' : 'record',
    }));
  }

  const anchors = shotAnchors(shot, style);
  const noForce = noForceLiteral(rubrics);
  const skipped = shot.force === noForce ? rubrics.forSet('take', (q) => q.anchors.includes('force')).map((q) => q.id) : [];
  const questions = rubrics.forSet('take', (q) => !skipped.includes(q.id)).map((q) => fillQuestion(q, anchors));
  const context = `One take of shot ${shot.id}, ${m.duration}s measured at ${m.fps} fps. The frames were sampled at ${fps} frame(s) per second across the whole take.`;
  const description = `Planned as a ${shot.setup} of ${shot.seconds}s, subject ${shot.subject}. Force in this shot: ${shot.force}. Change: ${shot.change}. Look: ${anchors.look}.`;
  const judged = await judge({
    client, journal, rubrics, questions, frames: frames.map((f) => ({ t: f.t, url: f.url })), references: plateContext(plates), context, description, label, frameRate: fps,
    offsetFrames: offsetSampler(take.url, m.duration, fps, params.frames.maxWidth), finding: base, nodeId: `qc:${shot.id}`, blind: blindOf(policy, shot.id),
  });
  findings.push(...judged.findings);
  const measured = { frozen: frozen.length > 0, black: exposure.black.length > 0 };
  for (const q of questions.filter((x) => x.measure)) {
    const vq = judged.verdicts[q.id];
    if (vq.state !== 'stable') continue;
    const judgeSaw = vq.answer === 'yes';
    if (judgeSaw === measured[q.measure]) continue;
    judged.verdicts[q.id] = { state: 'overruled', by: 'measure', answer: vq.answer, measured: measured[q.measure], judged: vq };
    findings.push(await file(journal, {
      ...base, family: 'judge-reliability', severity: 'note', code: 'E-JUDGE-CONTRADICTS-MEASURE', ruleId: q.ruleRef, rubricId: q.id,
      detail: `judge answered ${vq.answer} to "${q.text}" while ${q.measure} measured ${measured[q.measure]} (${q.measure === 'frozen' ? `${frozen.length} segment(s), fraction ${frozenFraction}` : `${exposure.black.length} frame(s), fraction ${blackFraction}`})`,
      evidence: [{ label, blind: judged.blind, verdict: vq, frozen, black: exposure.black }], disposition: 'record',
    }));
  }
  findings.push(...await rubricFindings({ journal, questions, verdicts: judged.verdicts, policy, finding: base, label, frames, blind: judged.blind }));

  const deterministic = {
    measure: m, fps: m.fps, duration: m.duration, gates, frozen, frozenFraction, exposure, blackFraction, blownFraction, keyframeDistance,
    frames: frames.map((f) => ({ t: f.t, url: f.url, dhash: f.dhash, meanLuma: f.meanLuma, blur: f.blur })),
  };
  const deterministicScore = meanOf([
    gates.every((g) => g.pass) ? 1 : 0,
    frozen.length ? 0 : 1,
    exposure.black.length ? 0 : 1,
    exposure.blown.length ? 0 : 1,
  ]);
  const rubricScore = rubricScoreOf(questions, judged.verdicts);
  const score = round3(params.scoring.deterministicWeight * deterministicScore + params.scoring.rubricWeight * rubricScore);
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const pass = !blockers.length;
  const regenerate = !pass && !blockers.every((f) => f.disposition === 'ship');
  const rubric = { questions: questions.map((q) => q.id), skipped, skippedBecause: skipped.length ? `shot ${shot.id} declares force ${JSON.stringify(noForce)}, the SCR-013 params.noForce literal` : null, verdicts: judged.verdicts, rounds: judged.rounds.length, blind: judged.blind, score: rubricScore };
  await journal.write('qc', { kind: 'take', shotId: shot.id, takeId: take.id, rubricVersion: rubrics.version, pass, regenerate, score, deterministic, rubric, findings: findings.map((f) => f.finding_id) });
  return { pass, regenerate, score, findings, deterministic, rubric };
};

export const joinQC = async ({ prev, next, joinType, distance, rubrics, policy, client, journal }) => {
  for (const [k, v] of Object.entries({ prev, next, rubrics, policy, client, journal })) if (!v) throw new Error(`joinQC: ${k} is required`);
  if (!JOIN_TYPES.includes(joinType)) throw new Error(`joinQC: joinType must be cut or continuous, got ${JSON.stringify(joinType)}`);
  if (!Number.isInteger(distance)) throw new Error(`joinQC: distance must be the measured dHash distance, got ${JSON.stringify(distance)}`);
  const w = rubrics.params.join.window;
  const joinRef = `${prev.shotId}->${next.shotId}`;
  const label = `join:${joinRef}`;
  const base = { stage: 'join', joinRef, shotId: next.shotId, ...(next.takeId ? { takeId: next.takeId } : {}) };
  const findings = [];
  const mp = await measureUrl(prev.url, false);
  const mn = await measureUrl(next.url, false);
  const sample = async (offset) => {
    const start = Math.max(0, round3(mp.duration - w.secondsBefore));
    const before = sampleTimestamps(mp.duration - start, w.fps, offset).map((t) => round3(start + t));
    const after = sampleTimestamps(Math.min(mn.duration, w.secondsAfter), w.fps, offset);
    const fb = await extractFrames(prev.url, before, w.maxWidth);
    const fa = await extractFrames(next.url, after, w.maxWidth);
    return { frames: [...fb.map((f) => ({ t: round3(f.t - mp.duration), url: f.url })), ...fa], boundaryIndex: fb.length };
  };
  const { frames, boundaryIndex } = await sample(0);
  const questions = rubrics.forSet('join', (q) => q.joinTypes.includes(joinType)).map((q) => fillQuestion(q, {}));
  const context = `The boundary between two consecutive takes. Frame times are relative to the boundary at 0s. Frames 0..${boundaryIndex - 1} come before the boundary and frames ${boundaryIndex}..${frames.length - 1} come after it; the boundary sits between frame ${boundaryIndex - 1} and frame ${boundaryIndex}. The measured dHash distance across the boundary is ${distance} of 64 bits.`;
  const description = `The plan declares this a ${joinType} join between shot ${prev.shotId} and shot ${next.shotId}.`;
  const judged = await judge({
    client, journal, rubrics, questions, frames, references: [], context, description, label, frameRate: w.fps,
    offsetFrames: async () => (await sample(0.5 / w.fps)).frames, finding: base, nodeId: `chain:${next.shotId}`, blind: blindOf(policy, next.shotId),
  });
  findings.push(...judged.findings);
  const thresholds = { cut: rubrics.rulebook.ruleById('CIN-012').params.thetaChange, continuous: rubrics.rulebook.ruleById('CIN-003').params.theta };
  for (const q of questions.filter((x) => x.measure)) {
    const vq = judged.verdicts[q.id];
    const theta = thresholds[q.measure];
    if (vq.state !== 'stable' || theta === null) continue;
    const measuredYes = q.measure === 'cut' ? distance > theta : distance <= theta;
    if ((vq.answer === 'yes') === measuredYes) continue;
    judged.verdicts[q.id] = { state: 'overruled', by: 'measure', answer: vq.answer, measured: measuredYes, judged: vq };
    findings.push(await file(journal, {
      ...base, family: 'judge-reliability', severity: 'note', code: 'E-JUDGE-CONTRADICTS-MEASURE', ruleId: q.ruleRef, rubricId: q.id,
      detail: `judge answered ${vq.answer} to "${q.text}" while the boundary measured ${distance} bits against theta ${theta}`, evidence: [{ label, blind: judged.blind, verdict: vq, distance, theta }], disposition: 'record',
    }));
  }
  findings.push(...await rubricFindings({ journal, questions, verdicts: judged.verdicts, policy, finding: base, label, frames, blind: judged.blind }));
  await journal.write('qc', { kind: 'join', joinRef, joinType, distance, rubricVersion: rubrics.version, frames, boundaryIndex, verdicts: judged.verdicts, blind: judged.blind, findings: findings.map((f) => f.finding_id) });
  return { findings, verdicts: judged.verdicts, frames, boundaryIndex, blind: judged.blind };
};

const evenSubset = (xs, n) => {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]);
};

export const filmQC = async ({ slice, manifest, screenplay, style, rubrics, policy, client, journal }) => {
  for (const [k, v] of Object.entries({ slice, manifest, screenplay, style, rubrics, policy, client, journal })) if (!v) throw new Error(`filmQC: ${k} is required`);
  if (!slice.url) throw new Error('filmQC: slice.url is required');
  if (!Array.isArray(screenplay.beats) || !screenplay.beats.length) throw new Error('filmQC: screenplay.beats is required — the film rubric asks whether each beat lands');
  const fps = policy.judge.fps;
  const cap = policy.judge.maxFramesPerCall;
  if (!(fps > 0) || !Number.isInteger(cap)) throw new Error('filmQC: policy.judge.fps and policy.judge.maxFramesPerCall are required');
  const maxWidth = rubrics.params.film.frames.maxWidth;
  const base = { stage: 'final' };
  const findings = [];
  const m = await measureUrl(slice.url, false);
  const windows = [];
  let cursor = 0;
  for (const sh of manifest.shots) {
    const beat = screenplay.beats.find((b) => String(b.id) === String(sh.beatId));
    if (!beat) throw new Error(`filmQC: shot ${sh.id} serves beat ${JSON.stringify(sh.beatId)} and the screenplay has no such beat`);
    windows.push({ shot: sh, beat, from: cursor, to: round3(Math.min(cursor + sh.seconds, m.duration)) });
    cursor = round3(cursor + sh.seconds);
  }
  const all = await extractFrames(slice.url, sampleTimestamps(m.duration, fps), maxWidth);
  const framesIn = (win) => all.filter((f) => f.t >= win.from && f.t < win.to);
  const look = lookLine(style);
  const verdicts = {};
  const calls = [];

  const beatQuestions = rubrics.forSet('film', (q) => q.level === 'shot');
  let segment = [];
  let segmentFrames = [];
  const flush = async () => {
    if (!segment.length) return;
    const questions = segment.flatMap((win) => beatQuestions.map((q) => ({ ...fillQuestion(q, { beat: win.beat.text }), id: `${q.id}:${win.shot.id}`, baseId: q.id, shotId: win.shot.id })));
    const label = `film:segment:${segment[0].shot.id}..${segment.at(-1).shot.id}`;
    const context = `The assembled film, ${m.duration}s measured. This segment covers ${segment.map((w) => `shot ${w.shot.id} (${w.from}s to ${w.to}s)`).join('; ')}. Frame times are film times.`;
    const description = `Planned for ${manifest.targetSeconds}s. ${segment.map((w) => `Shot ${w.shot.id}: a ${w.shot.setup}, subject ${w.shot.subject}, force ${w.shot.force}, change ${w.shot.change}`).join('; ')}. Look: ${look}.`;
    const judged = await judge({
      client, journal, rubrics, questions, frames: segmentFrames, references: [], context, description, label, frameRate: fps,
      offsetFrames: async () => extractFrames(slice.url, segmentFrames.map((f) => round3(f.t + 0.5 / fps)).filter((t) => t < m.duration), maxWidth), finding: { ...base, shotId: segment[0].shot.id }, nodeId: 'final', blind: blindOf(policy, segment[0].shot.id),
    });
    calls.push({ label, frames: segmentFrames.length, blind: judged.blind });
    findings.push(...judged.findings);
    for (const q of questions) {
      verdicts[q.id] = judged.verdicts[q.id];
      const vq = judged.verdicts[q.id];
      if (vq.state !== 'stable' || vq.pass) continue;
      const authority = authorityOf(q, policy);
      findings.push(await file(journal, {
        ...base, shotId: q.shotId, family: 'qc', severity: authority === 'spending' ? 'blocker' : 'note', code: 'E-RUBRIC-FAIL', ruleId: q.ruleRef, rubricId: q.baseId,
        detail: `${authority}: ${q.text} — ${vq.answer} (${vq.falsification.pointed ? `frame ${vq.falsification.frame}: ${vq.falsification.note}` : `falsification re-ask malformed: ${vq.falsification.malformed}`})`, evidence: [{ label, blind: judged.blind, frames: segmentFrames.map((f) => f.url), verdict: vq }], disposition: authority === 'spending' ? 'regenerate' : 'witness',
      }));
    }
    segment = [];
    segmentFrames = [];
  };
  for (const win of windows) {
    const fr = framesIn(win);
    if (fr.length > cap) throw new Error(`filmQC: shot ${win.shot.id} spans ${fr.length} frames at ${fps} fps, over policy.judge.maxFramesPerCall ${cap}`);
    if (segmentFrames.length + fr.length > cap) await flush();
    segment.push(win);
    segmentFrames = [...segmentFrames, ...fr];
  }
  await flush();

  const filmQuestions = rubrics.forSet('film', (q) => q.level === 'film');
  const cast = [...new Set(manifest.shots.map((sh) => sh.subject))];
  const summary = evenSubset(windows.flatMap((win) => { const fr = framesIn(win); return fr.length ? [fr[0], fr.at(-1)] : []; }).filter((f, i, xs) => xs.indexOf(f) === i), cap);
  const filmAnchors = { look, firstBeat: screenplay.beats[0].text, lastBeat: screenplay.beats.at(-1).text };
  const whole = filmQuestions.flatMap((q) => (q.anchors.includes('entity')
    ? cast.map((entity) => ({ ...fillQuestion(q, { ...filmAnchors, entity }), id: `${q.id}:${entity}`, baseId: q.id }))
    : [{ ...fillQuestion(q, filmAnchors), baseId: q.id }]));
  const label = 'film:whole';
  const judged = await judge({
    client, journal, rubrics, questions: whole, frames: summary, references: [],
    context: `The assembled film, ${m.duration}s measured, seen as the first and last sampled frame of each of its ${windows.length} shots. Frame times are film times.`,
    description: `Planned for ${manifest.targetSeconds}s with cast ${cast.join(', ')}. Look: ${look}. It opens on: ${filmAnchors.firstBeat}. It closes on: ${filmAnchors.lastBeat}.`,
    label, frameRate: fps,
    offsetFrames: async () => extractFrames(slice.url, summary.map((f) => round3(f.t + 0.5 / fps)).filter((t) => t < m.duration), maxWidth), finding: base, nodeId: 'final', blind: blindOf(policy, 'film'),
  });
  calls.push({ label, frames: summary.length, blind: judged.blind });
  findings.push(...judged.findings);
  for (const q of whole) {
    verdicts[q.id] = judged.verdicts[q.id];
    const vq = judged.verdicts[q.id];
    if (vq.state !== 'stable' || vq.pass) continue;
    const authority = authorityOf(q, policy);
    findings.push(await file(journal, {
      ...base, family: 'qc', severity: authority === 'spending' ? 'blocker' : 'note', code: 'E-RUBRIC-FAIL', ruleId: q.ruleRef, rubricId: q.baseId,
      detail: `${authority}: ${q.text} — ${vq.answer} (${vq.falsification.pointed ? `frame ${vq.falsification.frame}: ${vq.falsification.note}` : `falsification re-ask malformed: ${vq.falsification.malformed}`})`, evidence: [{ label, blind: judged.blind, frames: summary.map((f) => f.url), verdict: vq }], disposition: authority === 'spending' ? 'regenerate' : 'witness',
    }));
  }
  await journal.write('qc', { kind: 'film', rubricVersion: rubrics.version, measure: m, windows: windows.map((w) => ({ shotId: w.shot.id, beatId: w.beat.id, from: w.from, to: w.to })), calls, verdicts, findings: findings.map((f) => f.finding_id) });
  return { findings, verdicts, calls };
};

export const plateQC = async ({ plate, style, rubrics, policy, client, journal }) => {
  for (const [k, v] of Object.entries({ plate, style, rubrics, policy, client, journal })) if (!v) throw new Error(`plateQC: ${k} is required`);
  if (!plate.url || !plate.entity || !plate.role) throw new Error('plateQC: plate.url, plate.entity and plate.role are required');
  const label = `plate:${plate.entity}`;
  const base = { stage: 'plate' };
  const stats = await imageStats(plate.url);
  const questions = rubrics.forSet('plate').map((q) => fillQuestion(q, { entity: plate.entity, role: plate.role, look: lookLine(style) }));
  const frames = [{ t: 0, url: plate.url }];
  if (typeof plate.prompt !== 'string' || !plate.prompt.trim()) throw new Error(`plateQC: plate.prompt is required — the judge's description of ${plate.entity} is the prompt it was rendered from`);
  const judged = await judge({
    client, journal, rubrics, questions, frames, references: [], context: `A single rendered still: an identity plate for ${plate.entity}, a ${plate.role}.`, description: `Rendered from: ${plate.prompt}`,
    label, frameRate: 0, offsetFrames: async () => frames, finding: base, nodeId: `plate:${plate.entity}`, blind: blindOf(policy, plate.entity),
  });
  const findings = [...judged.findings, ...await rubricFindings({ journal, questions, verdicts: judged.verdicts, policy, finding: base, label, frames, blind: judged.blind })];
  const score = rubricScoreOf(questions, judged.verdicts);
  const pass = !findings.some((f) => f.severity === 'blocker');
  await journal.write('qc', { kind: 'plate', entity: plate.entity, rubricVersion: rubrics.version, stats, pass, score, verdicts: judged.verdicts, blind: judged.blind, findings: findings.map((f) => f.finding_id) });
  return { pass, score, findings, stats, verdicts: judged.verdicts, blind: judged.blind };
};
