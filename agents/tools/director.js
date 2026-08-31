import { sequenceById, setSequenceFields } from '../../state/project.js';
import { defaultImageModelKey, maxShotSeconds } from '../../utils/film/suiteConfig.js';
import { composeUnderSkill } from './compose.js';
import { runPlanGates } from '../director/gates.js';
import { requireRulebook } from '../director/rulebook.js';
import { feasibility, feasibleKs } from '../director/partition.js';

const SLOT = 'seedance25';

const seqOf = (project, thread) => (thread?.kind === 'director' ? sequenceById(project, thread.subjectId) : null);
const gateCtx = { maxSeconds: maxShotSeconds };

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
  describe: 'brief — { "logline", "targetSeconds", "world", "cast": [{name, role, bibleEntryId|"new"}], "locations": [{name, bibleEntryId|"new"}], "dramatis": {protagonist, want, opposition}, "beats"?: [""], "constraints"?: [""] }. Sets this sequence\'s brief. Ask the person for anything missing; never invent it.',
  validate: (input) => {
    if (!String(input.logline || '').trim()) return 'brief: needs a "logline"';
    if (!Number.isInteger(input.targetSeconds)) return 'brief: "targetSeconds" must be an integer';
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
    const rulebook = await requireRulebook();

    const kMin = 2;
    const kMax = 4;
    const window = { kMin, kMax, dMin: 3, dMax: maxShotSeconds(SLOT) };
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
      format: { fps: 24, resolution: '720p', ratio: 'adaptive', audio: true },
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
    const briefStage = gates.results.filter((r) => r.ruleId === 'SCR-008' || r.ruleId === 'SCR-002');
    const blockers = gates.blockers.filter((b) => ['brief'].includes(rulebook.ruleById(b.ruleId)?.appliesTo));
    if (blockers.length) {
      return { project, cost: 0, output: { kind: 'error', error: `the brief fails its gates:\n${gateReport(blockers).join('\n')}` } };
    }
    void briefStage;

    const next = setSequenceFields(project, seq.id, { brief: briefRecord, rulebookVersion: rulebook.version, status: 'briefed' });
    return { project: next, cost: 0, output: { kind: 'brief', sequenceId: seq.id, brief: briefRecord, feasible: feas } };
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
    const rulebook = await requireRulebook();
    const ks = feasibleKs(seq.brief.targetSeconds, { kMin: 2, kMax: 4, dMin: 3, dMax: maxShotSeconds(SLOT) });

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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ask = attempt === 0
        ? `THE BRIEF:\n${JSON.stringify(seq.brief, null, 1)}`
        : `THE BRIEF:\n${JSON.stringify(seq.brief, null, 1)}\n\nYOUR LAST ATTEMPT WAS REJECTED:\n${failure}\n\nReturn the corrected JSON only.`;
      // eslint-disable-next-line no-await-in-loop
      const { content } = await ctx.client.reason({ prompt: ask, systemPrompt: system, modelId: ctx.modelId });
      calls += 1;
      const { parsed, error } = parseStrictJson(content);
      if (error) { failure = error; continue; }
      const candidate = { brief: seq.brief, screenplay: { scenes: parsed.scenes || [] } };
      const gates = runPlanGates(rulebook, candidate, gateCtx);
      if (gates.pass || gates.haltedAt === 'shotplan') {
        payload = { scenes: parsed.scenes || [], beats: seq.brief.beats
          ? seq.brief.beats.map((t, i) => ({ id: `b${i + 1}`, text: t }))
          : (parsed.beats || []), gates: gates.results.filter((r) => r.ruleId.startsWith('SCR') || r.ruleId.startsWith('CIN')) };
        break;
      }
      failure = gateReport(gates.blockers).join('\n');
    }

    if (!payload) {
      return { project, cost: calls, output: { kind: 'error', error: `the screenplay failed its gates twice and was NOT saved:\n${failure}` } };
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
      },
    };
  },
};

