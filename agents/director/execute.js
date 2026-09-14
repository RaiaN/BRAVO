import {
  appendIteration, newId, sequenceById, setSequenceFields, setThreadStatus, threadById,
} from '../../state/project.js';
import { requireRulebook } from './rulebook.js';
import { completeNode, completionProblems, runNode } from './nodes.js';
import { runSchedule, validateManifest } from './schedule.js';
import { trace, traceMedia } from '../trace.js';

export const fnv1a = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

const FORMAT_KEYS = ['fps', 'resolution', 'ratio', 'audio'];

const formatOf = (seq) => {
  const format = seq.brief?.format;
  if (!format || typeof format !== 'object') throw new Error(`sequence ${seq.id} has no brief.format — the render parameters come from the brief the gates approved, never from code`);
  for (const key of FORMAT_KEYS) {
    if (!(key in format) || format[key] === undefined || format[key] === null) throw new Error(`sequence ${seq.id} declares no brief.format.${key} — the render parameters come from the brief the gates approved, never from code`);
  }
  if (typeof format.audio !== 'boolean') throw new Error(`sequence ${seq.id} declares brief.format.audio as ${JSON.stringify(format.audio)} — audio is on or off, never inferred`);
  return { fps: format.fps, resolution: format.resolution, ratio: format.ratio, audio: format.audio };
};

export const toleranceOf = (rulebook, shotCount) => {
  if (!rulebook || typeof rulebook.ruleById !== 'function') throw new Error('manifestOf needs the loaded rulebook — the timeline tolerance is CIN-008\'s law, never a number in code');
  const rule = rulebook.ruleById('CIN-008');
  if (!rule) throw new Error('the rulebook carries no CIN-008 — the timeline tolerance has no law to come from');
  const { base, perShot } = rule.params || {};
  if (typeof base !== 'number' || typeof perShot !== 'number') throw new Error(`CIN-008 carries no params.base and params.perShot (got ${JSON.stringify(rule.params || null)}) — the tolerance cannot be scaled`);
  return Math.max(base, perShot * shotCount);
};

export const manifestOf = (seq, rulebook) => ({
  seqId: seq.id,
  targetSeconds: seq.brief.targetSeconds,
  tolerance: toleranceOf(rulebook, seq.plan.shots.length),
  slot: seq.plan.slot,
  params: formatOf(seq),
  shots: seq.plan.shots.map((sh) => ({
    id: sh.id, seconds: sh.seconds, setup: sh.setup, side: sh.side, join: sh.join === undefined ? null : sh.join,
    location: sh.location, beatId: sh.beatId, prompt: sh.prompt,
  })),
  plates: seq.plan.plates.map((p) => ({ entity: p.entity, role: p.role, prompt: p.prompt, model: p.model })),
  renders: { stills: seq.plan.plates.length, takes: seq.plan.shots.length },
  retryPool: seq.plan.shots.length,
  audioContingency: 'on an audio-policy rejection a shot retakes once, silent; every silent shot is named in the record',
  seed: seq.brief.seed,
});

export const BROWSER_CONCURRENCY = Object.freeze({ stills: 1, chains: 1, judge: 1 });
export const BROWSER_POLL = Object.freeze({ timeoutMs: 20000, maxMs: 1800000 });

const PASS_KEYS = ['policy', 'journal', 'reserve', 'stages', 'style', 'rubrics', 'rulebook', 'runId'];
const STAGE_NAMES = ['plateQC', 'generateCandidates', 'scoreCandidate', 'selectCandidate', 'takeQC'];

