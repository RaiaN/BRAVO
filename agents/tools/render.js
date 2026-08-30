// still · shoot · edit — GATED (§6). Real money. Approved before anything is sent.
//
// The loop never runs these directly: it turns the call into an APPROVAL CARD showing the
// exact prompt and the exact ordered references (§6), and only an explicit approval runs
// them. `prepare()` builds what the card shows; `run()` is what approval executes.
//
// §8, load-bearing here:
// - THE PROMPT IS THE PROMPT. `animate({ motion: shot.prompt })` with the cinematography
//   fields left unset makes the kit's buildAnimatePrompt return `motion` VERBATIM. Any
//   other call shape prepends "Camera move: …" and assembles at send time.
// - Duration, ratio and resolution ride as PARAMETERS, never text.
// - promptUsed is recorded at send time (§3 invariant 3) — never reconstructed later.

import { newId, setBibleFields, setShotFields, shotById } from '../../state/project.js';
import { animate } from '../../utils/film/core/operations.js';
import { clampResolution, imageTagOf, resDefault, videoTraits } from '../../utils/film/suiteConfig.js';
import { resolveShot, resolveSubject } from './shared.js';

const needPrompt = (shot) => (shot.prompt
  ? null
  : 'this shot has no prompt yet. Use compose first — the prompt is written under the bound spec, never here.');

// What the approval card shows. Nothing is sent while building this.
export const prepare = (name, { input, project, thread }) => {
  // A plate and a shot are both renderable subjects; `still` does not care which.
  const subject = resolveSubject(project, thread, input.shot);
  if (!subject) return { error: `no subject matches ${JSON.stringify(input.shot ?? null)}` };
  const missingPrompt = needPrompt(subject);
  if (missingPrompt) return { error: missingPrompt };

  if (name === 'still') {
    return {
      card: {
        tool: 'still',
        shotId: subject.id,
        subjectKind: subject.kind,
        title: subject.title,
        prompt: subject.prompt,
        refs: subject.refs.map((r, i) => ({ n: i + 1, label: r.label, role: r.role, url: r.url })),
        refPrefix: '',
        params: { size: input.size || '2K' },
        estimate: 'one Seedream image · seconds',
      },
    };
  }

  const shot = resolveShot(project, input.shot, thread);
  if (!shot) return { error: `no shot matches ${JSON.stringify(input.shot ?? null)}` };
  const missing = needPrompt(shot);
  if (missing) return { error: missing };
  if (!shot.model) return { error: 'this shot has no model slot set.' };

  const traits = videoTraits(shot.model);
  const resolution = clampResolution(shot.model, shot.resolution || resDefault(shot.model));

  if (name === 'never') {
    return {
      card: {
        tool: 'still',
        shotId: shot.id,
        title: shot.title,
        prompt: shot.prompt,                       // shown in full BEFORE spending (§8)
        refs: shot.refs.map((r, i) => ({ n: i + 1, label: r.label, role: r.role, url: r.url })),
        refPrefix: '',
        params: { size: input.size || '2K' },
        estimate: 'one Seedream image · seconds',
      },
    };
  }

  if (name === 'edit') {
    const take = shot.takes.find((t) => t.id === input.take) || shot.takes.find((t) => t.id === shot.chosenTakeId) || shot.takes[shot.takes.length - 1];
    if (!take) return { error: 'this shot has no take to edit yet.' };
    return {
      card: {
        tool: 'edit',
        shotId: shot.id,
        title: shot.title,
        takeId: take.id,
        sourceUrl: take.url,
        prompt: shot.prompt,
        refs: [],
        refPrefix: traits.refPrefix,
        // An EDITING TASK LOCKS RATIO AND DURATION. Sending either fails the request with
        // InvalidParameter.TaskTypeConstraint. Resolution IS still honoured.
        params: { model: shot.model, resolution, ratio: null, duration: null },
        estimate: 'a Seedance editing task · minutes',
      },
    };
  }

  return {
    card: {
      tool: 'shoot',
      shotId: shot.id,
      title: shot.title,
      prompt: shot.prompt,
      refs: shot.refs.map((r, i) => ({ n: i + 1, label: r.label, role: r.role, url: r.url })),
      refPrefix: traits.refPrefix,
      params: {
        model: shot.model,
        resolution,
        ratio: shot.ratio || 'adaptive',
        duration: shot.duration ?? 'auto',
        generateAudio: !!shot.generateAudio,
        seed: shot.seed ?? null,
      },
      estimate: `one Seedance take on ${shot.model} · minutes`,
    },
  };
};

const landTake = (project, shotId, take) => {
  const shot = shotById(project, shotId);
  if (!shot) return project;
  return setShotFields(project, shotId, {
    takes: [...shot.takes, take],
    chosenTakeId: shot.chosenTakeId || take.id,
  });
};

// ---- still -------------------------------------------------------------------------

