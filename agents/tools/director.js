import { sequenceById, setSequenceFields } from '../../state/project.js';
import { defaultImageModelKey, maxShotSeconds, RES_BY_MODEL } from '../../utils/film/suiteConfig.js';
import { composeUnderSkill } from './compose.js';
import { runPlanGates } from '../director/gates.js';
import { feasibility, feasibleKs } from '../director/partition.js';
import { decideKeyframe } from '../director/policy.js';

const SLOT = 'seedance25';
const FORMAT_INPUT_KEYS = ['resolution', 'ratio', 'audio'];

const formatProblem = (format) => {
  if (!format || typeof format !== 'object' || Array.isArray(format)) return 'brief: needs "format" { resolution, ratio, audio } — the wire format is declared, never assumed';
  const unknown = Object.keys(format).filter((k) => !FORMAT_INPUT_KEYS.includes(k));
  if (unknown.length) return `brief: format carries unknown key(s) ${unknown.join(', ')} — fps is the law's (SCR-008), the rest is { resolution, ratio, audio }`;
  const missing = FORMAT_INPUT_KEYS.filter((k) => !(k in format));
  if (missing.length) return `brief: format is missing ${missing.join(', ')}`;
  if (!RES_BY_MODEL[SLOT].includes(format.resolution)) return `brief: format.resolution must be one of ${RES_BY_MODEL[SLOT].join(', ')} for slot ${SLOT} — got ${JSON.stringify(format.resolution)}`;
  if (typeof format.ratio !== 'string' || !format.ratio.trim()) return `brief: format.ratio must be a non-empty string — got ${JSON.stringify(format.ratio)}`;
  if (typeof format.audio !== 'boolean') return `brief: format.audio must be true or false — got ${JSON.stringify(format.audio)}`;
  return null;
};
const lawFps = (rulebook) => {
  const fps = rulebook.ruleById('SCR-008')?.params?.fps;
  if (!Number.isInteger(fps) || fps <= 0) throw new Error('E-TOOL-FPS: SCR-008 declares no params.fps — the brief\'s frame rate is the law\'s, never the tool\'s');
  return fps;
};

const seqOf = (project, thread) => (thread?.kind === 'director' ? sequenceById(project, thread.subjectId) : null);
const requirePolicy = (ctx) => {
  if (!ctx?.policy) throw new Error('director: ctx.policy is missing — pass the loaded policy values in the tool context; the plan gates read policy.antagonism.maxShareWithoutForce and assume nothing');
  return ctx.policy;
};
const requireRulebook = (ctx) => {
  if (typeof ctx?.rulebook?.ruleById !== 'function' || typeof ctx.rulebook.rulesFor !== 'function') throw new Error('E-TOOL-RULEBOOK: ctx.rulebook is missing — the pass threads its one loaded rulebook through the tool context; a tool never fetches its own');
  return ctx.rulebook;
};
const requireJournal = (ctx) => {
  if (typeof ctx?.journal?.write !== 'function') throw new Error('E-TOOL-JOURNAL: ctx.journal is missing — every plan gate report is journaled by the tool that ran it, and a tool without a journal refuses to plan');
  return ctx.journal;
};
const gateCtxOf = (ctx) => ({ maxSeconds: maxShotSeconds, policy: requirePolicy(ctx) });
const journalGate = (ctx, tool, row) => requireJournal(ctx).write('gate.attempt', { tool, ...row, pass: row.blockers.length === 0 });

const gateReport = (results) => results.filter((r) => !r.pass).map((r) => `[${r.ruleId}] ${r.subject}: ${r.detail || `${r.value} vs ${r.threshold}`}`);

const parseStrictJson = (content) => {
  const body = String(content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'not a JSON object' };
    return { parsed };
  } catch (e) {
    return { error: `not valid JSON (${e.message})` };
  }
};

