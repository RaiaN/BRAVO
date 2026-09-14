#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openJournal, journaledClient } from '../agents/journal.js';
import { saveProjectFs, loadProjectFs } from '../state/persist-fs.js';
import {
  appendIteration, appendMessage, appendNote, latchThread, makeBibleEntry, makeProject, newId, sequenceById,
  setLook, setSequenceFields, threadById, touch,
} from '../state/project.js';
import '../agents/index.js';
import { agentFor } from '../agents/registry.js';
import { TOOLS } from '../agents/tools/index.js';
import { requireSkillLine } from '../utils/film/skills.js';
import { MODEL_ENV_VARS, applyDeployModels, defaultImageModelKey, maxShotSeconds, resolveModelId } from '../utils/film/suiteConfig.js';
import { loadRulebook } from '../agents/director/rulebook.js';
import { CHECKS } from '../agents/director/gates.js';
import { loadRubrics, readRubricBooks } from '../agents/director/rubrics.js';
import {
  COMPLETION_DECISIONS, PLANNING_STAGES, POLICY_CHECKS, REGENERATE_MODES, approveManifest, hashPolicyValues, loadPolicyValues, makeLedger, makeReserve, policyProblems, reservationIdOf, runPolicyGate,
} from '../agents/director/policy.js';
import { ideate } from '../agents/director/ideate.js';
import { feasibility } from '../agents/director/partition.js';
import { fnv1a, manifestOf, runSequence } from '../agents/director/execute.js';
import { completionProblems } from '../agents/director/nodes.js';
import { invalidationOf, kindOf, nodeIds, secondsOf, shotOf } from '../agents/director/schedule.js';
import { generateCandidates, scoreCandidate, selectCandidate } from '../agents/director/candidates.js';
import { filmQC, joinQC, measureUrl, plateQC, takeQC } from '../agents/director/qc.js';
import { runFilm as runFilmLoop } from '../agents/film.js';
import { runExtend } from '../agents/extend.js';
import { loadFilmRules } from '../agents/film-qc.js';
import { createBrowserClient } from '../utils/film/core/client.js';
import { installRelativeFetch } from '../tests/lib/client.js';
import { buildReport, summarize, writeReport } from './report.js';
import { foldKnowledge, queryKnowledge, rebuildKnowledge } from './kb.js';

export const VIDEO_SLOT = 'seedance25';
export const AUDIO_JUDGE_ENV = 'MODELARK_MODEL_AUDIO_JUDGE';
export const TOS_ENV = ['MODELARK_TOS_BUCKET', 'MODELARK_TOS_REGION', 'MODELARK_ASSET_ACCESS_KEY', 'MODELARK_ASSET_SECRET_KEY'];
export const STAGE_NAMES = ['plateQC', 'generateCandidates', 'scoreCandidate', 'selectCandidate', 'takeQC', 'joinQC', 'filmQC'];
export const RULE_FILES = ['cinematic', 'screenwriting', 'metrics', 'policy'];
const REFERENCE_ROLES = ['character', 'location', 'look'];
const SEVERITIES = ['blocker', 'note', 'taste'];
const PRICE_UNITS = ['still', 'videoSecond', 'judgeCall', 'reasonCall'];
const URL_RE = /^(https?:\/\/|\/)/;

const fail = (code, what, extra = {}) => {
  const err = new Error(`${code}: ${what}`);
  err.code = code;
  Object.assign(err, extra);
  throw err;
};

const canonical = (x) => {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
};
export const hashJson = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');

export const newRunId = (now = new Date()) => `run_${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const stringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

export const styleProblems = (style) => {
  const out = [];
  const p = (key, detail) => out.push({ key, detail });
  if (!style || typeof style !== 'object' || Array.isArray(style)) return [{ key: 'style', detail: 'the style file must hold a JSON object' }];
  const known = ['id', 'look', 'constraints', 'audio', 'format', 'world', 'references', 'doctrine', 'precedentTags', 'seed'];
  for (const k of Object.keys(style)) if (!known.includes(k)) p(k, `unknown key ${k}`);
  for (const k of known) if (!(k in style)) p(k, `missing key ${k}`);
  if ('id' in style && !nonEmpty(style.id)) p('id', 'id must be a non-empty string');
  if ('look' in style && (!style.look || !nonEmpty(style.look.style) || !nonEmpty(style.look.grade))) p('look', 'look needs style and grade as non-empty strings');
  if ('constraints' in style && !stringList(style.constraints)) p('constraints', 'constraints must be a list of strings');
  if ('audio' in style && typeof style.audio !== 'boolean') p('audio', 'audio must be true or false');
  if ('format' in style) {
    const f = style.format;
    if (!f || typeof f !== 'object' || Array.isArray(f)) p('format', 'format must be an object { resolution, ratio }');
    else {
      for (const k of Object.keys(f)) if (!['resolution', 'ratio'].includes(k)) p(`format.${k}`, `unknown format key ${k} — fps is the rulebook's (SCR-008) and audio is the style's own key`);
      if (!nonEmpty(f.resolution)) p('format.resolution', 'format.resolution must be a non-empty string');
      if (!nonEmpty(f.ratio)) p('format.ratio', 'format.ratio must be a non-empty string');
    }
  }
  if ('world' in style && typeof style.world !== 'string') p('world', 'world must be a string');
  if ('doctrine' in style && !stringList(style.doctrine)) p('doctrine', 'doctrine must be a list of strings');
  if ('precedentTags' in style && !stringList(style.precedentTags)) p('precedentTags', 'precedentTags must be a list of strings');
  if ('seed' in style && style.seed !== null && !Number.isInteger(style.seed)) p('seed', 'seed must be an integer or null');
  if ('references' in style) {
    if (!Array.isArray(style.references)) p('references', 'references must be a list');
    else {
      style.references.forEach((r, i) => {
        if (!r || typeof r !== 'object' || !nonEmpty(r.name) || !REFERENCE_ROLES.includes(r.role)) p(`references.${i}`, `every reference names a "name" and a role of ${REFERENCE_ROLES.join(', ')}`);
        else if ('image' in r && r.image !== null && !(typeof r.image === 'string' && URL_RE.test(r.image))) p(`references.${i}.image`, 'a reference image is an http(s) or app-relative url, checked into the media store at intake');
      });
    }
  }
  return out;
};

export const pricesProblems = (prices) => {
  const out = [];
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return [{ key: 'prices', detail: 'the price file must hold a JSON object' }];
  for (const k of Object.keys(prices)) if (!['date', 'usd'].includes(k)) out.push({ key: k, detail: `unknown key ${k}` });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(prices.date || ''))) out.push({ key: 'date', detail: 'date must be YYYY-MM-DD — a price file is dated or it is not a price file' });
  if (!prices.usd || typeof prices.usd !== 'object') out.push({ key: 'usd', detail: `usd must be an object with ${PRICE_UNITS.join(', ')}` });
  else {
    for (const k of Object.keys(prices.usd)) if (!PRICE_UNITS.includes(k)) out.push({ key: `usd.${k}`, detail: `unknown price unit ${k}` });
    for (const k of PRICE_UNITS) if (typeof prices.usd[k] !== 'number' || !Number.isFinite(prices.usd[k]) || prices.usd[k] < 0) out.push({ key: `usd.${k}`, detail: `usd.${k} must be a number >= 0` });
  }
  return out;
};

export const usdOf = ({ kind, units }, prices) => {
  const rate = { still: prices.usd.still, take: prices.usd.videoSecond, judge: prices.usd.judgeCall, reason: prices.usd.reasonCall }[kind];
  if (typeof rate !== 'number') fail('E-PRICE-KIND', `no price for reservation kind ${JSON.stringify(kind)}`);
  return Math.round(units * rate * 1e6) / 1e6;
};

const readJsonFile = (file, code, what) => {
  if (typeof file !== 'string' || !file.trim()) fail(code, `${what}: no file named`);
  if (!fs.existsSync(file)) fail(code, `${what}: no file at ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fail(code, `${what}: ${file} is not JSON (${err.message})`);
  }
};

const loadInput = (desc, code, what) => {
  if (desc && typeof desc === 'object' && 'value' in desc) return { value: desc.value, from: desc.from || 'value' };
  if (desc && typeof desc === 'object' && typeof desc.file === 'string') return { value: readJsonFile(desc.file, code, what), from: desc.file };
  return fail(code, `${what}: give { file } or { value }`);
};

export const readRuleBooks = (rulesDir) => {
  if (typeof rulesDir !== 'string' || !rulesDir) fail('E-INTAKE-RULEBOOK', 'no rules directory named');
  const books = {};
  for (const name of RULE_FILES) {
    const file = path.join(rulesDir, `${name}.json`);
    if (!fs.existsSync(file)) fail('E-INTAKE-RULEBOOK', `${file} is missing — a pass with half a rulebook refuses to run`);
    try {
      books[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      fail('E-INTAKE-RULEBOOK', `${file} is not JSON (${err.message})`);
    }
  }
  return books;
};

export const loadLaw = (rulesDir) => {
  let rulebook;
  try {
    rulebook = loadRulebook(readRuleBooks(rulesDir), { checks: CHECKS, policyChecks: POLICY_CHECKS });
  } catch (err) {
    if (err.code === 'E-INTAKE-RULEBOOK') throw err;
    fail('E-INTAKE-RULEBOOK', err.message);
  }
  let rubrics;
  try {
    rubrics = loadRubrics(rulebook, readRubricBooks(path.join(rulesDir, 'rubrics')));
  } catch (err) {
    fail('E-INTAKE-RUBRICS', err.message);
  }
  return { rulebook, rubrics };
};

const requireStages = (stages) => {
  if (!stages || typeof stages !== 'object') fail('E-STAGES', 'the pass needs its stages: plateQC, generateCandidates, scoreCandidate, selectCandidate, takeQC, joinQC, filmQC');
  for (const name of STAGE_NAMES) if (typeof stages[name] !== 'function') fail('E-STAGES', `the pass's stages have no "${name}"`);
  return stages;
};

export const realStages = () => ({ plateQC, generateCandidates, scoreCandidate, selectCandidate, takeQC, joinQC, filmQC });

export const passJournal = (journal, { runId }) => {
  if (!journal || typeof journal.write !== 'function' || typeof journal.intent !== 'function') fail('E-JOURNAL', 'passJournal needs an open journal');
  const pending = new Set();
  const failures = [];
  const track = (p) => {
    const q = Promise.resolve(p);
    pending.add(q);
    q.then(() => pending.delete(q), (err) => { pending.delete(q); failures.push(err); });
    return q;
  };
  const stampRunId = (row) => (row && typeof row === 'object' && !Array.isArray(row) ? { runId, ...row } : row);
  return {
    dir: journal.dir,
    paths: journal.paths,
    write: (kind, data) => track(journal.write(kind, data)),
    intent: (kind, data) => track(journal.intent(kind, data)),
    result: (ticket, data) => track(Promise.resolve(ticket).then((id) => journal.result(id, data))),
    finding: (row) => track(journal.finding(stampRunId(row))),
    cost: (row) => track(journal.cost(row)),
    media: (name, source) => track(journal.media(name, source)),
    entries: (kind) => journal.entries(kind),
    drain: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      const out = failures.splice(0, failures.length);
      return out;
    },
    close: () => journal.close(),
  };
};