export const still = {
  name: 'still',
  gated: true,
  describe: 'still — { "shot": <n|id> }. Renders ONE Seedream image of this shot. Costs money; you will be asked to approve it.',
  validate: () => null,
  prepare: (args) => prepare('still', args),
  run: async ({ card, project, ctx }) => {
    const started = Date.now();
    const { url, cacheUrl } = await ctx.client.generateImage({
      prompt: card.prompt,                          // verbatim — no assembly (§8)
      referenceImages: card.refs.map((r) => r.url).filter(Boolean),
      size: card.params.size,
    });
    const still_ = {
      id: newId('still'),
      // The raw generation url EXPIRES (~24h). cacheUrl is the media store's copy — disk
      // plus the TOS mirror — so a still outlives the request that made it. A take whose
      // video is gone cannot explain itself, whatever promptUsed says (§3 invariant 3).
      url: cacheUrl || url,
      sourceUrl: url,
      createdAt: new Date().toISOString(),
      ms: Date.now() - started,
      promptUsed: card.prompt,                      // §3 invariant 3
    };
    // A plate lands on the bible entry (and becomes its plateUrl, which is what RIDES in
    // later requests — §8: consistency is attachment). A shot's still lands on the shot.
    const next = card.subjectKind === 'bible'
      ? setBibleFields(project, card.shotId, {
        stills: [...(project.bible.find((b) => b.id === card.shotId)?.stills || []), still_],
        plateUrl: still_.url,
      })
      : setShotFields(project, card.shotId, {
        stills: [...(shotById(project, card.shotId)?.stills || []), still_],
      });
    return { project: next, cost: 1, output: { kind: 'still', shotId: card.shotId, still: still_ } };
  },
};

// ---- shoot -------------------------------------------------------------------------

export const shoot = {
  name: 'shoot',
  gated: true,
  describe: 'shoot — { "shot": <n|id> }. Renders ONE Seedance take. Costs money and takes minutes; you will be asked to approve it.',
  validate: () => null,
  prepare: (args) => prepare('shoot', args),
  run: async ({ card, project, ctx }) => {
    const started = Date.now();
    const p = card.params;

    // THE ONE SPEC-LEGAL SHAPE. Leaving camera/lens/focalLength/aperture unset makes the
    // kit's buildAnimatePrompt return `motion` untouched — the prompt is the prompt.
    const { taskId, prompt } = await animate({
      motion: card.prompt,
      refUrls: card.refs.map((r) => r.url).filter(Boolean),
      refAssetIds: card.refs.map((r) => r.assetId || null),
      duration: p.duration,
      resolution: p.resolution,
      ratio: p.ratio,
      generateAudio: p.generateAudio,
      seed: p.seed,
      modelKey: p.model,
    }, { client: ctx.client });

    // Announce the task BEFORE polling: a Seedance take runs for minutes, and the id is
    // what lets the render survive a reload.
    if (ctx.onTask) await ctx.onTask({ taskId, tool: 'shoot', label: card.title || 'a take' });

    const { videoUrl, lastFrameUrl, videoCacheUrl, lastFrameCacheUrl } = await ctx.client.pollVideo({ taskId });

    const take = {
      id: newId('take'),
      url: videoCacheUrl || videoUrl,               // durable copy first — the raw url expires
      sourceUrl: videoUrl,
      posterUrl: lastFrameCacheUrl || lastFrameUrl || null,
      createdAt: new Date().toISOString(),
      ms: Date.now() - started,
      promptUsed: prompt,                           // what was ACTUALLY sent (§3)
      model: p.model,
      seed: p.seed,
      resolution: p.resolution,
      ratio: p.ratio,
      duration: p.duration,
    };
    return { project: landTake(project, card.shotId, take), cost: 1, output: { kind: 'take', shotId: card.shotId, take } };
  },
};

// ---- edit --------------------------------------------------------------------------

export const edit = {
  name: 'edit',
  gated: true,
  describe: 'edit — { "shot": <n|id>, "take": "<takeId>" }. Runs a Seedance editing task on an existing take. Costs money; you will be asked to approve it.',
  validate: () => null,
  prepare: (args) => prepare('edit', args),
  run: async ({ card, project, ctx }) => {
    const started = Date.now();
    // ratio and duration are NOT SENT — an editing task locks both and rejects the
    // request outright if either rides along. Resolution is honoured.
    const { taskId, prompt } = await animate({
      motion: card.prompt,
      videoRefUrls: [card.sourceUrl],
      duration: 'auto',                             // 'auto' omits the field entirely
      ratio: null,
      resolution: card.params.resolution,
      generateAudio: false,
      modelKey: card.params.model,
    }, { client: ctx.client });

    // Announce the task BEFORE polling: a Seedance take runs for minutes, and the id is
    // what lets the render survive a reload.
    if (ctx.onTask) await ctx.onTask({ taskId, tool: 'shoot', label: card.title || 'a take' });

    const { videoUrl, lastFrameUrl, videoCacheUrl, lastFrameCacheUrl } = await ctx.client.pollVideo({ taskId });

    const take = {
      id: newId('take'),
      url: videoCacheUrl || videoUrl,               // durable copy first — the raw url expires
      sourceUrl: videoUrl,
      posterUrl: lastFrameCacheUrl || lastFrameUrl || null,
      createdAt: new Date().toISOString(),
      ms: Date.now() - started,
      promptUsed: prompt,
      model: card.params.model,
      resolution: card.params.resolution,
      editedFrom: card.takeId,
    };
    return { project: landTake(project, card.shotId, take), cost: 1, output: { kind: 'take', shotId: card.shotId, take, editedFrom: card.takeId } };
  },
};

export const GATED = { still, shoot, edit };
