import { defaultImageModelKey, getModel, keyframeImageSize } from '../../utils/film/suiteConfig.js';
import { fillQuestion } from './rubrics.js';
import { reservationIdOf } from './policy.js';
import { imageStats, hamming, judge, plateContext, shotAnchors, findingRow, noForceLiteral, blindOf } from './qc.js';

const round3 = (v) => Math.round(v * 1000) / 1000;

const mediaExt = (url) => (String(url).match(/\.(png|jpe?g|webp)(?=[?#]|$)/i) || [, 'png'])[1].toLowerCase();

export const keyframePrompt = (shot, plates) => [
  shot.prompt,
  `A single still: the first frame of this shot. Subject in frame: ${shot.subject}. Framing: ${shot.setup}. Force visible: ${shot.force}. The frame shows the first state of: ${shot.change}.`,
  ...(plates.length ? [`Reference images, in order: ${plates.map((p, i) => `image ${i + 1} is ${p.entity} (${p.role})`).join('; ')}. Keep every referenced identity exactly.`] : []),
].join('\n');

export const generateCandidates = async ({ shot, plates, k, attempt, client, journal, reserve }) => {
  for (const [key, v] of Object.entries({ shot, plates, client, journal, reserve })) if (!v) throw new Error(`generateCandidates: ${key} is required`);
  if (!Number.isInteger(k) || k < 1) throw new Error(`generateCandidates: k must be a positive integer, got ${JSON.stringify(k)}`);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`generateCandidates: attempt must be a positive integer, got ${JSON.stringify(attempt)}`);
  if (typeof journal.cost !== 'function') throw new Error('generateCandidates: journal.cost is required — every paid still is a cost row');
  for (const f of ['id', 'prompt', 'subject', 'force', 'change', 'setup']) if (!shot[f]) throw new Error(`generateCandidates: shot.${f} is required`);
  for (const p of plates) if (!p.url || !p.entity || !p.role) throw new Error('generateCandidates: every plate carries url, entity and role');
  const modelKey = defaultImageModelKey();
  const modelId = getModel(modelKey);
  const size = keyframeImageSize(modelKey);
  const prompt = keyframePrompt(shot, plates);
  const nodeId = `keyframe:${shot.id}`;
  const made = [];
  for (let i = 1; i <= k; i += 1) {
    const id = `${shot.id}-a${attempt}-c${i}`;
    let reservationId;
    try {
      const reservation = await reserve({ nodeId, kind: 'still', units: 1, justification: `keyframe candidate ${i} of ${k} for shot ${shot.id}` });
      reservationId = reservationIdOf(reservation, nodeId);
    } catch (err) {
      err.candidates = made;
      throw err;
    }
    const t0 = Date.now();
    const out = await client.generateImage({ prompt, referenceImages: plates.map((p) => p.url), size, model: modelId });
    const url = out.cacheUrl || out.url;
    if (!url) throw new Error(`generateCandidates: the image model returned no url for ${id}`);
    const path = await journal.media(`candidate-${id}.${mediaExt(url)}`, url);
    const candidate = { id, shotId: shot.id, url, sourceUrl: out.url, path, attempt, index: i };
    await journal.write('candidate', { ...candidate, nodeId, reservationId, modelKey, modelId, size, prompt, references: plates.map((p) => ({ entity: p.entity, role: p.role, url: p.url })), ms: Date.now() - t0 });
    await journal.cost({ nodeId, kind: 'still', units: 1, disposition: 'kept', shotId: shot.id, candidateId: id, attempt, reservationId });
    made.push(candidate);
  }
  return made;
};

export const scoreCandidate = async ({ candidate, siblings, shot, plates, style, rubrics, policy, client, journal }) => {
  for (const [key, v] of Object.entries({ candidate, siblings, shot, plates, style, rubrics, policy, client, journal })) if (!v) throw new Error(`scoreCandidate: ${key} is required`);
  if (!candidate.url || !candidate.id) throw new Error('scoreCandidate: candidate.id and candidate.url are required');
  const params = rubrics.params.take;
  const expected = keyframeImageSize(defaultImageModelKey()).split('x').map(Number);
  const stats = await imageStats(candidate.url);
  const others = [];
  for (const s of siblings.filter((x) => x.id !== candidate.id)) others.push({ id: s.id, distance: hamming(stats.dhash, (await imageStats(s.url)).dhash) });
  const plateDistances = [];
  for (const p of plates) plateDistances.push({ entity: p.entity, distance: hamming(stats.dhash, (await imageStats(p.url)).dhash) });
  const dimensionsOk = stats.width === expected[0] && stats.height === expected[1];
  const lumaOk = stats.meanLuma >= params.still.minLuma && stats.meanLuma <= params.still.maxLuma;
  const blurOk = stats.blur >= params.still.minBlur;
  const duplicateOf = others.filter((o) => o.distance <= params.still.duplicateMaxBits).map((o) => o.id);
  const plateSimilarity = plateDistances.length ? round3(1 - Math.min(...plateDistances.map((p) => p.distance)) / 64) : null;
  const deterministic = { stats, expected: { width: expected[0], height: expected[1] }, dimensionsOk, lumaOk, blurOk, siblings: others, duplicateOf, plateDistances, plateSimilarity };
  const components = [dimensionsOk ? 1 : 0, lumaOk ? 1 : 0, blurOk ? 1 : 0, duplicateOf.length ? 0 : 1, ...(plateSimilarity === null ? [] : [plateSimilarity])];
  const deterministicScore = round3(components.reduce((a, b) => a + b, 0) / components.length);

  const anchors = shotAnchors(shot, style);
  const noForce = noForceLiteral(rubrics);
  const skipped = rubrics.forSet('take', (q) => q.evidence !== 'frame' || (shot.force === noForce && q.anchors.includes('force'))).map((q) => q.id);
  const questions = rubrics.forSet('take', (q) => !skipped.includes(q.id)).map((q) => fillQuestion(q, anchors));
  const frames = [{ t: 0, url: candidate.url }];
  const label = `candidate:${candidate.id}`;
  const judged = await judge({
    client, journal, rubrics, questions, frames, references: plateContext(plates), label, frameRate: 0,
    context: `A single still, ${stats.width}x${stats.height}: a keyframe candidate for shot ${shot.id}, meant as the shot's first frame.`,
    description: `Planned as a ${shot.setup}, subject ${shot.subject}. Force in this shot: ${shot.force}. Change: ${shot.change}. Look: ${anchors.look}.`,
    offsetFrames: async () => frames, finding: { stage: 'select', shotId: shot.id, candidateId: candidate.id }, nodeId: `keyframe:${shot.id}`, blind: blindOf(policy, shot.id),
  });
  const asked = questions.length;
  const passed = questions.filter((q) => judged.verdicts[q.id].state === 'stable' && judged.verdicts[q.id].pass).length;
  const rubricScore = asked ? round3(passed / asked) : 0;
  const rubric = { questions: questions.map((q) => q.id), skipped, verdicts: judged.verdicts, asked, passed, score: rubricScore, blind: judged.blind, reliability: judged.findings.map((f) => f.finding_id) };
  const score = round3(params.scoring.deterministicWeight * deterministicScore + params.scoring.rubricWeight * rubricScore);
  await journal.write('score', { candidateId: candidate.id, shotId: shot.id, rubricVersion: rubrics.version, score, deterministicScore, deterministic, rubric });
  return { score, deterministic: { ...deterministic, score: deterministicScore }, rubric };
};

export const selectCandidate = async ({ shot, candidates, policy, journal }) => {
  for (const [key, v] of Object.entries({ shot, candidates, policy, journal })) if (!v) throw new Error(`selectCandidate: ${key} is required`);
  if (!Array.isArray(candidates) || !candidates.length) throw new Error(`selectCandidate: shot ${shot.id} has no scored candidates`);
  const floor = policy.candidates?.selectionFloor;
  if (typeof floor !== 'number') throw new Error('selectCandidate: policy.candidates.selectionFloor is required');
  for (const c of candidates) if (typeof c.score !== 'number' || !c.id) throw new Error(`selectCandidate: candidate ${JSON.stringify(c.id)} carries no score — score every candidate before selecting`);
  const ranked = [...candidates].sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  const winner = ranked[0];
  const reason = ranked.length > 1
    ? `${winner.id} scored ${winner.score}, ahead of ${ranked.slice(1).map((c) => `${c.id} at ${c.score}`).join(', ')}`
    : `${winner.id} is the only candidate, scored ${winner.score}`;
  let shortfall = null;
  if (winner.score < floor) {
    const row = findingRow({
      family: 'shortfall', stage: 'select', severity: 'note', code: 'E-SELECT-FLOOR', shotId: shot.id, candidateId: winner.id,
      detail: `best candidate ${winner.id} scored ${winner.score}, under the selection floor ${floor}`,
      evidence: [{ floor, scores: ranked.map((c) => ({ id: c.id, score: c.score, url: c.url })) }], disposition: 'regenerate',
    });
    await journal.finding(row);
    shortfall = { code: row.code, floor, best: winner.score, finding_id: row.finding_id };
  }
  await journal.write('select', {
    shotId: shot.id, winner: winner.id, floor, reason, shortfall,
    ranked: ranked.map((c) => ({ id: c.id, url: c.url, score: c.score, deterministic: c.deterministic, rubric: c.rubric })),
  });
  return { winner, ranked, shortfall };
};