const reservingClient = (client, { reserve, stageRef, journal }) => ({
  ...client,
  reason: async (args = {}) => {
    const { nodeId: named, ...rest } = args;
    const kind = Array.isArray(rest.images) && rest.images.length ? 'judge' : 'reason';
    if (!named && !PLANNING_STAGES.includes(stageRef.current)) fail('E-RESERVE-NO-NODE', `a ${kind} call during ${stageRef.current} names the plan node it serves — only a planning call (${PLANNING_STAGES.join(', ')}) is reserved under its stage`);
    const nodeId = named || stageRef.current;
    const reservation = await reserve({ nodeId, kind, units: 1, justification: `${kind} call for ${nodeId} during ${stageRef.current}` });
    const reservationId = reservationIdOf(reservation, nodeId);
    const out = await client.reason(rest);
    await journal.cost({ nodeId, kind, units: 1, disposition: 'kept', reservationId });
    return out;
  },
});

const pricedReserve = (policyReserve, prices) => (request) => policyReserve({ ...request, usd: usdOf(request, prices) });

const attemptStage = async ({ journal, policy, stageRef, stage, run }) => {
  stageRef.current = stage;
  const budget = policy.attempts.fault;
  for (let n = 1; ; n += 1) {
    try {
      return await run(n);
    } catch (err) {
      await journal.write('fault', { id: stage, attempt: n, faults: n, budget, reason: err.message, code: err.code || null });
      if (n >= budget) fail(`E-PASS-EXHAUSTED-${stage.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`, `${stage} failed ${n} time(s) within policy.attempts.fault ${budget}; last: ${err.message}`, { stage, cause: err });
    }
  }
};

const policyGate = async ({ journal, rulebook, ruleId, stage, payload }) => {
  const gate = runPolicyGate(rulebook, ruleId, payload);
  await journal.write('policy.gate', { ruleId, stage, pass: gate.pass, results: gate.results, blockers: gate.blockers });
  return gate;
};

const writeThrough = ({ dir, get }) => {
  let writing = null;
  let dirty = false;
  let failure = null;
  const start = () => {
    writing = saveProjectFs(dir, get()).then(
      () => { writing = null; if (dirty) { dirty = false; start(); } },
      (err) => { failure = failure || err; writing = null; if (dirty) { dirty = false; start(); } },
    );
  };
  return {
    touch: () => { if (writing) dirty = true; else start(); },
    flush: async () => {
      while (writing) await writing;
      if (failure) fail('E-PROJECT-WRITE', `project.json could not be written through during the schedule: ${failure.message}`);
    },
  };
};

const envSlot = (name) => String(process.env[name] || '').trim() || null;

export const intake = async ({ journal, runId, idea, ideaSource, seconds, style: styleDesc, policy: policyDesc, prices: pricesDesc, rulesDir, server, mode = null }) => {
  const refuse = async (code, detail, extra = {}) => {
    await journal.write('intake.refused', { runId, code, detail, ...extra });
    fail(code, detail);
  };
  const guard = async (code, fn) => {
    try {
      return await fn();
    } catch (err) {
      return refuse(err.code && String(err.code).startsWith('E-INTAKE') ? err.code : code, err.message);
    }
  };
  if (!nonEmpty(idea)) await refuse('E-INTAKE-IDEA', 'the idea is empty');
  if (!Number.isInteger(seconds) || seconds <= 0) await refuse('E-INTAKE-SECONDS', `seconds must be a positive integer, got ${JSON.stringify(seconds)}`);

  const styleIn = await guard('E-INTAKE-STYLE-FILE', () => loadInput(styleDesc, 'E-INTAKE-STYLE-FILE', 'style'));
  const style = styleIn.value;
  const styleBad = styleProblems(style);
  if (styleBad.length) await refuse(`E-INTAKE-STYLE-${styleBad[0].key.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`, styleBad.map((p) => p.detail).join('; '), { problems: styleBad });

  const policyIn = await guard('E-INTAKE-POLICY', () => {
    if (policyDesc && typeof policyDesc === 'object' && typeof policyDesc.file === 'string') {
      const loaded = loadPolicyValues(policyDesc.file);
      return { value: loaded.values, hash: loaded.hash, from: policyDesc.file };
    }
    const { value, from } = loadInput(policyDesc, 'E-INTAKE-POLICY', 'policy');
    const problems = policyProblems(value);
    if (problems.length) fail('E-INTAKE-POLICY', `policy refused: ${problems.map((p) => p.detail).join('; ')}`);
    return { value, hash: hashPolicyValues(value), from };
  });
  const policy = policyIn.value;
  const unable = completionProblems(policy);
  if (unable.length) await refuse('E-INTAKE-POLICY-COMPLETION', `policy refused: ${unable.join('; ')}`, { problems: unable });

  const pricesIn = await guard('E-INTAKE-PRICES-FILE', () => loadInput(pricesDesc, 'E-INTAKE-PRICES-FILE', 'prices'));
  const prices = pricesIn.value;
  const pricesBad = pricesProblems(prices);
  if (pricesBad.length) await refuse(`E-INTAKE-PRICES-${pricesBad[0].key.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`, pricesBad.map((p) => p.detail).join('; '), { problems: pricesBad });

  const { rulebook, rubrics } = await guard('E-INTAKE-RULEBOOK', () => loadLaw(rulesDir));

  const config = await guard('E-INTAKE-SERVER', async () => {
    let res;
    try {
      res = await fetch('/api/film/config');
    } catch (err) {
      fail('E-INTAKE-SERVER', `no BRAVO server answered /api/film/config at ${server} (${err.message})`);
    }
    if (!res.ok) fail('E-INTAKE-SERVER', `the BRAVO server at ${server} answered /api/film/config with HTTP ${res.status}`);
    const cfg = await res.json();
    if (!cfg || typeof cfg.models !== 'object') fail('E-INTAKE-SERVER', `the BRAVO server at ${server} returned no models`);
    return cfg;
  });
  if (config.hasServerKey !== true) await refuse('E-INTAKE-SERVER-KEY', `the BRAVO server at ${server} holds no MODELARK_API_KEY — nothing can be rendered`);
  applyDeployModels(config.models);

  const imageKey = defaultImageModelKey();
  const slots = { reason: { key: 'reasoner', id: resolveModelId('reasoner') }, video: { key: VIDEO_SLOT, id: resolveModelId(VIDEO_SLOT) }, image: { key: imageKey, id: resolveModelId(imageKey) } };
  for (const [use, slot] of Object.entries(slots)) {
    if (!slot.id) await refuse(`E-INTAKE-SLOT-${slot.key.toUpperCase()}`, `the ${use} slot "${slot.key}" is not configured on the server — set ${MODEL_ENV_VARS[slot.key]}`);
  }
  const audioJudge = style.audio ? envSlot(AUDIO_JUDGE_ENV) : null;
  if (style.audio && !audioJudge) await refuse('E-INTAKE-SLOT-AUDIOJUDGE', `style.audio is true and no audio-capable judge slot is configured — set ${AUDIO_JUDGE_ENV} or declare audio false`);
  const tosMissing = TOS_ENV.filter((name) => !envSlot(name));
  if (tosMissing.length) await refuse('E-INTAKE-TOS', `the media store is not configured — set ${tosMissing.join(', ')}`);

  const engine = mode ?? policy.mode;
  if (engine === 'staged') {
    const window = { ...rulebook.ruleById('CIN-005').params, dMax: maxShotSeconds(VIDEO_SLOT) };
    const feas = feasibility(seconds, window);
    if (!feas.ok) await refuse('E-INTAKE-WINDOW', `${seconds} seconds is outside the CIN-005 window: ${feas.reason}`, { window });
  } else {
    const lo = policy.shots.secondsMin;
    const hi = Math.min(policy.shots.secondsMax, maxShotSeconds(VIDEO_SLOT));
    const kMin = Math.ceil(seconds / hi);
    const kMax = Math.floor(seconds / lo);
    if (kMin > kMax) await refuse('E-INTAKE-WINDOW', `${seconds} seconds cannot be cut into shots of ${lo}-${hi}s`, { secondsMin: lo, secondsMax: hi });
    await journal.write('window', { engine, seconds, kMin, kMax, dMin: lo, dMax: hi });
  }

  const gate = runPolicyGate(rulebook, 'POL-000', {
    intake: {
      audio: style.audio,
      slots: { video: slots.video.id, image: slots.image.id, reason: slots.reason.id, ...(audioJudge ? { audioJudge } : {}) },
      tos: tosMissing.length === 0,
      priceFileDate: prices.date,
      style,
      policyValues: policy,
    },
  });
  if (!gate.pass) await refuse('E-INTAKE-POL-000', `POL-000 refused: ${gate.blockers.map((b) => b.subject).join(', ')}`, { gate });

  const record = {
    runId,
    idea,
    ideaSource,
    seconds,
    style,
    styleHash: hashJson(style),
    styleFrom: styleIn.from,
    policy,
    policyHash: policyIn.hash,
    policyFrom: policyIn.from,
    prices,
    pricesHash: hashJson(prices),
    pricesFrom: pricesIn.from,
    rulesDir,
    rulebookVersion: rulebook.version,
    rubricsVersion: rubrics.version,
    server: { base: server, models: config.models, tosRegion: config.tosRegion || null },
    slots: { ...slots, audioJudge },
    audio: style.audio,
    tos: { ok: true, vars: TOS_ENV },
    window: { ...window, feasible: feas },
    gate: gate.results,
  };
  await journal.write('intake', record);
  return { ...record, rulebook, rubrics };
};

const enrichManifest = (manifest, plan) => ({
  ...manifest,
  shots: manifest.shots.map((sh) => {
    const p = plan.shots.find((x) => String(x.id) === String(sh.id));
    if (!p) fail('E-MANIFEST-SHOT', `manifest shot ${sh.id} is not in the plan`);
    return { ...sh, subject: p.subject, force: p.force, change: p.change, moment: p.moment, keyframe: p.keyframe };
  }),
});

const estimateUsd = (arithmetic, prices) => Math.round((arithmetic.stills.max * prices.usd.still + arithmetic.videoSeconds.max * prices.usd.videoSecond + arithmetic.judgeCalls.max * prices.usd.judgeCall) * 1e6) / 1e6;

