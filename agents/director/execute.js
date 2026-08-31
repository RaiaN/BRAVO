import {
  addActivity, appendIteration, insertShot, newId, removeActivity, sequenceById,
  setSequenceFields, setShotFields, setThreadStatus, shotById, threadById, touch,
} from '../../state/project.js';
import { animate, isAudioPolicyError } from '../../utils/film/core/operations.js';
import { requireRulebook } from './rulebook.js';
import { runMeasureGates } from './gates.js';
import { maxShotSeconds } from '../../utils/film/suiteConfig.js';

export const fnv1a = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

export const manifestOf = (seq) => ({
  seqId: seq.id,
  targetSeconds: seq.brief.targetSeconds,
  tolerance: 0.5,
  slot: seq.plan.slot,
  params: { fps: 24, resolution: '720p', ratio: 'adaptive', audio: seq.brief.format.audio !== false },
  shots: seq.plan.shots.map((sh) => ({
    id: sh.id, seconds: sh.seconds, setup: sh.setup, side: sh.side,
    location: sh.location, beatId: sh.beatId, prompt: sh.prompt,
  })),
  plates: seq.plan.plates.map((p) => ({ entity: p.entity, role: p.role, prompt: p.prompt, model: p.model })),
  renders: { stills: seq.plan.plates.length, takes: seq.plan.shots.length },
  retryPool: seq.plan.shots.length,
  audioContingency: 'on an audio-policy rejection a shot retakes once, silent; every silent shot is named in the record',
  seed: seq.brief.seed,
});

const hamming = (a, b) => {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
  return d;
};