export const breakdown = {
  name: 'breakdown',
  gated: false,
  metered: true,
  describe: 'breakdown — {}. Turns the screenplay into the shot plan: setups from the camera library, sides, planned seconds summing to the target, per-shot prompts composed under the bound spec, plate line items for new entities. Every plan gate must pass or nothing is saved.',
  validate: () => null,
  run: async ({ input, project, thread, ctx }) => {
    const seq = seqOf(project, thread);
    if (!seq) return { project, cost: 0, output: { kind: 'error', error: 'this thread owns no sequence' } };
    if (!seq.screenplay) return { project, cost: 0, output: { kind: 'error', error: 'no screenplay yet — write it first' } };
    const rulebook = await requireRulebook();

    const window = { kMin: 2, kMax: 4, dMin: 3, dMax: maxShotSeconds(SLOT) };
    const feas = feasibility(seq.brief.targetSeconds, window, seq.beats.length);
    if (!feas.ok) return { project, cost: 0, output: { kind: 'error', error: feas.reason } };
    if (feas.k !== seq.beats.length) {
      return { project, cost: 0, output: { kind: 'error', error: `${seq.beats.length} beats but the partition admits ${feas.k} shots — the screenplay stage should have refused this` } };
    }

    const vocab = rulebook.ruleById('CIN-001').params.vocabulary;
    const system = [
      'You break a screenplay into a shot plan. Return ONLY a JSON object, no prose, no fences:',
      `{ "shots": [{ "id", "sceneId", "beatId", "setup", "side": "L"|"R", "seconds", "location", "moment": "what this shot IS, one sentence of state", "dialogue": ["exact line from the screenplay"] }] }`,
      '',
      `Setups must come from this vocabulary: ${vocab.join(' | ')}`,
      `Seconds: use EXACTLY these integers, one per shot, reordering allowed, nothing else sums correctly: ${feas.partition.join(', ')}`,
      'Every beat gets at least one shot; every shot serves exactly one beat. Shot sides match their scene. The first shot at each location is a wide or full setup. Every dialogue line lands in exactly one shot. Shot locations use the slugline location names exactly — no sub-locations.',
      '',
      'THE RULEBOOK:',
      rulebook.doctrine(),
    ].join('\n');

    let calls = 0;
    let structure = null;
    let failure = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ask = attempt === 0
        ? `THE BRIEF:\n${JSON.stringify(seq.brief, null, 1)}\n\nTHE BEATS:\n${JSON.stringify(seq.beats)}\n\nTHE SCREENPLAY:\n${JSON.stringify(seq.screenplay, null, 1)}`
        : `THE BRIEF:\n${JSON.stringify(seq.brief, null, 1)}\n\nTHE BEATS:\n${JSON.stringify(seq.beats)}\n\nTHE SCREENPLAY:\n${JSON.stringify(seq.screenplay, null, 1)}\n\nYOUR LAST ATTEMPT WAS REJECTED:\n${failure}\n\nReturn the corrected JSON only.`;
      // eslint-disable-next-line no-await-in-loop
      const { content } = await ctx.client.reason({ prompt: ask, systemPrompt: system, modelId: ctx.modelId });
      calls += 1;
      const { parsed, error } = parseStrictJson(content);
      if (error) { failure = error; continue; }
      const shots = (parsed.shots || []).map((sh) => ({ ...sh, id: String(sh.id), beatId: String(sh.beatId), prompt: '', flags: Array.isArray(sh.flags) ? sh.flags : [] }));
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
      if (!structuralBlockers.length) { structure = shots; break; }
      failure = gateReport(structuralBlockers).join('\n');
    }

    if (!structure) {
      return { project, cost: calls, output: { kind: 'error', error: `the shot structure failed its gates twice and was NOT saved:\n${failure}` } };
    }

    const lookLine = [seq.brief.look?.style, seq.brief.look?.grade].filter(Boolean).join(' · ');
    const shots = [];
    for (const sh of structure) {
      // eslint-disable-next-line no-await-in-loop
      const composed = await composeUnderSkill({
        modelKey: SLOT,
        title: sh.moment,
        note: `${sh.setup}, ${sh.moment}`,
        refs: [],
        dialogue: Array.isArray(sh.dialogue) ? sh.dialogue : [],
        lookLine,
        ctx,
      });
      calls += composed.calls;
      if (composed.problems.length) {
        return { project, cost: calls, output: { kind: 'error', error: `shot ${sh.id}: prompt failed its gates twice and nothing was saved:\n${composed.problems.map((x) => `- ${x}`).join('\n')}` } };
      }
      shots.push({ ...sh, prompt: composed.prompt });
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
    if (!full.pass) {
      return { project, cost: calls, output: { kind: 'error', error: `the completed plan fails:\n${gateReport(full.blockers).join('\n')}` } };
    }

    const next = setSequenceFields(project, seq.id, { plan, status: 'planned' });
    return {
      project: next,
      cost: calls,
      output: {
        kind: 'plan',
        sequenceId: seq.id,
        shots: shots.map((sh) => ({ id: sh.id, beatId: sh.beatId, setup: sh.setup, side: sh.side, seconds: sh.seconds, location: sh.location, prompt: sh.prompt })),
        plates: newEntities,
        gatesPassed: [...new Set(full.results.filter((g) => g.pass).map((g) => g.ruleId))],
        totalSeconds: shots.reduce((a, b) => a + b.seconds, 0),
      },
    };
  },
};