const extOf = (url, fallback) => (String(url || '').match(/\.(png|jpe?g|webp|mp4)(?=[?#]|$)/i) || [, fallback])[1].toLowerCase();

const mediaExpected = (id, node, run) => {
  const kind = kindOf(id);
  const sid = shotOf(id);
  const url = node.value?.url || null;
  if (kind === 'plate') return { name: `plate-${sid.replace(/[^a-z0-9]+/gi, '_')}.${extOf(url, 'png')}`, url };
  if (kind === 'keyframe') return node.value?.needed ? { name: `keyframe-${sid}-attempt${node.attempts}.${extOf(url, 'png')}`, url } : null;
  if (kind === 'shoot') {
    const take = (run.takes?.[sid] || []).find((t) => t.takeId === node.value?.takeId);
    return { name: take ? `shoot-${sid}-attempt${take.attempt}.mp4` : `shoot-${sid}-attempt?.mp4`, url: take ? url : null };
  }
  if (id === 'assemble') {
    if (typeof node.value?.media !== 'string' || !node.value.media) fail('E-RESUME-ASSEMBLE-UNNAMED', 'the done assemble node names no media file — every assembled slice is journaled as slice-a<admission>.mp4');
    return { name: node.value.media, url };
  }
  return null;
};

const cascadeOf = (manifest, id) => {
  const kind = kindOf(id);
  const all = nodeIds(manifest, { flow: 'policy' });
  if (kind === 'plate') return all.filter((n) => n !== 'shots' && kindOf(n) !== 'plate');
  if (kind === 'keyframe' || kind === 'shoot') {
    const set = invalidationOf(manifest, shotOf(id), { flow: 'policy', mode: kind === 'keyframe' ? 'new-candidate' : 'same-keyframe' });
    return [...set.own.filter((n) => n !== id), ...set.successors, ...set.joins, 'assemble', 'final'];
  }
  if (id === 'assemble') return ['final'];
  return [];
};

const openAnswers = (entries) => {
  const answered = new Set(entries.filter((e) => e.kind === 'result').map((e) => e.data.intentId));
  return entries.filter((e) => e.kind === 'intent' && !answered.has(e.data.intentId));
};

const ledgerFromJournal = (entries, { iterations, startedAt }) => {
  const ledger = makeLedger({ iterations, startedAt });
  const reservations = entries.filter((e) => e.kind === 'reservation').map((e) => e.data);
  const lastRes = reservations.at(-1);
  if (lastRes) {
    for (const k of ['stills', 'takes', 'videoSeconds', 'judgeCalls', 'reasonCalls', 'usd']) ledger[k] = lastRes.after[k];
    ledger.reservations.push(...reservations);
  }
  const orphans = openAnswers(entries).filter((e) => e.data.call === 'render.start').map((e) => ({ intentId: e.data.intentId, shotId: e.data.shotId, seconds: e.data.seconds, step: e.step }));
  for (const o of orphans) {
    ledger.takes += 1;
    ledger.videoSeconds += typeof o.seconds === 'number' ? o.seconds : 0;
  }
  return { ledger, orphans };
};

const passContext = ({ runId, journal, policy, prices, style, rubrics, rulebook, stages, client, ledger }) => {
  if (!rulebook || typeof rulebook.ruleById !== 'function') fail('E-PASS-RULEBOOK', 'the pass context needs the loaded rulebook — one rulebook per pass, threaded through, never fetched twice');
  const stageRef = { current: 'intake' };
  const reserve = pricedReserve(makeReserve({ policy, journal, ledger, clock: Date.now }), prices);
  const wired = reservingClient(journaledClient(journal, client), { reserve, stageRef, journal });
  const executorStages = {
    plateQC: stages.plateQC,
    generateCandidates: stages.generateCandidates,
    scoreCandidate: stages.scoreCandidate,
    selectCandidate: stages.selectCandidate,
    takeQC: stages.takeQC,
  };
  return {
    stageRef,
    reserve,
    client: wired,
    pass: { policy, journal, reserve, stages: executorStages, style, rubrics, rulebook, runId },
  };
};

const iterationOf = (seq) => (seq.iterations.length ? seq.iterations.at(-1) : null);

const witness = async ({ ctx, journal, policy, project, seqId, style, rubrics, stages, runId }) => {
  const seq = sequenceById(project, seqId);
  const run = seq.run;
  const manifest = enrichManifest(manifestOf(seq, ctx.pass.rulebook), seq.plan);
  const nodeValue = (id) => run.nodes[id]?.value || null;
  const fileFault = (row) => journal.finding({ finding_id: newId('fnd'), runId, at: new Date().toISOString(), family: 'fault', severity: 'note', evidence: [], ...row });
  const joins = [];
  for (let i = 1; i < manifest.shots.length; i += 1) {
    const prev = manifest.shots[i - 1];
    const next = manifest.shots[i];
    const chain = nodeValue(`chain:${next.id}`);
    const a = nodeValue(`shoot:${prev.id}`);
    const b = nodeValue(`shoot:${next.id}`);
    const joinRef = `${prev.id}->${next.id}`;
    const held = Object.fromEntries([[prev.id, a?.held || null], [next.id, b?.held || null]].filter(([, h]) => h));
    if (Object.keys(held).length) {
      await journal.write('join.skipped', { joinRef, reason: 'still-hold', held });
      joins.push({ joinRef, skipped: 'still-hold', held });
      continue;
    }
    try {
      const out = await attemptStage({ journal, policy, stageRef: ctx.stageRef, stage: `join:${joinRef}`, run: async () => {
        if (!chain || !a || !b) fail('E-JOIN-UNMEASURED', `join ${joinRef} has no measured chain or takes on both sides`);
        return stages.joinQC({ prev: { shotId: prev.id, url: a.url, takeId: a.takeId }, next: { shotId: next.id, url: b.url, takeId: b.takeId }, joinType: chain.joinType, distance: chain.distance, rubrics, policy, client: ctx.client, journal });
      } });
      joins.push({ joinRef, findings: (out.findings || []).length });
    } catch (err) {
      await fileFault({ stage: 'join', code: 'E-JOINQC-FAULT', joinRef, shotId: next.id, detail: err.message });
      joins.push({ joinRef, fault: err.message });
    }
  }
  await journal.write('joins', { count: joins.length, joins });

  let film = null;
  const slice = nodeValue('assemble');
  try {
    film = await attemptStage({ journal, policy, stageRef: ctx.stageRef, stage: 'final', run: async () => {
      if (!slice?.url) fail('E-FILM-UNASSEMBLED', 'no assembled slice to judge');
      return stages.filmQC({ slice: { url: slice.url }, manifest, screenplay: { ...seq.screenplay, beats: seq.beats }, style, rubrics, policy, client: ctx.client, journal });
    } });
    await journal.write('film', { findings: (film.findings || []).length, calls: film.calls || [] });
  } catch (err) {
    await fileFault({ stage: 'final', code: 'E-FILMQC-FAULT', detail: err.message });
    await journal.write('film', { fault: err.message });
  }
  return { joins, film };
};

const maxBy = (rows, key, field) => {
  const out = new Map();
  for (const r of rows) out.set(String(r[key]), Math.max(out.get(String(r[key])) || 0, r[field]));
  return out;
};

export const journalPolicyGates = ({ rulebook, journal, policy, run }) => {
  if (!rulebook || typeof rulebook.ruleById !== 'function') fail('E-AUDIT-RULEBOOK', 'the policy audit runs under the loaded rulebook');
  if (!journal || typeof journal.entries !== 'function') fail('E-AUDIT-JOURNAL', 'the policy audit reads the pass journal');
  if (!run || typeof run !== 'object') fail('E-AUDIT-RUN', 'the policy audit reads the sequence run record');
  const of = (kind) => journal.entries(kind).map((e) => ({ step: e.step, at: e.at, ...e.data }));
  const spent = of('cost').filter((c) => c.disposition === 'kept').map((c) => ({ ...c, id: `cost step ${c.step}` }));
  const selections = of('selection');
  const plates = maxBy(spent.filter((c) => c.kind === 'still' && String(c.nodeId).startsWith('plate:') && Number.isInteger(c.attempt)), 'nodeId', 'attempt');
  const candidates = maxBy(selections.filter((s) => Number.isInteger(s.attempt)), 'shotId', 'attempt');
  const faults = maxBy(of('fault').filter((f) => Number.isInteger(f.faults)), 'id', 'faults');
  const attempts = [
    ...[...plates].map(([subject, used]) => ({ kind: 'plate', subject, used })),
    ...[...candidates].map(([shotId, used]) => ({ kind: 'candidate', subject: `keyframe:${shotId}`, used })),
    ...Object.entries(run.takes || {}).map(([shotId, rows]) => {
      const invalidated = run.nodes?.[`shoot:${shotId}`]?.invalidated || [];
      return { kind: 'shot', subject: `shoot:${shotId}`, used: rows.filter((t) => !invalidated.includes(t.takeId)).length };
    }),
    ...[...faults].map(([subject, used]) => ({ kind: 'fault', subject, used })),
  ];
  const regenerations = of('regeneration')
    .filter((r) => REGENERATE_MODES.includes(r.mode) && Number.isInteger(r.n) && r.n >= 1)
    .map((r) => ({ shotId: r.shotId, n: r.n, mode: r.mode }));
  const completions = of('completionDecision')
    .filter((c) => Array.isArray(c.takes) && !c.ruleId && COMPLETION_DECISIONS.includes(c.decision))
    .map((c) => ({ shot: { id: c.shotId }, decision: c.decision, attempts: [...c.takes.map((t) => ({ attempt: t.attempt, score: t.score })), ...(c.refused ? [{ refused: c.refused }] : []), ...(c.faulted ? [{ faulted: c.faulted }] : [])] }));
  const verdicts = of('finding')
    .filter((f) => f.family === 'qc' && f.code === 'E-RUBRIC-FAIL' && f.rubricId)
    .map((f) => ({ id: f.finding_id, rubricId: f.rubricId, action: f.disposition }));
  const generated = new Map();
  for (const c of of('candidate')) generated.set(String(c.shotId), (generated.get(String(c.shotId)) || 0) + 1);
  const latest = new Map(selections.map((s) => [String(s.shotId), s]));
  const selected = [...latest.values()].map((s) => ({
    shotId: s.shotId,
    candidates: generated.get(String(s.shotId)) || 0,
    winnerScore: s.score,
    shortfall: s.shortfall ? (typeof s.shortfall === 'string' ? s.shortfall : s.shortfall.code) : null,
  }));
  const payloads = {
    'POL-003': { reservations: of('reservation'), costs: spent },
    'POL-004': { policy, attempts },
    'POL-005': { policy, regenerations },
    'POL-007': { policy, completions },
    'POL-008': { policy, verdicts },
    'POL-011': { policy },
    'POL-013': { policy, selections: selected },
  };
  return Object.entries(payloads).map(([ruleId, payload]) => [ruleId, runPolicyGate(rulebook, ruleId, payload)]);
};

export const knowledgePolicyGates = ({ rulebook, policy, index }) => {
  if (!rulebook || typeof rulebook.ruleById !== 'function') fail('E-AUDIT-RULEBOOK', 'the policy audit runs under the loaded rulebook');
  if (!index || !Array.isArray(index.recurrence) || !Array.isArray(index.calibration?.judge)) fail('E-AUDIT-INDEX', 'the knowledge audit reads the folded index with its recurrence and judge calibration');
  const calibrations = index.calibration.judge.map((r) => ({ rubricId: r.rubricId, instances: r.instances, precision: r.precision, promoted: r.promote }));
  const recurrences = index.recurrence.map((r) => ({ signature: r.signature, runs: r.runs, ideas: r.ideas, proposed: r.propose }));
  return [
    ['POL-009', runPolicyGate(rulebook, 'POL-009', { policy, calibrations })],
    ['POL-010', runPolicyGate(rulebook, 'POL-010', { policy, recurrences })],
  ];
};

const recordPolicyAudit = async ({ journal, runId, scope, gates }) => {
  const results = gates.flatMap(([, g]) => g.results);
  const blockers = gates.flatMap(([, g]) => g.blockers);
  await journal.write('policy.audit', { scope, rules: gates.map(([ruleId, g]) => ({ ruleId, pass: g.pass, results: g.results.length, blockers: g.blockers.length })), results, blockers });
  for (const b of blockers) {
    await journal.finding({
      finding_id: newId('fnd'), runId, at: new Date().toISOString(), family: 'gate', stage: 'complete', severity: 'blocker', code: `E-POLICY-${b.ruleId}`,
      ruleId: b.ruleId, class: b.class, failureKind: b.failureKind, detail: `[${b.ruleId}] ${b.subject}: ${b.detail || `${JSON.stringify(b.value)} against ${b.threshold}`}`,
      value: b.value ?? null, threshold: b.threshold ?? null, evidence: [{ scope, subject: b.subject, value: b.value ?? null, threshold: b.threshold ?? null }],
    });
  }
  return { rules: gates.map(([ruleId, g]) => ({ ruleId, pass: g.pass })), blockers: blockers.length };
};

const recordReport = async ({ journal, project, runId, dir }) => {
  const built = buildReport({ entries: journal.entries(), project, runId, mediaDir: journal.paths.media });
  const reportPath = await writeReport(dir, built.text);
  await journal.write('report', { path: reportPath, bytes: Buffer.byteLength(built.text), guarantees: built.summary.guarantees.map((g) => ({ id: g.id, met: g.met })) });
  return reportPath;
};

const foldAndAudit = async ({ journal, runId, rulebook, policy, runsDir, knowledgeDir, reason }) => {
  const folded = await foldKnowledge({ runsDir, knowledgeDir, policy, reason, audit: (index) => knowledgePolicyGates({ rulebook, policy, index }) });
  await journal.write('kb.fold', { path: folded.path, runs: folded.index.totals.runs, findings: folded.index.totals.findings, signatures: folded.index.recurrence.length });
  const audit = await recordPolicyAudit({ journal, runId, scope: 'knowledge', gates: folded.gates });
  return { ...folded, audit };
};

const complete = async ({ journal, project, runId, dir, seqId, policy, rulebook, ledger, runsDir, knowledgeDir, status, startedAt }) => {
  const seq = sequenceById(project, seqId);
  const it = iterationOf(seq);
  if (!it) fail('E-COMPLETE-NO-ITERATION', 'the executor appended no iteration record — the pass cannot close without one');
  const audit = await recordPolicyAudit({ journal, runId, scope: 'journal', gates: journalPolicyGates({ rulebook, journal, policy, run: seq.run }) });
  const guarantees = summarize({ entries: journal.entries(), project, runId, mediaDir: journal.paths.media }).guarantees;
  const sliceUrl = seq.run?.nodes?.assemble?.value?.url || null;
  const assembled = journal.entries('assemble').at(-1);
  const slicePath = assembled ? path.join(journal.paths.media, assembled.data.media) : null;
  await journal.write('complete', {
    runId,
    status,
    iterationId: it.id,
    iterationStatus: it.status,
    sliceUrl,
    slicePath: slicePath && fs.existsSync(slicePath) ? slicePath : null,
    guarantees: guarantees.map((g) => ({ id: g.id, met: g.met, detail: g.detail })),
    ledger: { stills: ledger.stills, takes: ledger.takes, videoSeconds: ledger.videoSeconds, judgeCalls: ledger.judgeCalls, reasonCalls: ledger.reasonCalls, usd: ledger.usd, reservations: ledger.reservations.length },
    elapsedMs: Date.now() - Date.parse(startedAt),
  });
  const failures = await journal.drain();
  for (const err of failures) {
    await journal.finding({ finding_id: newId('fnd'), runId, at: new Date().toISOString(), family: 'fault', stage: 'complete', severity: 'blocker', code: 'E-JOURNAL-WRITE', detail: err.message, evidence: [] });
  }
  await saveProjectFs(dir, project);
  const folded = await foldAndAudit({ journal, runId, rulebook, policy, runsDir, knowledgeDir, reason: `pass ${runId} ${status}` });
  const reportPath = await recordReport({ journal, project, runId, dir });
  await journal.drain();
  await journal.close();
  return { status, runId, dir, report: reportPath, slice: slicePath && fs.existsSync(slicePath) ? slicePath : null, guarantees, journalFailures: failures.length, knowledge: folded.path, audit: { journal: audit, knowledge: folded.audit } };
};

const failPass = async ({ journal, project, runId, dir, seqId, stageRef, err, runsDir, knowledgeDir, policy, rulebook, startedAt }) => {
  const stage = err.stage || stageRef.current;
  await journal.write('pass.failed', { runId, stage, code: err.code || 'E-PASS-FAILED', detail: err.message });
  let next = project;
  const seq = sequenceById(next, seqId);
  if (seq && !seq.iterations.length) {
    next = appendIteration(next, seqId, {
      id: newId('it'),
      startedAt,
      finishedAt: new Date().toISOString(),
      inputs: { brief: seq.brief, briefHash: seq.brief ? fnv1a(JSON.stringify(seq.brief)) : null, manifestHash: null, prompts: (seq.plan?.shots || []).map((sh) => sh.prompt), platePrompts: (seq.plan?.plates || []).map((pl) => pl.prompt), rulebookVersion: seq.rulebookVersion, seed: seq.brief?.seed ?? null },
      runs: [],
      gates: [],
      measurements: { perShot: [], joins: [], timeline: null },
      artifacts: { takeIds: [], sliceUrl: null, plates: [] },
      cost: { renders: 0, retriesUsed: 0, silentShots: [] },
      notes: [],
      corrections: [],
      status: { failed: { stage, code: err.code || 'E-PASS-FAILED', reason: err.message } },
    });
  }
  await journal.drain();
  if (next) await saveProjectFs(dir, next);
  let reportPath = null;
  try {
    reportPath = await recordReport({ journal, project: next, runId, dir });
  } catch (reportErr) {
    await journal.write('fault', { node: 'report', stage: 'complete', reason: reportErr.message, kind: 'transient' });
  }
  let folded = { path: null };
  try {
    folded = await foldAndAudit({ journal, runId, rulebook, policy, runsDir, knowledgeDir, reason: `pass ${runId} failed at ${stage}` });
  } catch (foldErr) {
    await journal.write('fault', { node: 'kb.fold', stage: 'complete', reason: foldErr.message, kind: 'transient' });
  }
  await journal.drain();
  await journal.close();
  return { status: 'failed', runId, dir, report: reportPath, stage, code: err.code || 'E-PASS-FAILED', detail: err.message, slice: null, knowledge: folded.path };
};

const runTool = async ({ name, input, project, threadId, ctx, journal }) => {
  const tool = TOOLS[name];
  if (!tool) fail('E-TOOL', `no tool named ${name}`);
  const problem = tool.validate(input);
  if (problem) fail(`E-TOOL-${name.toUpperCase()}-INPUT`, problem);
  const thread = threadById(project, threadId);
  const result = await tool.run({ input, project, thread, ctx });
  await journal.write('tool', { name, input, output: result.output, cost: result.cost || 0 });
  if (Array.isArray(result.output?.gates)) {
    await journal.write('gate', { tool: name, results: result.output.gates, blockers: result.output.gates.filter((r) => r.blocking && !r.pass), attempts: result.output.attempts });
  }
  const next = appendMessage(result.project, threadId, { role: 'tool', text: '', tool: { name, input, output: result.output, approved: true, cost: result.cost || 0 } });
  if (result.output?.kind === 'error') fail(`E-TOOL-${name.toUpperCase()}`, result.output.error, { project: next });
  return next;
};

const synthesizeProject = async ({ idea, style, journal }) => {
  const title = idea.trim().slice(0, 48);
  let project = makeProject(title);
  project = setLook(project, { style: style.look.style, grade: style.look.grade, notes: '' });
  const references = [];
  for (const ref of style.references.filter((r) => r.role !== 'look')) {
    const name = ref.name.trim().toUpperCase();
    let plateUrl = null;
    if (ref.image) {
      const ext = (String(ref.image).match(/\.(png|jpe?g|webp)(?=[?#]|$)/i) || [, 'png'])[1].toLowerCase();
      await journal.media(`reference-${name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.${ext}`, ref.image);
      plateUrl = ref.image;
    }
    const entry = makeBibleEntry({ name, role: ref.role, plateUrl, notes: `style reference from ${style.id}` });
    project = touch({ ...project, bible: [...project.bible, entry] });
    references.push({ name, role: ref.role, bibleEntryId: entry.id, plateUrl });
  }
  const threadId = project.threads[0].id;
  const director = agentFor('director');
  if (!director || typeof director.latch !== 'function') fail('E-NO-DIRECTOR', 'the director agent is not registered in this build');
  const made = director.latch({ project, title });
  project = latchThread(made.project, threadId, 'director', { subjectId: made.subjectId, title }).project;
  await journal.write('project', { projectId: project.id, threadId, sequenceId: made.subjectId, look: project.look, references });
  return { project, threadId, seqId: made.subjectId, references };
};

const briefInputOf = (ideated, { references, style }) => {
  const byName = new Map(references.map((r) => [r.name, r.bibleEntryId]));
  const map = (entry) => (byName.has(entry.name) ? { ...entry, bibleEntryId: byName.get(entry.name) } : entry);
  return {
    ...ideated.brief,
    cast: ideated.brief.cast.map(map),
    locations: ideated.brief.locations.map(map),
    ...(Number.isInteger(style.seed) ? { seed: style.seed } : {}),
  };
};

export const runFilm = async ({ runsDir, knowledgeDir, rulesDir, runId, idea, ideaSource = 'argument', seconds, style, policy, prices, client, stages, server, mode = null, defaults = [] }) => {
  if (typeof runsDir !== 'string' || !runsDir) fail('E-ARGS-RUNS', 'runFilm needs the runs directory');
  if (typeof knowledgeDir !== 'string' || !knowledgeDir) fail('E-ARGS-KNOWLEDGE', 'runFilm needs the knowledge directory');
  if (typeof runId !== 'string' || !/^[a-z0-9_-]+$/i.test(runId)) fail('E-ARGS-RUNID', `runFilm needs a plain runId, got ${JSON.stringify(runId)}`);
  if (!client || typeof client.reason !== 'function') fail('E-ARGS-CLIENT', 'runFilm needs a client with reason(), generateImage(), startVideo() and pollVideo()');
  requireStages(stages);
  const dir = path.join(runsDir, runId);
  if (fs.existsSync(dir)) fail('E-ARGS-RUNID', `${dir} already exists — a pass never overwrites another pass's journal`);
  const raw = await openJournal({ dir });
  const journal = passJournal(raw, { runId });
  const startedAt = new Date().toISOString();
  await journal.write('pass', { runId, command: mode === 'extend' ? 'extend' : 'film', startedAt, server: server || null, cwd: process.cwd() });
  if (defaults.length) await journal.write('defaults', { flags: defaults });

  let intaken;
  try {
    intaken = await intake({ journal, runId, idea, ideaSource, seconds, style, policy, prices, rulesDir, server, mode });
  } catch (err) {
    await journal.drain();
    await journal.close();
    throw err;
  }

  const { style: styleValues, policy: policyValues, prices: priceValues, rulebook, rubrics } = intaken;
  const ledger = makeLedger({ iterations: 0, startedAt });
  const ctx = passContext({ runId, journal, policy: policyValues, prices: priceValues, style: styleValues, rubrics, rulebook, stages, client, ledger });
  const toolCtx = { client: ctx.client, modelId: null, requireSkillLine, policy: policyValues, rulebook, journal };
  const closing = { journal, runId, dir, runsDir, knowledgeDir, policy: policyValues, rulebook, startedAt };

  let project = null;
  let threadId = null;
  let seqId = null;
  try {
    const made = await synthesizeProject({ idea, style: styleValues, journal });
    project = made.project;
    threadId = made.threadId;
    seqId = made.seqId;
    const get = () => project;
    const apply = (fn) => { project = fn(project) || project; };
    const seq = () => sequenceById(project, seqId);
    const engine = mode ?? policyValues.mode;
    if (!['edit', 'staged', 'extend'].includes(engine)) fail('E-ARGS-MODE', `the engine mode is ${JSON.stringify(engine)} — edit, extend or staged, from --mode or policy.mode`);
    await journal.write('engine', { mode: engine, from: mode ? 'flag' : 'policy' });
    if (engine === 'edit' || engine === 'extend') {
      ctx.stageRef.current = engine;
      const startedRun = new Date().toISOString();
      const filmRules = loadFilmRules(path.join(rulesDir, 'film.json'));
      await journal.write('rules', { file: 'film.json', version: filmRules.version, ids: filmRules.rules.map((r) => r.id) });
      const loop = engine === 'extend' ? runExtend : runFilmLoop;
      const out = await loop({
        idea, style: styleValues, seconds, policy: policyValues, rules: filmRules, client: ctx.client, journal, reserve: ctx.reserve, runId,
        refs: (project.bible || []).filter((b) => b.plateUrl && b.assetId).map((b) => ({ name: b.name, role: b.role, url: b.plateUrl, assetId: b.assetId })),
        slot: 'seedance25',
        onPlan: async (plan) => {
          apply((prev) => setSequenceFields(prev, seqId, {
            brief: { logline: plan.logline, targetSeconds: seconds, format: { fps: 24, resolution: styleValues.format.resolution, ratio: styleValues.format.ratio, audio: styleValues.audio === true }, world: '', cast: (plan.references || []).filter((r) => r.role === 'character').map((r) => ({ name: r.name, role: 'character', bibleEntryId: 'new' })), locations: (plan.references || []).filter((r) => r.role === 'location').map((r) => ({ name: r.name, bibleEntryId: 'new' })), dramatis: { protagonist: plan.shots[0]?.subject || '', want: '', opposition: '' }, beats: null, look: styleValues.look, constraints: styleValues.constraints || [], seed: null },
            plan: { slot: 'seedance25', shots: plan.shots.map((sh) => ({ ...sh, side: 'L', location: (plan.references || []).find((r) => r.role === 'location')?.name || '', join: 'cut', beatId: sh.id, moment: sh.change, keyframe: { needed: false, reason: 'the film loop renders whole takes; no start frame' } })), plates: [] },
            rulebookVersion: rulebook.version,
            status: 'planned',
          }));
          await saveProjectFs(dir, project);
        },
      });
      const shotsPlan = out.plan.shots.map((sh) => ({ ...sh, side: 'L', location: (out.plan.references || []).find((r) => r.role === 'location')?.name || '', join: 'cut', beatId: sh.id, moment: sh.change, keyframe: { needed: false, reason: 'the film loop renders whole takes; no start frame' } }));
      const nodes = {};
      for (const r of out.references) nodes[`reference:${r.name}`] = { status: 'done', attempts: 1, value: { url: r.url, assetId: r.assetId } };
      for (const sh of out.shots) nodes[`shot:${sh.shotId}`] = { status: 'done', attempts: sh.attempts, value: sh.url ? { taskId: sh.takeId, takeId: sh.takeId, assetId: sh.assetId, url: sh.url, score: sh.score, shipped: sh.shipped } : { taskId: null, takeId: null, url: null, score: null, shipped: 'absent', absent: true } };
      nodes.assemble = { status: 'done', attempts: 1, value: { url: out.slice.url } };
      nodes.final = { status: 'done', attempts: 1, value: { totalMeasured: out.slice.totalMeasured, fps: out.slice.fps, deltaFromN: Math.round((out.slice.totalMeasured - seconds) * 1000) / 1000 } };
      const spent = out.shots.reduce((a, sh) => a + sh.attempts, 0) + out.references.length;
      apply((prev) => {
        let next = setSequenceFields(prev, seqId, {
          brief: { logline: out.plan.logline, targetSeconds: seconds, format: { fps: 24, resolution: styleValues.format.resolution, ratio: styleValues.format.ratio, audio: styleValues.audio === true }, world: '', cast: (out.plan.references || []).filter((r) => r.role === 'character').map((r) => ({ name: r.name, role: 'character', bibleEntryId: 'new' })), locations: (out.plan.references || []).filter((r) => r.role === 'location').map((r) => ({ name: r.name, bibleEntryId: 'new' })), dramatis: { protagonist: out.plan.shots[0]?.subject || '', want: '', opposition: '' }, beats: null, look: styleValues.look, constraints: styleValues.constraints || [], seed: null },
          plan: { slot: 'seedance25', shots: shotsPlan, plates: [] },
          rulebookVersion: rulebook.version,
          status: 'assembled',
          run: { manifestHash: null, messageId: null, threadId, startedAt: startedRun, nodes, spentRenders: spent, retryPoolLeft: 0, silentShots: [], runs: out.shots.map((sh) => ({ node: `shot:${sh.shotId}`, attempt: sh.attempts, outcome: sh.shipped })), gateResults: [], takes: {} },
        });
        next = appendIteration(next, seqId, {
          id: newId('it'), startedAt: startedRun, finishedAt: new Date().toISOString(),
          inputs: { briefHash: null, brief: null, manifestHash: null, prompts: out.plan.shots.map((sh) => sh.prompt), platePrompts: (out.plan.references || []).map((r) => r.prompt), rulebookVersion: rulebook.version, seed: null },
          runs: out.shots.map((sh) => ({ node: `shot:${sh.shotId}`, attempt: sh.attempts, outcome: sh.shipped })),
          gates: [], measurements: { perShot: [], joins: [], timeline: { totalMeasured: out.slice.totalMeasured, fps: out.slice.fps } },
          artifacts: { takeIds: out.shots.map((sh) => sh.takeId), sliceUrl: out.slice.url, plates: out.references.map((r) => r.url) },
          cost: { renders: spent, retriesUsed: 0, silentShots: [] }, notes: [], corrections: [], status: 'assembled',
        });
        return next;
      });
      await saveProjectFs(dir, project);
      await journal.write('filmQC.skipped', { reason: 'the film loop judges takes each round; film-level rubric QC is not part of it' });
      return await complete({ ...closing, project, seqId, ledger, status: 'complete' });
    }
    const stage = (name, run) => attemptStage({ journal, policy: policyValues, stageRef: ctx.stageRef, stage: name, run });

    const ideated = await stage('ideate', async () => {
      const out = await ideate({ idea, style: styleValues, seconds, policy: policyValues, client: ctx.client, journal });
      const derived = await policyGate({ journal, rulebook, ruleId: 'POL-001', stage: 'ideate', payload: { briefInput: out.provenance } });
      if (!derived.pass) fail('E-IDEATE-POL-001', `POL-001 refused the ideation: ${derived.blockers.map((b) => `${b.subject}: ${b.detail}`).join('; ')}`);
      return out;
    });
    const briefInput = briefInputOf(ideated, { references: made.references, style: styleValues });
    await journal.write('brief.input', { input: briefInput, provenance: ideated.provenance, calls: ideated.calls });

    project = await stage('brief', () => runTool({ name: 'brief', input: briefInput, project, threadId, ctx: toolCtx, journal }));
    await journal.write('brief', { brief: seq().brief, provenance: ideated.provenance, rulebookVersion: seq().rulebookVersion });
    await saveProjectFs(dir, project);

    project = await stage('screenplay', () => runTool({ name: 'screenplay', input: {}, project, threadId, ctx: toolCtx, journal }));
    await journal.write('screenplay', { scenes: seq().screenplay.scenes, beats: seq().beats });
    await saveProjectFs(dir, project);

    const planBudget = policyValues.attempts.fault;
    let plan = null;
    let rejected = [];
    for (let planAttempt = 1; ; planAttempt += 1) {
      ctx.stageRef.current = 'breakdown';
      project = await stage('breakdown', () => runTool({ name: 'breakdown', input: rejected.length ? { rejected } : {}, project, threadId, ctx: toolCtx, journal }));
      plan = seq().plan;
      await journal.write('plan', { attempt: planAttempt, budget: planBudget, slot: plan.slot, shots: plan.shots, plates: plan.plates, totalSeconds: plan.shots.reduce((a, sh) => a + sh.seconds, 0), rulebookVersion: seq().rulebookVersion });
      await saveProjectFs(dir, project);

      ctx.stageRef.current = 'keyframes';
      const kfGate = await policyGate({ journal, rulebook, ruleId: 'POL-012', stage: 'keyframes', payload: { shots: plan.shots } });
      const chainGate = await policyGate({ journal, rulebook, ruleId: 'POL-006', stage: 'keyframes', payload: { policy: policyValues, shots: plan.shots } });
      const planBlockers = [...kfGate.blockers, ...chainGate.blockers];
      await journal.write('keyframes', { attempt: planAttempt, budget: planBudget, decisions: plan.shots.map((sh) => ({ id: sh.id, join: sh.join, subject: sh.subject, location: sh.location, keyframe: sh.keyframe })), gate: [...kfGate.results, ...chainGate.results], blockers: planBlockers });
      if (!planBlockers.length) break;
      rejected = planBlockers.map((b) => `[${b.ruleId}] ${b.subject}: ${b.detail || `${JSON.stringify(b.value)} against ${b.threshold}`}`);
      if (planAttempt >= planBudget) fail('E-PLAN-POLICY-EXHAUSTED', `the plan failed its policy gates ${planAttempt} time(s) within policy.attempts.fault ${planBudget}: ${rejected.join('; ')}`, { stage: 'keyframes' });
      await journal.write('regeneration', { stage: 'plan', mode: 'plan-regenerate', attempt: planAttempt, budget: planBudget, cause: rejected.join('; '), ruleId: [...new Set(planBlockers.map((b) => b.ruleId))].join(','), blockers: planBlockers });
    }

    ctx.stageRef.current = 'approve';
    const manifest = enrichManifest(manifestOf(seq(), rulebook), plan);
    const spent = { stills: ledger.stills, takes: ledger.takes, videoSeconds: ledger.videoSeconds, judgeCalls: ledger.judgeCalls, usd: ledger.usd, iterations: seq().iterations.length };
    const unpriced = approveManifest({ manifest, policy: { ...policyValues, budget: { ...policyValues.budget, maxUsd: null } }, spent });
    const estimate = { usd: estimateUsd(unpriced.arithmetic, priceValues), from: 'stills.max × usd.still + videoSeconds.max × usd.videoSecond + judgeCalls.max × usd.judgeCall', pricesDate: priceValues.date };
    const priced = { ...manifest, estimate };
    const approval = approveManifest({ manifest: priced, policy: policyValues, spent });
    const approveGate = await policyGate({ journal, rulebook, ruleId: 'POL-002', stage: 'approve', payload: { manifest: priced, policy: policyValues, spent } });
    const manifestHash = fnv1a(JSON.stringify(manifestOf(seq(), rulebook)));
    await journal.write('approve', { manifestHash, ok: approval.ok, arithmetic: approval.arithmetic, refusals: approval.refusals, estimate, spent, gate: approveGate.results, policyHash: intaken.policyHash });
    if (!approval.ok) fail('E-APPROVE-REFUSED', approval.refusals.map((r) => `${r.code}: ${r.detail}`).join('; '));

    const prepared = TOOLS.sequence.prepare({ project, thread: threadById(project, threadId), rulebook });
    if (prepared.error) fail('E-SEQUENCE', prepared.error);
    project = appendMessage(project, threadId, { role: 'tool', text: '', tool: { name: 'sequence', input: {}, card: prepared.card, output: null, approved: true, cost: 0 } });
    const messageId = threadById(project, threadId).messages.at(-1).id;
    await journal.write('sequence.approved', { messageId, manifestHash: prepared.card.manifestHash, decidedBy: 'policy', policyHash: intaken.policyHash });
    await saveProjectFs(dir, project);

    ctx.stageRef.current = 'schedule';
    const persist = writeThrough({ dir, get });
    await runSequence({ client: ctx.client, threadId, messageId, get, apply: (fn) => { apply(fn); persist.touch(); }, pass: ctx.pass });
    await persist.flush();
    await saveProjectFs(dir, project);
    const after = seq();
    if (after.status === 'halted') {
      await journal.write('pass.halted', { runId, node: after.run.halted?.node || null, reason: after.run.halted?.reason || null, ruleId: after.run.halted?.ruleId || null });
      return complete({ ...closing, project, seqId, ledger, status: 'halted' });
    }
    if (after.status !== 'assembled') fail('E-SCHEDULE-SILENT', `the executor returned with the sequence ${after.status} — neither assembled nor halted`);

    await witness({ ctx, journal, policy: policyValues, project, seqId, style: styleValues, rubrics, stages, runId });
    return await complete({ ...closing, project, seqId, ledger, status: 'complete' });
  } catch (err) {
    if (err.project) project = err.project;
    else if (err.cause?.project) project = err.cause.project;
    return failPass({ ...closing, project, seqId, stageRef: ctx.stageRef, err });
  }
};

const loadRun = async ({ runsDir, runId }) => {
  if (typeof runId !== 'string' || !/^[a-z0-9_-]+$/i.test(runId)) fail('E-ARGS-RUNID', `a runId is a plain token, got ${JSON.stringify(runId)}`);
  const dir = path.join(runsDir, runId);
  if (!fs.existsSync(path.join(dir, 'journal.ndjson'))) fail('E-RUN-MISSING', `no journal at ${dir}`);
  return { dir };
};

const intakeOf = (journal, runId) => {
  const rec = journal.entries('intake').at(-1);
  if (!rec) fail('E-RUN-NO-INTAKE', `run ${runId} was refused at intake or never reached it — there is nothing to continue`);
  return { ...rec.data, at: rec.at };
};

export const resumeRun = async ({ runsDir, knowledgeDir, rulesDir, runId, client, stages, server }) => {
  requireStages(stages);
  const { dir } = await loadRun({ runsDir, runId });
  const raw = await openJournal({ dir });
  const journal = passJournal(raw, { runId });
  try {
    const rec = intakeOf(journal, runId);
    const completed = journal.entries('complete').filter((e) => e.data.status === 'complete');
    if (completed.length) fail('E-RESUME-COMPLETE', `run ${runId} completed at step ${completed.at(-1).step} — judge or report it instead`);
    if (journal.entries('pass.failed').length) fail('E-RESUME-FAILED', `run ${runId} failed before its schedule (${journal.entries('pass.failed').at(-1).data.code}) — start a new pass`);
    let project = await loadProjectFs(dir);
    const seq = project.sequences[0];
    const thread = project.threads.find((t) => t.kind === 'director' && t.subjectId === seq?.id);
    if (!seq || !thread) fail('E-RESUME-NO-SEQUENCE', `run ${runId} holds no director sequence`);
    if (!seq.plan || !seq.run) fail('E-RESUME-NO-RUN', `run ${runId} was killed before its schedule began — the plan is ${seq.plan ? 'saved' : 'missing'} and no run record exists; start a new pass`);
    const { rulebook, rubrics } = loadLaw(rulesDir);
    if (rulebook.version !== rec.rulebookVersion) fail('E-RESUME-RULEBOOK', `the rulebook changed since the pass began (${rec.rulebookVersion} -> ${rulebook.version}) — a pass runs under one law`);
    if (rubrics.version !== rec.rubricsVersion) fail('E-RESUME-RUBRICS', `the rubrics changed since the pass began (${rec.rubricsVersion} -> ${rubrics.version})`);
    applyDeployModels(rec.server.models);

    const mediaDir = journal.paths.media;
    const manifest = manifestOf(seq, rulebook);
    const kept = [];
    const restored = [];
    const dropped = [];
    const cascaded = [];
    const inflight = [];
    const faultsCleared = [];
    const nodes = {};
    const reset = async (id, why) => {
      const cur = nodes[id] || seq.run.nodes[id];
      if (!cur || cur.status !== 'done') return;
      nodes[id] = { ...cur, status: 'pending', value: null };
      cascaded.push({ id, why });
      if (kindOf(id) === 'shoot' && cur.value?.takeId) {
        await journal.cost({ nodeId: id, kind: 'take', units: secondsOf(manifest, shotOf(id)), disposition: 'wasted', code: 'E-WASTE-RESUME-DROPPED', takeId: cur.value.takeId, reservationId: cur.value.reservationId, detail: `resume dropped ${why}, which this take descended from` });
      }
    };
    for (const [id, node] of Object.entries(seq.run.nodes)) {
      let next = { ...node };
      if (node.faults) { faultsCleared.push(id); next = { ...next, faults: 0 }; }
      if (node.status === 'done') {
        const expected = mediaExpected(id, node, seq.run);
        if (expected && !fs.existsSync(path.join(mediaDir, expected.name))) {
          let back = null;
          if (expected.url) {
            try {
              back = await journal.media(expected.name, expected.url);
            } catch (err) {
              back = null;
              await journal.write('resume.media', { id, name: expected.name, url: expected.url, restored: false, reason: err.message });
            }
          }
          if (back) restored.push({ id, name: expected.name, url: expected.url });
          else {
            dropped.push({ id, expected: expected.name, url: expected.url });
            next = { ...next, status: 'pending', value: null };
          }
        }
        if (next.status === 'done') kept.push(id);
      } else if (node.status === 'running' || node.status === 'halted') {
        inflight.push({ id, status: node.status, taskId: node.value?.taskId || null });
        next = { ...next, status: 'pending' };
      }
      nodes[id] = next;
    }
    for (const d of dropped) for (const id of cascadeOf(manifest, d.id)) await reset(id, d.id);
    const keptAfter = kept.filter((id) => nodes[id].status === 'done');
    const { ledger, orphans } = ledgerFromJournal(journal.entries(), { iterations: seq.iterations.length, startedAt: rec.at || journal.entries('pass')[0]?.at || new Date().toISOString() });
    await journal.write('resume', { runId, kept: keptAfter, restored, dropped, cascaded, inflight, orphans, faultsCleared, ledger: { stills: ledger.stills, takes: ledger.takes, videoSeconds: ledger.videoSeconds, judgeCalls: ledger.judgeCalls, usd: ledger.usd }, server: server || null });
    project = setSequenceFields(project, seq.id, { status: 'executing', run: { ...seq.run, halted: null, nodes } });

    const ctx = passContext({ runId, journal, policy: rec.policy, prices: rec.prices, style: rec.style, rubrics, rulebook, stages, client, ledger });
    const closing = { journal, runId, dir, runsDir, knowledgeDir, policy: rec.policy, rulebook, startedAt: ledger.startedAt };
    const get = () => project;
    const apply = (fn) => { project = fn(project) || project; };
    try {
      ctx.stageRef.current = 'schedule';
      const persist = writeThrough({ dir, get });
      await runSequence({ client: ctx.client, threadId: thread.id, messageId: seq.run.messageId, get, apply: (fn) => { apply(fn); persist.touch(); }, pass: ctx.pass });
      await persist.flush();
      await saveProjectFs(dir, project);
      const after = sequenceById(project, seq.id);
      if (after.status === 'halted') {
        await journal.write('pass.halted', { runId, node: after.run.halted?.node || null, reason: after.run.halted?.reason || null, ruleId: after.run.halted?.ruleId || null });
        return await complete({ ...closing, project, seqId: seq.id, ledger, status: 'halted' });
      }
      if (after.status !== 'assembled') fail('E-SCHEDULE-SILENT', `the executor returned with the sequence ${after.status} — neither assembled nor halted`);
      await witness({ ctx, journal, policy: rec.policy, project, seqId: seq.id, style: rec.style, rubrics, stages, runId });
      return await complete({ ...closing, project, seqId: seq.id, ledger, status: 'complete' });
    } catch (err) {
      return failPass({ ...closing, project, seqId: seq.id, stageRef: ctx.stageRef, err });
    }
  } catch (err) {
    await journal.write('resume.refused', { runId, code: err.code || 'E-RESUME', detail: err.message });
    await journal.drain();
    await journal.close();
    throw err;
  }
};

export const judgeRun = async ({ runsDir, knowledgeDir, rulesDir, runId, client, stages, server }) => {
  requireStages(stages);
  const { dir } = await loadRun({ runsDir, runId });
  const raw = await openJournal({ dir });
  const journal = passJournal(raw, { runId });
  try {
    const rec = intakeOf(journal, runId);
    const project = await loadProjectFs(dir);
    const seq = project.sequences[0];
    if (!seq?.run?.nodes?.assemble?.value?.url) fail('E-JUDGE-UNASSEMBLED', `run ${runId} has no assembled slice to judge`);
    const { rulebook, rubrics } = loadLaw(rulesDir);
    applyDeployModels(rec.server.models);
    const { ledger } = ledgerFromJournal(journal.entries(), { iterations: seq.iterations.length, startedAt: rec.at || new Date().toISOString() });
    const ctx = passContext({ runId, journal, policy: rec.policy, prices: rec.prices, style: rec.style, rubrics, rulebook, stages, client, ledger });
    await journal.write('judge.start', { runId, rubricsVersion: rubrics.version, previousRubricsVersion: rec.rubricsVersion, server: server || null });
    const out = await witness({ ctx, journal, policy: rec.policy, project, seqId: seq.id, style: rec.style, rubrics, stages, runId });
    await journal.write('judge', { runId, rubricsVersion: rubrics.version, joins: out.joins, film: out.film ? { findings: (out.film.findings || []).length } : null });
    await journal.drain();
    await saveProjectFs(dir, project);
    await foldAndAudit({ journal, runId, rulebook, policy: rec.policy, runsDir, knowledgeDir, reason: `judge ${runId} under rubrics ${rubrics.version}` });
    const reportPath = await recordReport({ journal, project, runId, dir });
    await journal.drain();
    await journal.close();
    return { status: 'judged', runId, dir, report: reportPath, rubricsVersion: rubrics.version };
  } catch (err) {
    await journal.write('judge.refused', { runId, code: err.code || 'E-JUDGE', detail: err.message });
    await journal.drain();
    await journal.close();
    throw err;
  }
};

export const addNote = async ({ runsDir, runId, text, severity, shotRef = null, timecode = null, ruleRef = null }) => {
  if (!nonEmpty(text)) fail('E-NOTE-TEXT', 'a note carries the creator\'s words in --text');
  if (!SEVERITIES.includes(severity)) fail('E-NOTE-SEVERITY', `--severity must be one of ${SEVERITIES.join(', ')}`);
  if (timecode !== null && (typeof timecode !== 'number' || !Number.isFinite(timecode) || timecode < 0)) fail('E-NOTE-TIMECODE', `--timecode must be seconds >= 0, got ${JSON.stringify(timecode)}`);
  const { dir } = await loadRun({ runsDir, runId });
  const project = await loadProjectFs(dir);
  const seq = project.sequences[0];
  if (!seq) fail('E-NOTE-NO-SEQUENCE', `run ${runId} holds no sequence`);
  const it = iterationOf(seq);
  if (!it) fail('E-NOTE-NO-ITERATION', `run ${runId} has no iteration record yet — notes attach to a finished pass`);
  if (shotRef !== null && seq.plan && !seq.plan.shots.some((sh) => String(sh.id) === String(shotRef))) fail('E-NOTE-SHOT', `--shot ${shotRef} is not a shot of run ${runId} (${seq.plan.shots.map((sh) => sh.id).join(', ')})`);
  const record = { text: text.trim(), shotRef, timecode, ruleRef, severity, author: 'human' };
  const next = appendNote(project, seq.id, it.id, record);
  const saved = sequenceById(next, seq.id).iterations.at(-1).notes.at(-1);
  const raw = await openJournal({ dir });
  await raw.write('note', { runId, sequenceId: seq.id, iterationId: it.id, note: saved });
  await saveProjectFs(dir, next);
  await raw.close();
  return { runId, iterationId: it.id, note: saved };
};

export const regenerateReport = async ({ runsDir, runId }) => {
  const { dir } = await loadRun({ runsDir, runId });
  const raw = await openJournal({ dir });
  const project = fs.existsSync(path.join(dir, 'project.json')) ? await loadProjectFs(dir) : null;
  const built = buildReport({ entries: raw.entries(), project, runId, mediaDir: raw.paths.media });
  const file = await writeReport(dir, built.text);
  await raw.write('report', { path: file, bytes: Buffer.byteLength(built.text), regenerated: true, guarantees: built.summary.guarantees.map((g) => ({ id: g.id, met: g.met })) });
  await raw.close();
  return { runId, report: file, summary: built.summary };
};

const replayQueue = (name, items) => {
  let i = 0;
  return () => {
    if (i >= items.length) fail('E-REPLAY-EXHAUSTED', `the source journal has no more ${name} answers (${items.length} replayed) — the replay asked for a call the pass never made`);
    const next = items[i];
    i += 1;
    return next;
  };
};

export const replayWire = ({ entries, sourceDir, rulesDir, skillsDir, project }) => {
  const intentById = new Map(entries.filter((e) => e.kind === 'intent').map((e) => [e.data.intentId, e.data]));
  const results = (call) => entries.filter((e) => e.kind === 'result' && e.data.call === call).map((e) => ({ intent: intentById.get(e.data.intentId), result: e.data }));
  const answer = ({ result }) => {
    const { intentId, call, ms, ...rest } = result;
    if (rest.error) throw new Error(`replayed fault: ${rest.error.message || rest.error}`);
    return rest;
  };
  const nextReason = replayQueue('reason', results('reason'));
  const nextImage = replayQueue('generateImage', results('generateImage'));
  const nextStart = replayQueue('startVideo', results('startVideo'));
  const polls = new Map(results('pollVideo').map((r) => [r.intent?.taskId, r]));
  const client = {
    async reason() { return answer(nextReason()); },
    async generateImage() { return answer(nextImage()); },
    async startVideo() { return answer(nextStart()); },
    async pollVideo({ taskId }) {
      const r = polls.get(taskId);
      if (!r) fail('E-REPLAY-NO-ANSWER', `the source journal never polled task ${taskId}`);
      return answer(r);
    },
  };
  const intake = entries.find((e) => e.kind === 'intake')?.data;
  if (!intake) fail('E-REPLAY-NO-INTAKE', 'the source run has no intake record to replay');
  const mediaBySource = new Map(entries.filter((e) => e.kind === 'media').map((e) => [e.data.source, e.data.path]));
  const takes = Object.values(project?.sequences?.[0]?.run?.takes || {}).flat();
  const measures = entries.filter((e) => e.kind === 'measure').map((e) => e.data);
  const durationOf = (url) => {
    const take = takes.find((t) => t.url === url);
    const m = take ? measures.find((x) => x.takeId === take.takeId) : null;
    if (m) return { duration: m.measured, fps: m.fps, nbReadFrames: m.nbReadFrames };
    const final = entries.filter((e) => e.kind === 'final').map((e) => e.data).at(-1);
    const assemble = entries.filter((e) => e.kind === 'assemble').map((e) => e.data).at(-1);
    if (final && assemble && assemble.url === url) return { duration: final.totalMeasured, fps: final.fps, nbReadFrames: Math.round(final.totalMeasured * final.fps) };
    return fail('E-REPLAY-NO-ANSWER', `the source journal never measured ${url}`);
  };
  const skills = () => {
    if (!fs.existsSync(skillsDir)) fail('E-REPLAY-SKILLS', `no skills directory at ${skillsDir}`);
    return fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const text = fs.readFileSync(path.join(skillsDir, d.name, 'SKILL.md'), 'utf8');
      const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const models = fm ? [...fm[1].matchAll(/^\s*-\s*([A-Za-z0-9]+)\s*$/gm)].map((m) => m[1]) : [];
      return { id: d.name, name: d.name, description: '', text: fm ? fm[2] : text, models };
    });
  };
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchStub = async (input, init) => {
    const u = String(input);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes('/api/film/config')) return json({ models: intake.server.models, hasServerKey: true, tosRegion: intake.server.tosRegion || '' });
    if (u.includes('/api/rules')) { const b = readRuleBooks(rulesDir); return json({ cinematic: b.cinematic, screenwriting: b.screenwriting, metrics: b.metrics }); }
    if (u.includes('/api/film/skills')) return json({ skills: skills() });
    if (u.includes('/api/film/measure')) {
      const m = durationOf(body.url);
      return json({ ...m, width: 0, height: 0, hasAudio: null, firstHash: '0'.repeat(64), lastHash: '0'.repeat(64), replayed: true });
    }
    if (u.includes('/api/film/stitch')) {
      const assemble = entries.filter((e) => e.kind === 'assemble').map((e) => e.data).at(-1);
      if (!assemble) fail('E-REPLAY-NO-ANSWER', 'the source journal never assembled a slice');
      return json({ url: assemble.url, cacheUrl: assemble.url });
    }
    const file = mediaBySource.get(u);
    if (file && fs.existsSync(file)) return new Response(fs.readFileSync(file), { status: 200 });
    return fail('E-REPLAY-NO-ANSWER', `a dry replay never leaves the process and the source journal has no answer for ${u}`);
  };
  const candidates = entries.filter((e) => e.kind === 'candidate').map((e) => e.data);
  const scores = new Map(entries.filter((e) => e.kind === 'score').map((e) => [e.data.candidateId, e.data]));
  const takeVerdicts = entries.filter((e) => e.kind === 'qc' && !('kind' in e.data) && e.data.takeId).map((e) => e.data);
  const plateVerdicts = entries.filter((e) => e.kind === 'qc' && e.data.kind === 'plate').map((e) => e.data);
  const usedCandidates = new Set();
  const usedVerdicts = new Set();
  const usedPlateVerdicts = new Set();
  const stages = {
    plateQC: async ({ plate, journal }) => {
      const v = plateVerdicts.find((x) => x.entity === plate.entity && !usedPlateVerdicts.has(x));
      if (!v) fail('E-REPLAY-EXHAUSTED', `the source journal has no unused plate verdict for ${plate.entity}`);
      usedPlateVerdicts.add(v);
      await journal.write('qc', { kind: 'plate', entity: plate.entity, replayed: true, pass: v.pass, score: v.score, findings: v.findings || [] });
      return { pass: v.pass, score: v.score, findings: v.findings || [] };
    },
    generateCandidates: async ({ shot, k, journal, reserve }) => {
      const mine = candidates.filter((c) => String(c.shotId) === String(shot.id) && !usedCandidates.has(c.id)).slice(0, k);
      if (mine.length < k) fail('E-REPLAY-EXHAUSTED', `the source journal has ${mine.length} unused candidate(s) for shot ${shot.id}, ${k} were asked`);
      for (const c of mine) {
        usedCandidates.add(c.id);
        await reserve({ nodeId: `keyframe:${shot.id}`, kind: 'still', units: 1, justification: `replayed keyframe candidate ${c.id}` });
        await journal.write('candidate', { ...c, replayed: true });
      }
      return mine.map((c) => ({ id: c.id, url: c.url, path: c.path, shotId: c.shotId, attempt: c.attempt }));
    },
    scoreCandidate: async ({ candidate, journal }) => {
      const s = scores.get(candidate.id);
      if (!s) fail('E-REPLAY-NO-ANSWER', `the source journal never scored candidate ${candidate.id}`);
      await journal.write('score', { ...s, replayed: true });
      return { score: s.score, deterministic: s.deterministic, rubric: s.rubric };
    },
    selectCandidate,
    takeQC: async ({ take, shot, journal }) => {
      const v = takeVerdicts.find((x) => String(x.shotId) === String(shot.id) && !usedVerdicts.has(x));
      if (!v) fail('E-REPLAY-EXHAUSTED', `the source journal has no unused take verdict for shot ${shot.id}`);
      usedVerdicts.add(v);
      await journal.write('qc', { kind: 'take', shotId: shot.id, takeId: take.takeId, replayedFrom: v.takeId, pass: v.pass, score: v.score, findings: v.findings });
      return { pass: v.pass, score: v.score, findings: v.findings || [] };
    },
    joinQC: async ({ prev, next, journal }) => { await journal.write('qc', { kind: 'join', joinRef: `${prev.shotId}->${next.shotId}`, replayed: true, findings: [] }); return { findings: [] }; },
    filmQC: async ({ journal }) => { await journal.write('qc', { kind: 'film', replayed: true, findings: [] }); return { findings: [], verdicts: {}, calls: [] }; },
  };
  return { client, fetch: fetchStub, stages, sourceDir };
};

export const replayRun = async ({ runsDir, knowledgeDir, rulesDir, skillsDir, runId, dry }) => {
  if (dry !== true) fail('E-REPLAY-DRY', 'replay runs only with --dry: nothing leaves the process and nothing is paid');
  const { dir } = await loadRun({ runsDir, runId });
  const source = await openJournal({ dir });
  const entries = source.entries();
  await source.close();
  const rec = entries.find((e) => e.kind === 'intake')?.data;
  if (!rec) fail('E-REPLAY-NO-INTAKE', `run ${runId} was refused at intake — nothing to replay`);
  const project = fs.existsSync(path.join(dir, 'project.json')) ? await loadProjectFs(dir) : null;
  const wire = replayWire({ entries, sourceDir: dir, rulesDir, skillsDir, project });
  const n = fs.readdirSync(runsDir).filter((name) => name.startsWith(`${runId}-replay-`)).length + 1;
  const replayId = `${runId}-replay-${n}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = wire.fetch;
  try {
    const out = await runFilm({
      runsDir, knowledgeDir, rulesDir, runId: replayId,
      idea: rec.idea, ideaSource: `replay of ${runId}`, seconds: rec.seconds,
      style: { value: rec.style, from: `journal ${runId}` }, policy: { value: rec.policy, from: `journal ${runId}` }, prices: { value: rec.prices, from: `journal ${runId}` },
      client: wire.client, stages: wire.stages, server: `replay:${runId}`,
    });
    return { ...out, replayOf: runId };
  } finally {
    globalThis.fetch = realFetch;
  }
};

const BOOLEAN_FLAGS = ['dry'];

export const parseArgs = (argv) => {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (!key) fail('E-ARGS', `bad flag ${a}`);
      if (key in flags) fail('E-ARGS', `--${key} given twice`);
      if (eq > 0) flags[key] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.includes(key)) flags[key] = true;
      else {
        if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail('E-ARGS', `--${key} needs a value`);
        flags[key] = argv[i + 1];
        i += 1;
      }
    } else positional.push(a);
  }
  const [command, ...rest] = positional;
  return { command: command || null, positional: rest, flags };
};

const COMMANDS = {
  film: { required: ['idea', 'style', 'seconds', 'policy', 'prices'], optional: ['server', 'mode'], positional: 0 },
  extend: { required: ['idea'], optional: ['seconds', 'style', 'policy', 'prices', 'server', 'run-id'], positional: 0 },
  resume: { required: [], optional: ['server'], positional: 1 },
  judge: { required: [], optional: ['server'], positional: 1 },
  note: { required: ['text', 'severity'], optional: ['shot', 'timecode', 'rule'], positional: 1 },
  report: { required: [], optional: [], positional: 1 },
  kb: { required: [], optional: ['policy'], positional: [1, 2] },
  replay: { required: ['dry'], optional: [], positional: 1 },
};

export const USAGE = [
  'bravo extend --idea "<the story>" [--seconds 120] [--style <style.json>] [--policy <policy.json>] [--prices <prices.json>] [--server <url>]',
  'bravo film --idea <text|file> --style <style.json> --seconds N --policy <policy.json> --prices <prices.json> [--server <url>]',
  'bravo resume <runId> [--server <url>]',
  'bravo judge <runId> [--server <url>]',
  'bravo note <runId> --text "<the creator\'s words>" --severity blocker|note|taste [--shot <id>] [--timecode <seconds>] [--rule <id>]',
  'bravo report <runId>',
  'bravo kb fold --policy <policy.json> | kb query <term> | kb rebuild --policy <policy.json>',
  'bravo replay <runId> --dry',
].join('\n');

const checkArgs = ({ command, positional, flags }) => {
  const spec = COMMANDS[command];
  if (!spec) fail('E-ARGS', `unknown command ${JSON.stringify(command)}\n${USAGE}`);
  const wanted = Array.isArray(spec.positional) ? spec.positional : [spec.positional, spec.positional];
  if (positional.length < wanted[0] || positional.length > wanted[1]) fail('E-ARGS', `${command} takes ${wanted[0] === wanted[1] ? wanted[0] : `${wanted[0]}..${wanted[1]}`} argument(s)\n${USAGE}`);
  for (const key of spec.required) if (!(key in flags)) fail(`E-ARGS-MISSING-${key.toUpperCase()}`, `${command} needs --${key}\n${USAGE}`);
  for (const key of Object.keys(flags)) if (![...spec.required, ...spec.optional].includes(key)) fail('E-ARGS', `${command} does not take --${key}\n${USAGE}`);
};

const ideaArg = (value) => {
  if (fs.existsSync(value) && fs.statSync(value).isFile()) return { idea: fs.readFileSync(value, 'utf8'), ideaSource: `file ${value}` };
  return { idea: value, ideaSource: 'argument' };
};

const serverOf = (flags) => {
  const base = flags.server || process.env.BRAVO_TEST_URL || null;
  if (!base) fail('E-ARGS-SERVER', 'name the BRAVO server with --server <url> or BRAVO_TEST_URL — the CLI runs against a dev server through the relative-fetch shim');
  installRelativeFetch(base);
  return base;
};

export const main = async (argv, { cwd = process.cwd(), out = console.log } = {}) => {
  const parsed = parseArgs(argv);
  checkArgs(parsed);
  const { command, positional, flags } = parsed;
  const runsDir = path.join(cwd, 'runs');
  const knowledgeDir = path.join(cwd, 'knowledge');
  const rulesDir = path.join(cwd, 'rules');
  const skillsDir = path.join(cwd, 'skills');
  const print = (result) => out(JSON.stringify(result, null, 1));

  if (command === 'film') {
    const seconds = Number(flags.seconds);
    if (!Number.isInteger(seconds)) fail('E-ARGS-SECONDS', `--seconds must be an integer, got ${JSON.stringify(flags.seconds)}`);
    const server = serverOf(flags);
    const runId = newRunId();
    const result = await runFilm({
      runsDir, knowledgeDir, rulesDir, runId, ...ideaArg(flags.idea), seconds,
      style: { file: path.resolve(cwd, flags.style) }, policy: { file: path.resolve(cwd, flags.policy) }, prices: { file: path.resolve(cwd, flags.prices) },
      client: createBrowserClient(undefined), stages: realStages(), server, mode: flags.mode ?? null,
    });
    print(result);
    return result.status === 'complete' ? 0 : 1;
  }
  if (command === 'extend') {
    const defaults = [];
    const pick = (name, fallback) => { if (flags[name] === undefined) { defaults.push({ flag: name, value: fallback }); return fallback; } return flags[name]; };
    const seconds = Number(pick('seconds', '120'));
    if (!Number.isInteger(seconds)) fail('E-ARGS-SECONDS', `--seconds must be an integer, got ${JSON.stringify(flags.seconds)}`);
    const styleFile = pick('style', 'looks/default.json');
    const policyFile = pick('policy', 'policy/default.json');
    const pricesFile = pick('prices', 'policy/prices.json');
    const server = serverOf(flags);
    const runId = flags['run-id'] ?? newRunId();
    if (!/^[a-z0-9_-]+$/i.test(runId)) fail('E-ARGS-RUNID', `--run-id is a plain token, got ${JSON.stringify(runId)}`);
    const result = await runFilm({
      runsDir, knowledgeDir, rulesDir, runId, ...ideaArg(flags.idea), seconds,
      style: { file: path.resolve(cwd, styleFile) }, policy: { file: path.resolve(cwd, policyFile) }, prices: { file: path.resolve(cwd, pricesFile) },
      client: createBrowserClient(undefined), stages: realStages(), server, mode: 'extend', defaults,
    });
    print(result);
    return result.status === 'complete' ? 0 : 1;
  }
  if (command === 'resume') {
    const server = serverOf(flags);
    const result = await resumeRun({ runsDir, knowledgeDir, rulesDir, runId: positional[0], client: createBrowserClient(undefined), stages: realStages(), server });
    print(result);
    return result.status === 'complete' ? 0 : 1;
  }
  if (command === 'judge') {
    const server = serverOf(flags);
    const result = await judgeRun({ runsDir, knowledgeDir, rulesDir, runId: positional[0], client: createBrowserClient(undefined), stages: realStages(), server });
    print(result);
    return 0;
  }
  if (command === 'note') {
    const timecode = 'timecode' in flags ? Number(flags.timecode) : null;
    const result = await addNote({ runsDir, runId: positional[0], text: flags.text, severity: flags.severity, shotRef: flags.shot ?? null, timecode, ruleRef: flags.rule ?? null });
    print(result);
    return 0;
  }
  if (command === 'report') {
    const result = await regenerateReport({ runsDir, runId: positional[0] });
    print({ runId: result.runId, report: result.report, status: result.summary.status });
    return 0;
  }
  if (command === 'kb') {
    const [sub, term] = positional;
    if (sub === 'query') {
      if ('policy' in flags) fail('E-ARGS', `kb query does not take --policy\n${USAGE}`);
      print(queryKnowledge({ knowledgeDir, runsDir, term }));
      return 0;
    }
    if (sub === 'fold' || sub === 'rebuild') {
      if (!('policy' in flags)) fail('E-ARGS-MISSING-POLICY', `kb ${sub} needs --policy: a fold runs under the policy values whose criteria it applies\n${USAGE}`);
      const policy = loadPolicyValues(path.resolve(cwd, flags.policy)).values;
      const { rulebook } = loadLaw(rulesDir);
      const audit = (index) => knowledgePolicyGates({ rulebook, policy, index });
      const r = sub === 'fold'
        ? await foldKnowledge({ runsDir, knowledgeDir, policy, audit, reason: 'bravo kb fold' })
        : await rebuildKnowledge({ runsDir, knowledgeDir, policy, audit });
      print({ path: r.path, ...(sub === 'rebuild' ? { deleted: r.deleted } : {}), ...r.fold });
      return r.fold.audit.blockers ? 1 : 0;
    }
    fail('E-ARGS', `kb takes fold, query <term> or rebuild\n${USAGE}`);
  }
  if (command === 'replay') {
    const result = await replayRun({ runsDir, knowledgeDir, rulesDir, skillsDir, runId: positional[0], dry: flags.dry === true });
    print(result);
    return result.status === 'complete' ? 0 : 1;
  }
  return fail('E-ARGS', USAGE);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { console.error(err.message); process.exit(err.code && String(err.code).startsWith('E-ARGS') ? 2 : 1); },
  );
}