export const brief = {
  name: 'brief',
  gated: false,
  describe: 'brief — { "logline", "targetSeconds", "format": {resolution, ratio, audio}, "world", "cast": [{name, role, bibleEntryId|"new"}], "locations": [{name, bibleEntryId|"new"}], "dramatis": {protagonist, want, opposition}, "beats"?: [""], "constraints"?: [""] }. Sets this sequence\'s brief. The format is the person\'s declaration (resolution, aspect ratio, audio on or off); fps comes from the rulebook. Ask the person for anything missing; never invent it.',
  validate: (input) => {
    if (!String(input.logline || '').trim()) return 'brief: needs a "logline"';
    if (!Number.isInteger(input.targetSeconds)) return 'brief: "targetSeconds" must be an integer';
    const format = formatProblem(input.format);
    if (format) return format;
    if (!input.dramatis) return 'brief: needs "dramatis" { protagonist, want, opposition }';
    const names = (Array.isArray(input.cast) ? input.cast : []).map((c) => String(c.name || '').trim().toUpperCase());
    if (!names.includes(String(input.dramatis.protagonist || '').trim().toUpperCase())) {
      return `brief: dramatis.protagonist must be the NAME of a cast member — got ${JSON.stringify(input.dramatis.protagonist)}, cast is ${names.join(', ') || '(empty)'}`;
    }
    return null;
  },
  run: async ({ input, project, thread, ctx }) => {
    const seq = seqOf(project, thread);
    if (!seq) return { project, cost: 0, output: { kind: 'error', error: 'this thread owns no sequence' } };
    const gateCtx = gateCtxOf(ctx);
    const rulebook = requireRulebook(ctx);
    requireJournal(ctx);

    const window = { ...rulebook.ruleById('CIN-005').params, dMax: maxShotSeconds(SLOT) };
    const feas = feasibility(input.targetSeconds, window);
    if (!feas.ok) return { project, cost: 0, output: { kind: 'error', error: `infeasible target: ${feas.reason}` } };
    if (Array.isArray(input.beats) && input.beats.length) {
      const ks = feasibleKs(input.targetSeconds, window);
      if (!ks.includes(input.beats.length)) {
        return { project, cost: 0, output: { kind: 'error', error: `${input.beats.length} beats cannot map one-per-shot: ${input.targetSeconds}s allows ${ks.join(' or ')} shots. Merge or split the beats, or change the length.` } };
      }
    }

    const briefRecord = {
      logline: String(input.logline).trim(),
      targetSeconds: input.targetSeconds,
      format: { fps: lawFps(rulebook), resolution: input.format.resolution, ratio: input.format.ratio, audio: input.format.audio },
      world: String(input.world || '').trim(),
      cast: Array.isArray(input.cast) ? input.cast : [],
      locations: Array.isArray(input.locations) ? input.locations : [],
      dramatis: input.dramatis,
      beats: Array.isArray(input.beats) ? input.beats : null,
      look: { style: project.look.style, grade: project.look.grade },
      constraints: Array.isArray(input.constraints) ? input.constraints : [],
      seed: Number.isInteger(input.seed) ? input.seed : null,
    };

    const gates = runPlanGates(rulebook, { brief: briefRecord }, gateCtx);
    const briefStage = gates.results.filter((r) => r.subject === 'brief' || rulebook.ruleById(r.ruleId)?.appliesTo === 'brief');
    const blockers = gates.blockers.filter((b) => ['brief'].includes(rulebook.ruleById(b.ruleId)?.appliesTo));
    await journalGate(ctx, 'brief', { phase: 'brief', attempt: 1, results: briefStage, blockers, reason: blockers.length ? gateReport(blockers).join('\n') : null });
    if (blockers.length) {
      return { project, cost: 0, output: { kind: 'error', error: `the brief fails its gates:\n${gateReport(blockers).join('\n')}`, gates: briefStage, attempts: [] } };
    }

    const next = setSequenceFields(project, seq.id, { brief: briefRecord, rulebookVersion: rulebook.version, status: 'briefed' });
    return { project: next, cost: 0, output: { kind: 'brief', sequenceId: seq.id, brief: briefRecord, feasible: feas, gates: briefStage, attempts: [] } };
  },
};