const measureUrl = async (url, hashes) => {
  const res = await fetch('/api/film/measure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, hashes }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `measure failed (HTTP ${res.status})`);
  return data;
};

const nodeIds = (manifest) => [
  'shots',
  ...manifest.plates.map((p) => `plate:${p.entity}`),
  ...manifest.shots.flatMap((sh, i) => [`shoot:${sh.id}`, `measure:${sh.id}`, ...(i > 0 ? [`chain:${sh.id}`] : [])]),
  'assemble',
  'final',
];

export const runSequence = async ({ client, threadId, messageId, get, apply, modelId = null }) => {
  const p = () => get();
  const seqIdOf = () => threadById(p(), threadId)?.subjectId;
  const seq = () => sequenceById(p(), seqIdOf());

  const start = seq();
  if (!start || !start.plan) return;
  const manifest = manifestOf(start);
  const manifestHash = fnv1a(JSON.stringify(manifest));

  if (start.run && start.run.manifestHash !== manifestHash) {
    apply((prev) => setSequenceFields(prev, start.id, { status: 'halted', run: { ...start.run, halted: { node: 'manifest', reason: 'the plan changed after approval — the approved manifest no longer matches' } } }));
    return;
  }

  const say = (text) => apply((prev) => ({
    ...prev,
    threads: prev.threads.map((t) => (t.id === threadId ? { ...t, messages: [...t.messages, { id: newId('msg'), at: new Date().toISOString(), role: 'agent', text, tool: null, asset: null }] } : t)),
  }));

  if (!start.run) {
    apply((prev) => setSequenceFields(prev, start.id, {
      status: 'executing',
      run: { manifestHash, messageId, threadId, startedAt: new Date().toISOString(), nodes: {}, spentRenders: 0, retryPoolLeft: manifest.retryPool, silentShots: [], runs: [], gateResults: [] },
    }));
  } else {
    apply((prev) => setSequenceFields(prev, start.id, { status: 'executing' }));
  }
  apply((prev) => setThreadStatus(prev, threadId, 'working'));

  const node = (id) => (seq().run.nodes[id] || { status: 'pending', attempts: 0, value: null });
  const setNode = (id, patch) => apply((prev) => {
    const q = sequenceById(prev, start.id);
    const cur = q.run.nodes[id] || { status: 'pending', attempts: 0, value: null };
    return setSequenceFields(prev, start.id, { run: { ...q.run, nodes: { ...q.run.nodes, [id]: { ...cur, ...patch } } } });
  });
  const patchRun = (patch) => apply((prev) => {
    const q = sequenceById(prev, start.id);
    return setSequenceFields(prev, start.id, { run: { ...q.run, ...(typeof patch === 'function' ? patch(q.run) : patch) } });
  });
  const recordRun = (id, attempt, ms, outcome) => patchRun((r) => ({ runs: [...r.runs, { node: id, attempt, ms, outcome }] }));
  const recordGates = (results) => patchRun((r) => ({ gateResults: [...r.gateResults, ...results.map((g) => ({ ...g }))] }));

  const halt = (id, reason, ruleId = null) => {
    setNode(id, { status: 'halted', reason });
    patchRun({ halted: { node: id, reason, ruleId } });
    apply((prev) => setSequenceFields(prev, start.id, { status: 'halted' }));
    apply((prev) => setThreadStatus(prev, threadId, 'needs-you'));
    say(`The run halted at ${id}: ${reason}`);
    finishIteration('halted', { node: id, ruleId, reason });
  };

  const finishIteration = (status, haltInfo = null) => {
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

  const rulebook = await requireRulebook();
  const k = manifest.shots.length;
  const shotMap = () => node('shots').value || {};

  for (const id of nodeIds(manifest)) {
    if (node(id).status === 'done') continue;
    const began = Date.now();
    setNode(id, { status: 'running', startedAt: new Date().toISOString(), attempts: node(id).attempts + 1 });

    try {
      if (id === 'shots') {
        let mapping = {};
        apply((prev) => {
          let next = prev;
          const ids = [];
          for (const sh of manifest.shots) {
            const made = insertShot(next, {
              fields: {
                title: `${start.brief.logline.slice(0, 24)} · ${sh.id}`,
                prompt: sh.prompt,
                model: manifest.slot,
                duration: sh.seconds,
                resolution: manifest.params.resolution,
                ratio: manifest.params.ratio,
                generateAudio: manifest.params.audio,
                ownedBy: start.id,
              },
            });
            next = made.project;
            mapping[sh.id] = made.shot.id;
            ids.push(made.shot.id);
          }
          return setSequenceFields(next, start.id, { shotIds: ids });
        });
        setNode(id, { status: 'done', ms: Date.now() - began, value: mapping });
        recordRun(id, node(id).attempts, Date.now() - began, 'done');
        continue;
      }

      if (id.startsWith('plate:')) {
        const entity = id.slice(6);
        const plate = manifest.plates.find((pl) => pl.entity === entity);
        const { url, cacheUrl, assetId } = await client.generateImage({ prompt: plate.prompt, referenceImages: [], size: '2K', model: undefined });
        const durable = cacheUrl || url;
        apply((prev) => touch({
          ...prev,
          bible: [...prev.bible, {
            id: newId('bib'), name: plate.entity, role: plate.role, plateUrl: durable, assetId: assetId || null,
            notes: `plate for sequence ${start.id}`, prompt: plate.prompt, model: plate.model, stills: [], refs: [],
          }],
        }));
        patchRun((r) => ({ spentRenders: r.spentRenders + 1 }));
        setNode(id, { status: 'done', ms: Date.now() - began, value: { url: durable, assetId: assetId || null } });
        recordRun(id, node(id).attempts, Date.now() - began, 'done');
        continue;
      }

      if (id.startsWith('shoot:')) {
        const shotPlanId = id.slice(6);
        const idx = manifest.shots.findIndex((sh) => sh.id === shotPlanId);
        const sh = manifest.shots[idx];
        const prevShot = idx > 0 ? manifest.shots[idx - 1] : null;
        const firstFrameUrl = prevShot ? node(`shoot:${prevShot.id}`).value?.lastFrameUrl || null : null;
        const plateRefs = manifest.plates.map((pl) => node(`plate:${pl.entity}`).value).filter(Boolean);

        let existing = node(id).value || {};
        let taskId = existing.taskId || null;
        let promptUsed = existing.promptUsed || sh.prompt;
        let silent = existing.silent || false;

        if (!taskId) {
          const kick = async (audioOn) => animate({
            motion: sh.prompt,
            refUrls: plateRefs.map((r) => r.url),
            refAssetIds: plateRefs.map((r) => r.assetId || null),
            firstFrameUrl,
            duration: sh.seconds,
            resolution: manifest.params.resolution,
            ratio: firstFrameUrl ? 'adaptive' : manifest.params.ratio,
            generateAudio: audioOn,
            seed: manifest.seed,
            modelKey: manifest.slot,
          }, { client });
          try {
            const started = await kick(manifest.params.audio);
            taskId = started.taskId;
            promptUsed = started.prompt;
          } catch (err) {
            if (!manifest.params.audio || !isAudioPolicyError(err)) throw err;
            const started = await kick(false);
            taskId = started.taskId;
            promptUsed = started.prompt;
            silent = true;
            patchRun((r) => ({ silentShots: [...r.silentShots, sh.id] }));
          }
          setNode(id, { value: { taskId, promptUsed, silent } });
        }

        const activityId = newId('act');
        apply((prev) => addActivity(prev, { id: activityId, threadId, messageId, taskId, tool: 'shoot', label: `sequence · ${sh.id}`, seqId: start.id, nodeId: id }));
        let polled;
        try {
          polled = await client.pollVideo({ taskId });
        } finally {
          apply((prev) => removeActivity(prev, activityId));
        }

        const take = {
          id: newId('take'),
          url: polled.videoCacheUrl || polled.videoUrl,
          sourceUrl: polled.videoUrl,
          posterUrl: polled.lastFrameCacheUrl || polled.lastFrameUrl || null,
          createdAt: new Date().toISOString(),
          promptUsed,
          model: manifest.slot,
          seed: manifest.seed,
          resolution: manifest.params.resolution,
          ratio: manifest.params.ratio,
          duration: sh.seconds,
          silent,
        };
        const filmShotId = shotMap()[sh.id];
        apply((prev) => {
          const fs = shotById(prev, filmShotId);
          return fs ? setShotFields(prev, filmShotId, { takes: [...fs.takes, take], chosenTakeId: take.id }) : prev;
        });
        patchRun((r) => ({ spentRenders: r.spentRenders + 1 }));
        setNode(id, { status: 'done', ms: Date.now() - began, value: { taskId, promptUsed, silent, takeId: take.id, url: take.url, lastFrameUrl: take.posterUrl } });
        recordRun(id, node(id).attempts, Date.now() - began, 'done');
        continue;
      }

      if (id.startsWith('measure:')) {
        const shotPlanId = id.slice(8);
        const sh = manifest.shots.find((x) => x.id === shotPlanId);
        const takeUrl = node(`shoot:${shotPlanId}`).value.url;
        const m = await measureUrl(takeUrl, true);
        const payload = {
          brief: { targetSeconds: manifest.targetSeconds },
          perShot: [{ shotId: shotPlanId, requested: sh.seconds, measured: m.duration, fps: m.fps, nbReadFrames: m.nbReadFrames }],
          joins: [],
          timeline: { totalMeasured: manifest.targetSeconds },
        };
        const gates = runMeasureGates(rulebook, payload, { maxSeconds: maxShotSeconds });
        const relevant = gates.results.filter((g) => ['CIN-004', 'CIN-007'].includes(g.ruleId));
        recordGates(relevant);
        const blockers = relevant.filter((g) => g.blocking && !g.pass);
        if (blockers.length) {
          const b = blockers[0];
          if (b.failureKind === 'deterministic') {
            halt(id, `[${b.ruleId}] ${b.detail || b.value} — a model property, not retryable`, b.ruleId);
            return;
          }
          const left = seq().run.retryPoolLeft;
          if (left <= 0) {
            halt(id, `[${b.ruleId}] ${b.detail || b.value} — retry pool exhausted`, b.ruleId);
            return;
          }
          patchRun((r) => ({ retryPoolLeft: r.retryPoolLeft - 1 }));
          setNode(`shoot:${shotPlanId}`, { status: 'pending', value: null });
          setNode(id, { status: 'pending', value: null });
          recordRun(id, node(id).attempts, Date.now() - began, `retry: ${b.detail || b.value}`);
          say(`Take ${shotPlanId} failed ${b.ruleId} (${b.detail || b.value}) — re-rendering from the declared pool (${left - 1} left).`);
          return runSequence({ client, threadId, messageId, get, apply, modelId });
        }
        setNode(id, { status: 'done', ms: Date.now() - began, value: { shotId: shotPlanId, requested: sh.seconds, measured: m.duration, nbReadFrames: m.nbReadFrames, fps: m.fps, overshoot: Math.round((m.duration - sh.seconds) * 1000) / 1000, firstHash: m.firstHash, lastHash: m.lastHash, hasAudio: m.hasAudio, silent: node(`shoot:${shotPlanId}`).value.silent }});
        recordRun(id, node(id).attempts, Date.now() - began, 'done');
        continue;
      }

      if (id.startsWith('chain:')) {
        const shotPlanId = id.slice(6);
        const idx = manifest.shots.findIndex((x) => x.id === shotPlanId);
        const prevSh = manifest.shots[idx - 1];
        const a = node(`measure:${prevSh.id}`).value.lastHash;
        const b = node(`measure:${shotPlanId}`).value.firstHash;
        const distance = hamming(a, b);
        const gates = runMeasureGates(rulebook, {
          brief: { targetSeconds: manifest.targetSeconds },
          perShot: [],
          joins: [{ from: prevSh.id, to: shotPlanId, distance }],
          timeline: { totalMeasured: manifest.targetSeconds },
        }, { maxSeconds: maxShotSeconds });
        recordGates(gates.results.filter((g) => g.ruleId === 'CIN-003'));
        setNode(id, { status: 'done', ms: Date.now() - began, value: { from: prevSh.id, to: shotPlanId, distance } });
        recordRun(id, node(id).attempts, Date.now() - began, 'done');
        continue;
      }

      if (id === 'assemble') {
        const urls = manifest.shots.map((sh) => node(`shoot:${sh.id}`).value.url);
        const res = await fetch('/api/film/stitch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shots: urls, name: `slice-${start.id}` }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.details || data.error || `stitch failed (HTTP ${res.status})`);
        setNode(id, { status: 'done', ms: Date.now() - began, value: { url: data.cacheUrl || data.url } });
        recordRun(id, node(id).attempts, Date.now() - began, 'done');
        continue;
      }

      if (id === 'final') {
        const sliceUrl = node('assemble').value.url;
        const m = await measureUrl(sliceUrl, false);
        const gates = runMeasureGates(rulebook, {
          brief: { targetSeconds: manifest.targetSeconds },
          perShot: [],
          joins: [],
          timeline: { totalMeasured: m.duration },
        }, { maxSeconds: maxShotSeconds });
        recordGates(gates.results.filter((g) => g.ruleId === 'CIN-008'));
        const blocker = gates.blockers.find((g) => g.ruleId === 'CIN-008');
        if (blocker) {
          halt(id, `[CIN-008] assembled ${m.duration}s for target ${manifest.targetSeconds}s — ${blocker.detail}`, 'CIN-008');
          return;
        }
        setNode(id, { status: 'done', ms: Date.now() - began, value: { totalMeasured: m.duration, deltaFromN: Math.round((m.duration - manifest.targetSeconds) * 1000) / 1000, fps: m.fps } });
        recordRun(id, node(id).attempts, Date.now() - began, 'done');
        continue;
      }
    } catch (err) {
      halt(id, err.message);
      return;
    }
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
  finishIteration('assembled');
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