const requirePass = (pass) => {
  for (const key of PASS_KEYS) {
    if (!(key in pass) || pass[key] === undefined || pass[key] === null) throw new Error(`the pass is missing "${key}" — a policy run declares its policy, journal, reserve, stages, style, rubrics, rulebook and runId`);
  }
  for (const name of STAGE_NAMES) {
    if (typeof pass.stages[name] !== 'function') throw new Error(`the pass's stages have no "${name}"`);
  }
  if (!pass.policy.concurrency) throw new Error('the policy has no concurrency caps');
  if (!pass.policy.attempts) throw new Error('the policy has no attempt budgets');
  if (!pass.policy.poll) throw new Error('the policy has no poll settings');
  if (!pass.policy.resume) throw new Error('the policy has no resume settings');
  if (typeof pass.rulebook.ruleById !== 'function' || typeof pass.rulebook.rulesFor !== 'function') throw new Error('the pass carries no loaded rulebook — one rulebook per pass, threaded through, never fetched twice');
  const unable = completionProblems(pass.policy);
  if (unable.length) throw new Error(`E-POLICY-COMPLETION: ${unable.join('; ')}`);
  return pass;
};

export const traceJournal = (threadId) => {
  let step = 0;
  const write = (kind, data) => {
    step += 1;
    const at = new Date().toISOString();
    trace(threadId, kind, data);
    return { step, at };
  };
  return {
    write,
    intent: (kind, data) => {
      const intentId = newId('int');
      write('intent', { intentId, kind, ...data });
      return intentId;
    },
    result: (intentId, data) => write('result', { intentId, ...data }),
    finding: (row) => write('finding', row),
    cost: (row) => write('cost', row),
    media: (name, url) => { traceMedia(threadId, name, url); return name; },
    entries: () => { throw new Error('the browser trace has no read-back — entries() lives on the pass journal'); },
  };
};

const CARD_STAGES = Object.fromEntries(STAGE_NAMES.map((name) => [name, () => {
  throw new Error(`${name} is a policy-pass stage — the approved-card flow has no plate QC, no candidates and no take QC`);
}]));

export const cardReserve = ({ manifest, journal, run }) => {
  let count = 0;
  return async ({ nodeId, kind, units, justification }) => {
    if (!nodeId) throw new Error('E-RESERVE-NO-NODE: a reservation names the plan node that spends');
    if (!['still', 'take'].includes(kind)) throw new Error(`E-RESERVE-KIND: the approved card covers stills and takes, not ${JSON.stringify(kind)}`);
    const declared = manifest.renders.stills + manifest.renders.takes + manifest.retryPool;
    const before = run().spentRenders;
    const after = before + 1;
    if (after > declared) throw new Error(`E-BUDGET-CARD: ${nodeId} asks for one more ${kind} (${units} unit${units === 1 ? '' : 's'}) with ${before} of ${declared} declared renders spent — the approved card is the ceiling`);
    count += 1;
    const record = { id: `res_${count}`, nodeId, kind, units, justification, ceiling: declared, before, after };
    await journal.write('reservation', record);
    return record;
  };
};

const ACTIVE_RUNS = new Set();

export const runSequence = async ({ client, threadId, messageId, get, apply, modelId = null, pass = null }) => {
  const p = () => get();
  const seqIdOf = () => threadById(p(), threadId)?.subjectId;
  const seq = () => sequenceById(p(), seqIdOf());

  const start = seq();
  if (!start || !start.plan) return;
  if (ACTIVE_RUNS.has(start.id)) return;
  ACTIVE_RUNS.add(start.id);
  try {
    await walkSequence({ client, threadId, messageId, get, apply, modelId, pass: pass ? requirePass(pass) : null, p, seq, start });
  } finally {
    ACTIVE_RUNS.delete(start.id);
  }
};