export const screenplay = {
  name: 'screenplay',
  gated: false,
  metered: true,
  describe: 'screenplay — {}. Writes this sequence\'s screenplay from its brief, under the screenwriting rulebook: scenes with sluglines, action, brace dialogue, a declared turn and side per scene, plus beats when the brief has none. Gated; a failing screenplay is not saved.',
  validate: () => null,
  run: async ({ input, project, thread, ctx }) => {
    const seq = seqOf(project, thread);
    if (!seq) return { project, cost: 0, output: { kind: 'error', error: 'this thread owns no sequence' } };
    if (!seq.brief) return { project, cost: 0, output: { kind: 'error', error: 'no brief yet — set the brief first' } };
    const gateCtx = gateCtxOf(ctx);
    const rulebook = requireRulebook(ctx);
    requireJournal(ctx);
    const ks = feasibleKs(seq.brief.targetSeconds, { ...rulebook.ruleById('CIN-005').params, dMax: maxShotSeconds(SLOT) });

    const system = [
      'You write the screenplay for a short film slice. Return ONLY a JSON object, no prose, no fences:',
      '{ "scenes": [{ "id", "slug": {"intExt": "INT"|"EXT", "location", "time"}, "action": ["..."], "dialogue": [{"character","line"}], "turn": {"from","to"}, "side": "L"|"R", "antagonism": true|false }], "beats": [{"id","text"}] }',
      '',
      'THE RULEBOOK (every plan-class rule below is machine-checked; a violation is rejected):',
      rulebook.doctrine(),
      '',
      'The goal is to TELL THE STORY: the declared protagonist pursues the want, the opposition acts against it on screen, every scene turns. Use the brief\'s beats when given; otherwise invent beats and include them.',
      'NAMES ARE FIXED: character cues and slugline locations use the brief\'s cast and location names, spelled exactly (uppercase is fine). Never invent a sub-location or an unnamed extra — if the story needs one, it is a question back to the person, not an invention. Mark a scene "antagonism": true when the opposition acts in it.',
      `BEAT COUNT IS STRUCTURAL: each beat becomes exactly one shot, so produce ${ks.join(' or ')} beats — no other count fits ${seq.brief.targetSeconds} seconds.`,
    ].join('\n');

    let calls = 0;
    let payload = null;
    let failure = null;
    const attempts = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ask = attempt === 0
        ? `THE BRIEF:\n${JSON.stringify(seq.brief, null, 1)}`
        : `THE BRIEF:\n${JSON.stringify(seq.brief, null, 1)}\n\nYOUR LAST ATTEMPT WAS REJECTED:\n${failure}\n\nReturn the corrected JSON only.`;
      // eslint-disable-next-line no-await-in-loop
      const { content } = await ctx.client.reason({ prompt: ask, systemPrompt: system, modelId: ctx.modelId });
      calls += 1;
      const { parsed, error } = parseStrictJson(content);
      if (error) { failure = error; attempts.push({ attempt: attempt + 1, blockers: [], reason: failure }); continue; }
      const candidate = { brief: seq.brief, screenplay: { scenes: parsed.scenes || [] } };
      const gates = runPlanGates(rulebook, candidate, gateCtx);
      const staged = gates.results.filter((r) => ['brief', 'screenplay'].includes(rulebook.ruleById(r.ruleId)?.appliesTo));
      const landed = gates.pass || gates.haltedAt === 'shotplan';
      await journalGate(ctx, 'screenplay', { phase: 'screenplay', attempt: attempt + 1, results: staged, blockers: landed ? [] : gates.blockers, reason: landed ? null : gateReport(gates.blockers).join('\n') });
      if (landed) {
        payload = { scenes: (parsed.scenes || []).map((sc) => ({ ...sc, id: String(sc.id) })), beats: seq.brief.beats
          ? seq.brief.beats.map((t, i) => ({ id: `b${i + 1}`, text: t }))
          : (parsed.beats || []).map((b) => ({ ...b, id: String(b.id) })), gates: gates.results.filter((r) => ['brief', 'screenplay'].includes(rulebook.ruleById(r.ruleId)?.appliesTo)) };
        break;
      }
      failure = gateReport(gates.blockers).join('\n');
      attempts.push({ attempt: attempt + 1, blockers: gates.blockers, reason: failure });
    }

    if (!payload) {
      return { project, cost: calls, output: { kind: 'error', error: `the screenplay failed its gates twice and was NOT saved:\n${failure}`, gates: [], attempts } };
    }
    if (!payload.beats.length) {
      return { project, cost: calls, output: { kind: 'error', error: 'no beats: the brief has none and the screenplay surfaced none' } };
    }
    if (!ks.includes(payload.beats.length)) {
      return { project, cost: calls, output: { kind: 'error', error: `${payload.beats.length} beats cannot map one-per-shot: ${seq.brief.targetSeconds}s allows ${ks.join(' or ')} shots` } };
    }

    const next = setSequenceFields(project, seq.id, { screenplay: { scenes: payload.scenes }, beats: payload.beats, status: 'written' });
    return {
      project: next,
      cost: calls,
      output: {
        kind: 'screenplay',
        sequenceId: seq.id,
        scenes: payload.scenes,
        beats: payload.beats,
        gatesPassed: [...new Set(payload.gates.filter((g) => g.pass).map((g) => g.ruleId))],
        gates: payload.gates,
        attempts,
      },
    };
  },
};