const walkSequence = async ({ client, threadId, messageId, apply, pass, p, seq, start }) => {
  const flow = pass ? 'policy' : 'card';
  const journal = pass ? pass.journal : traceJournal(threadId);
  const rulebook = pass ? pass.rulebook : await requireRulebook();
  const manifest = manifestOf(start, rulebook);
  const manifestHash = fnv1a(JSON.stringify(manifest));

  if (start.run && start.run.manifestHash !== manifestHash) {
    apply((prev) => setSequenceFields(prev, start.id, { status: 'halted', run: { ...start.run, halted: { node: 'manifest', reason: 'the plan changed after approval — the approved manifest no longer matches' } } }));
    return;
  }

  const say = (text) => apply((prev) => ({
    ...prev,
    threads: prev.threads.map((t) => (t.id === threadId ? { ...t, messages: [...t.messages, { id: newId('msg'), at: new Date().toISOString(), role: 'agent', text, tool: null, asset: null }] } : t)),
  }));

  apply((prev) => {
    const q = sequenceById(prev, start.id);
    return setSequenceFields(prev, start.id, q.run
      ? { status: 'executing', run: { ...q.run, takes: q.run.takes || {} } }
      : {
        status: 'executing',
        run: { manifestHash, messageId, threadId, flow, startedAt: new Date().toISOString(), nodes: {}, spentRenders: 0, retryPoolLeft: manifest.retryPool, silentShots: [], runs: [], gateResults: [], takes: {} },
      });
  });
  apply((prev) => setThreadStatus(prev, threadId, 'working'));

  const run = () => seq().run;
  const node = (id) => (run().nodes[id] || { status: 'pending', attempts: 0, value: null });
  const setNode = (id, patch, quiet = false) => {
    apply((prev) => {
      const q = sequenceById(prev, start.id);
      const cur = q.run.nodes[id] || { status: 'pending', attempts: 0, value: null };
      return setSequenceFields(prev, start.id, { run: { ...q.run, nodes: { ...q.run.nodes, [id]: { ...cur, ...patch } } } });
    });
    return quiet ? undefined : journal.write('node', { id, ...patch });
  };
  const patchRun = (patch) => apply((prev) => {
    const q = sequenceById(prev, start.id);
    return setSequenceFields(prev, start.id, { run: { ...q.run, ...(typeof patch === 'function' ? patch(q.run) : patch) } });
  });
  const recordRun = (id, attempt, ms, outcome) => patchRun((r) => ({ runs: [...r.runs, { node: id, attempt, ms, outcome }] }));
  const recordGates = (results) => patchRun((r) => ({ gateResults: [...r.gateResults, ...results.map((g) => ({ ...g }))] }));

  const finishIteration = async (status, haltInfo = null) => {
    await journal.write('iteration', { sequenceId: start.id, status, halt: haltInfo, spentRenders: run().spentRenders, retryPoolLeft: run().retryPoolLeft });
    apply((prev) => {
      const q = sequenceById(prev, start.id);
      return appendIteration(prev, start.id, {
        id: newId('it'),
        startedAt: q.run.startedAt,
        finishedAt: new Date().toISOString(),
        inputs: {
          briefHash: fnv1a(JSON.stringify(q.brief)),
          brief: q.brief,
          manifestHash: q.run.manifestHash,
          prompts: manifest.shots.map((sh) => sh.prompt),
          platePrompts: manifest.plates.map((pl) => pl.prompt),
          rulebookVersion: q.rulebookVersion,
          seed: manifest.seed,
        },
        runs: q.run.runs,
        gates: q.run.gateResults,
        measurements: {
          perShot: manifest.shots.map((sh) => q.run.nodes[`measure:${sh.id}`]?.value || null),
          joins: manifest.shots.slice(1).map((sh) => q.run.nodes[`chain:${sh.id}`]?.value || null),
          timeline: q.run.nodes.final?.value || null,
        },
        artifacts: {
          takeIds: manifest.shots.map((sh) => q.run.nodes[`shoot:${sh.id}`]?.value?.takeId || null),
          sliceUrl: q.run.nodes.assemble?.value?.url || null,
          plates: manifest.plates.map((pl) => q.run.nodes[`plate:${pl.entity}`]?.value?.url || null),
        },
        cost: { renders: q.run.spentRenders, retriesUsed: manifest.retryPool - q.run.retryPoolLeft, silentShots: q.run.silentShots },
        notes: [],
        corrections: [],
        status: status === 'assembled' ? 'assembled' : { halted: haltInfo },
      });
    });
  };

  const halt = async (id, reason, ruleId = null) => {
    await setNode(id, { status: 'halted', reason });
    patchRun({ halted: { node: id, reason, ruleId } });
    apply((prev) => setSequenceFields(prev, start.id, { status: 'halted' }));
    apply((prev) => setThreadStatus(prev, threadId, 'needs-you'));
    say(`The run halted at ${id}: ${reason}`);
    await finishIteration('halted', { node: id, ruleId, reason });
  };

  try {
    validateManifest(manifest);
  } catch (err) {
    await halt('manifest', err.message);
    return;
  }

  const ctx = {
    flow,
    policy: pass ? pass.policy : null,
    concurrency: pass ? pass.policy.concurrency : BROWSER_CONCURRENCY,
    poll: pass ? pass.policy.poll : BROWSER_POLL,
    manifest,
    plan: start.plan,
    seqId: start.id,
    brief: start.brief,
    threadId,
    messageId,
    runId: pass ? pass.runId : threadId,
    client,
    rulebook,
    style: pass ? pass.style : null,
    rubrics: pass ? pass.rubrics : null,
    stages: pass ? pass.stages : CARD_STAGES,
    project: p,
    apply,
    run,
    node,
    setNode,
    patchRun,
    recordGates,
    say,
    journal,
    reserve: pass ? pass.reserve : cardReserve({ manifest, journal, run }),
  };

  const runOne = async (id) => {
    const began = Date.now();
    const out = await runNode(ctx, id);
    if (out.status === 'done') recordRun(id, node(id).attempts, Date.now() - began, 'done');
    if (out.status === 'regenerate') recordRun(id, node(id).attempts, Date.now() - began, `retry: ${out.cause}`);
    return out;
  };

  const completeOne = async (id, info) => {
    const began = Date.now();
    const out = await completeNode(ctx, id, info);
    recordRun(id, node(id).attempts, Date.now() - began, `completed after ${info.faults} faults: ${info.error.message}`);
    return out;
  };

  const result = await runSchedule({
    manifest,
    plan: start.plan,
    flow,
    policy: ctx.policy,
    concurrency: ctx.concurrency,
    nodes: { get: node, set: setNode },
    run: runOne,
    complete: completeOne,
    journal,
  });
  if (result.status === 'halted') {
    await halt(result.halted.node, result.halted.reason, result.halted.ruleId);
    return;
  }

  apply((prev) => setSequenceFields(prev, start.id, { status: 'assembled' }));
  apply((prev) => {
    const q = sequenceById(prev, start.id);
    return {
      ...prev,
      threads: prev.threads.map((t) => (t.id === threadId
        ? {
          ...t,
          budget: { ...t.budget, spentTakes: t.budget.spentTakes + q.run.spentRenders },
          messages: t.messages.map((m) => (m.id === messageId
            ? { ...m, tool: { ...m.tool, output: { kind: 'slice', sequenceId: start.id, url: q.run.nodes.assemble.value.url, totalMeasured: q.run.nodes.final.value.totalMeasured, targetSeconds: manifest.targetSeconds, shots: manifest.shots.map((sh) => ({ id: sh.id, seconds: sh.seconds, measured: q.run.nodes[`measure:${sh.id}`]?.value?.measured, silent: q.run.nodes[`shoot:${sh.id}`]?.value?.silent || false, chainDistance: q.run.nodes[`chain:${sh.id}`]?.value?.distance ?? null })), silentShots: q.run.silentShots }, cost: q.run.spentRenders } }
            : m)),
        }
        : t)),
    };
  });
  await finishIteration('assembled');
  apply((prev) => setThreadStatus(prev, threadId, 'needs-you'));
  say('The slice is assembled and measured. Your notes are the next input — they become the ground truth this sequence learns from.');
};

export const resumeSequences = async ({ client, get, apply, modelId = null }) => {
  const executing = (get().sequences || []).filter((q) => q.status === 'executing' && q.run);
  for (const q of executing) {
    // eslint-disable-next-line no-await-in-loop
    await runSequence({ client, threadId: q.run.threadId, messageId: q.run.messageId, get, apply, modelId });
  }
};