export const breakdown = {
  name: 'breakdown',
  gated: false,
  metered: true,
  describe: 'breakdown — {}. Turns the screenplay into the shot plan: setups from the camera library, sides, planned seconds summing to the target, per-shot prompts composed under the bound spec, plate line items for new entities. Every plan gate must pass or nothing is saved.',
  validate: (input) => {
    if ('rejected' in input && !(Array.isArray(input.rejected) && input.rejected.length && input.rejected.every((r) => typeof r === 'string' && r.trim()))) {
      return 'breakdown: "rejected" is the list of reasons a previous plan was refused by policy — a non-empty list of strings, or absent';
    }
    return null;
  },
  run: async ({ input, project, thread, ctx }) => {
    const seq = seqOf(project, thread);
    if (!seq) return { project, cost: 0, output: { kind: 'error', error: 'this thread owns no sequence' } };
    if (!seq.screenplay) return { project, cost: 0, output: { kind: 'error', error: 'no screenplay yet — write it first' } };
    const gateCtx = gateCtxOf(ctx);
    const rulebook = requireRulebook(ctx);
    requireJournal(ctx);
    const rejected = Array.isArray(input.rejected) ? input.rejected : [];
    const maxShare = gateCtx.policy.antagonism?.maxShareWithoutForce;
    if (typeof maxShare !== 'number') throw new Error(`breakdown: policy.antagonism.maxShareWithoutForce must be a number — got ${JSON.stringify(maxShare ?? null)}`);

    const window = { ...rulebook.ruleById('CIN-005').params, dMax: maxShotSeconds(SLOT) };
    const feas = feasibility(seq.brief.targetSeconds, window, seq.beats.length);
    if (!feas.ok) return { project, cost: 0, output: { kind: 'error', error: feas.reason } };
    if (feas.k !== seq.beats.length) {
      return { project, cost: 0, output: { kind: 'error', error: `${seq.beats.length} beats but the partition admits ${feas.k} shots — the screenplay stage should have refused this` } };
    }

    const vocab = rulebook.ruleById('CIN-001').params.vocabulary;
    const system = [
      'You break a screenplay into a shot plan. Return ONLY a JSON object, no prose, no fences:',
      `{ "shots": [{ "id", "sceneId", "beatId", "subject": "a cast name, spelled as the brief spells it", "force": "one sentence: the antagonism acting in this shot and how it is visible, or the literal none", "change": "first-frame state -> last-frame state", "setup", "side": "L"|"R", "seconds", "location", "join": "cut"|"continuous", "moment": "what CHANGES in this shot — from one state to another, one sentence", "dialogue": ["exact line from the screenplay"] }] }`,
      '',
      `Setups must come from this vocabulary: ${vocab.join(' | ')}`,
      `Seconds: use EXACTLY these integers, one per shot, reordering allowed, nothing else sums correctly: ${feas.partition.join(', ')}`,
      'Every beat gets at least one shot; every shot serves exactly one beat. Shot sides match their scene. The first shot at each location is a wide or full setup. Every dialogue line lands in exactly one shot. Shot locations use the slugline location names exactly — no sub-locations.',
      'JOINS: every shot after the first declares its join. A "cut" is the default and the storyteller\'s tool — the image changes: new setup, new distance, new information. "continuous" means one unbroken action crosses the boundary and the frame carries straight through; use it only when the beat demands it. A film of only continuous joins is a single drifting take, not an edited scene.',
      `SUBJECT, FORCE, CHANGE: every shot names who is in frame (a cast name), the force of antagonism acting in that shot and how the camera sees it, and what changes from the shot's first frame to its last. The literal "none" is the force only where the opposition is absent from the frame; at most ${Math.round(maxShare * 100)}% of the shots may carry "none", and a plan past that share is refused.`,
      'CONTINUOUS JOINS keep the subject and the location of the shot before them; a change of subject or location is a cut, declared as one.',
      '',
      'THE RULEBOOK:',
      rulebook.doctrine(),
    ].join('\n');

    let calls = 0;
    let structure = null;
    let failure = null;
    const attempts = [];
    const material = `THE BRIEF:\n${JSON.stringify(seq.brief, null, 1)}\n\nTHE BEATS:\n${JSON.stringify(seq.beats)}\n\nTHE SCREENPLAY:\n${JSON.stringify(seq.screenplay, null, 1)}`;
    const policyRejection = rejected.length ? `\n\nA PREVIOUS PLAN FOR THIS SCREENPLAY WAS REFUSED BY POLICY — plan so that none of these recur:\n${rejected.map((r) => `- ${r}`).join('\n')}` : '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ask = attempt === 0
        ? `${material}${policyRejection}`
        : `${material}${policyRejection}\n\nYOUR LAST ATTEMPT WAS REJECTED:\n${failure}\n\nReturn the corrected JSON only.`;
      // eslint-disable-next-line no-await-in-loop
      const { content } = await ctx.client.reason({ prompt: ask, systemPrompt: system, modelId: ctx.modelId });
      calls += 1;
      const { parsed, error } = parseStrictJson(content);
      if (error) { failure = error; attempts.push({ attempt: attempt + 1, blockers: [], reason: failure }); continue; }
      const shots = (parsed.shots || []).map((sh, i) => ({ ...sh, id: String(sh.id), sceneId: String(sh.sceneId), beatId: String(sh.beatId), join: i === 0 ? null : sh.join, prompt: '', flags: Array.isArray(sh.flags) ? sh.flags : [] }));
      const badJoin = shots.slice(1).find((sh) => !['cut', 'continuous'].includes(sh.join));
      if (badJoin) {
        failure = `shot ${badJoin.id}: every shot after the first declares "join": "cut" or "continuous" — got ${JSON.stringify(badJoin.join ?? null)}`;
        attempts.push({ attempt: attempt + 1, blockers: [], reason: failure });
        continue;
      }
      const candidate = {
        slot: SLOT,
        brief: seq.brief,
        screenplay: seq.screenplay,
        beats: seq.beats,
        shots,
        plates: [],
      };
      const structural = runPlanGates(rulebook, candidate, gateCtx);
      const structuralBlockers = structural.blockers.filter((b) => !['SCR-006', 'SCR-007'].includes(b.ruleId));
      await journalGate(ctx, 'breakdown', { phase: 'structure', attempt: attempt + 1, results: structural.results, blockers: structuralBlockers, reason: structuralBlockers.length ? gateReport(structuralBlockers).join('\n') : null });
      if (!structuralBlockers.length) { structure = shots; break; }
      failure = gateReport(structuralBlockers).join('\n');
      attempts.push({ attempt: attempt + 1, blockers: structuralBlockers, reason: failure });
    }

    if (!structure) {
      return { project, cost: calls, output: { kind: 'error', error: `the shot structure failed its gates twice and was NOT saved:\n${failure}`, gates: [], attempts } };
    }

    const lookLine = [seq.brief.look?.style, seq.brief.look?.grade].filter(Boolean).join(' · ');
    const shots = [];
    for (let i = 0; i < structure.length; i += 1) {
      const sh = structure[i];
      const keyframe = decideKeyframe(sh, i > 0 ? structure[i - 1] : null);
      if (typeof keyframe?.needed !== 'boolean' || !String(keyframe?.reason || '').trim()) {
        throw new Error(`shot ${sh.id}: decideKeyframe returned ${JSON.stringify(keyframe ?? null)} — a keyframe decision is { needed: boolean, reason }`);
      }
      // eslint-disable-next-line no-await-in-loop
      const composed = await composeUnderSkill({
        modelKey: SLOT,
        title: sh.moment,
        note: `${sh.setup}${sh.join ? ` (arrives by ${sh.join === 'cut' ? 'a hard cut — the image must read differently from the previous shot at once' : 'continuous action — the frame carries through'})` : ''}. SUBJECT: ${sh.subject}. FORCE: ${sh.force}. CHANGE: ${sh.change}. The story advances here: ${sh.moment}`,
        refs: [],
        dialogue: Array.isArray(sh.dialogue) ? sh.dialogue : [],
        lookLine,
        extraDoctrine: 'The prompt puts the SUBJECT in frame, makes the FORCE visible the way the note describes it, and plays the CHANGE from the first frame to the last.',
        ctx,
      });
      calls += composed.calls;
      if (composed.problems.length) {
        return { project, cost: calls, output: { kind: 'error', error: `shot ${sh.id}: prompt failed its gates twice and nothing was saved:\n${composed.problems.map((x) => `- ${x}`).join('\n')}` } };
      }
      shots.push({ ...sh, prompt: composed.prompt, keyframe });
    }

    const newRaw = [
      ...(seq.brief.cast || []).map((e) => ({ ...e, kind: 'cast' })),
      ...(seq.brief.locations || []).map((e) => ({ ...e, kind: 'loc' })),
    ].filter((e) => e.bibleEntryId === 'new');
    const newEntities = [];
    for (const e of newRaw) {
      // eslint-disable-next-line no-await-in-loop
      const composed = await composeUnderSkill({
        modelKey: defaultImageModelKey(),
        title: e.name,
        note: `a reference plate for ${e.name}, drawn from the world of the brief: ${seq.brief.world || seq.brief.logline}`,
        plate: true,
        lookLine,
        ctx,
      });
      calls += composed.calls;
      if (composed.problems.length) {
        return { project, cost: calls, output: { kind: 'error', error: `plate for "${e.name}": prompt failed its gates twice:\n${composed.problems.map((x) => `- ${x}`).join('\n')}` } };
      }
      newEntities.push({ entity: e.name, role: e.kind === 'cast' ? (e.role || 'character') : 'location', prompt: composed.prompt, model: defaultImageModelKey() });
    }

    const plan = { slot: SLOT, shots, plates: newEntities };
    const full = runPlanGates(rulebook, { ...plan, brief: seq.brief, screenplay: seq.screenplay, beats: seq.beats }, gateCtx);
    await journalGate(ctx, 'breakdown', { phase: 'plan', attempt: attempts.length + 1, results: full.results, blockers: full.blockers, reason: full.pass ? null : gateReport(full.blockers).join('\n') });
    if (!full.pass) {
      return { project, cost: calls, output: { kind: 'error', error: `the completed plan fails:\n${gateReport(full.blockers).join('\n')}`, gates: full.results, attempts } };
    }

    const next = setSequenceFields(project, seq.id, { plan, status: 'planned' });
    return {
      project: next,
      cost: calls,
      output: {
        kind: 'plan',
        sequenceId: seq.id,
        shots: shots.map((sh) => ({ id: sh.id, beatId: sh.beatId, subject: sh.subject, force: sh.force, change: sh.change, setup: sh.setup, side: sh.side, seconds: sh.seconds, location: sh.location, join: sh.join, keyframe: sh.keyframe, prompt: sh.prompt })),
        plates: newEntities,
        gatesPassed: [...new Set(full.results.filter((g) => g.pass).map((g) => g.ruleId))],
        gates: full.results,
        attempts,
        totalSeconds: shots.reduce((a, b) => a + b.seconds, 0),
      },
    };
  },
};
