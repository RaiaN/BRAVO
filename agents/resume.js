// RESUMING A RENDER ACROSS A RELOAD.
//
// The loop runs in the browser, so closing the tab kills the turn — but the Seedance task
// does NOT stop: it keeps running on the server and its id is durable. An activity row is
// written before polling begins, so on the next load we can pick the task back up instead
// of losing a take that was already paid for.
//
// This is what makes "background" honest. Nothing is queued locally; what survives is a
// task the server is already working on, and its id.

import {
  appendMessage, newId, patchActivity, removeActivity, setShotFields, shotById, threadById,
} from '../state/project.js';

const landTake = (project, shotId, take) => {
  const shot = shotById(project, shotId);
  if (!shot) return project;
  return setShotFields(project, shotId, {
    takes: [...shot.takes, take],
    chosenTakeId: shot.chosenTakeId || take.id,
  });
};

// Resume every render that was in flight. Returns the project with whatever landed.
export const resumeActivity = async ({ client, project, onProgress = () => {} }) => {
  let p = project;
  const running = (p.activity || []).filter((a) => a.state === 'running' && a.taskId);
  if (!running.length) return p;

  for (const act of running) {
    p = patchActivity(p, act.id, { resumed: true });
    onProgress(p);
    try {
      // eslint-disable-next-line no-await-in-loop
      const { videoUrl, lastFrameUrl, videoCacheUrl, lastFrameCacheUrl } = await client.pollVideo({ taskId: act.taskId });
      const msg = threadById(p, act.threadId)?.messages.find((m) => m.id === act.messageId);
      const card = msg?.tool?.card;
      const take = {
        id: newId('take'),
        url: videoCacheUrl || videoUrl,
        sourceUrl: videoUrl,
        posterUrl: lastFrameCacheUrl || lastFrameUrl || null,
        createdAt: new Date().toISOString(),
        promptUsed: card?.prompt || '',
        model: card?.params?.model || null,
        resolution: card?.params?.resolution || null,
        ...(act.tool === 'edit' ? { editedFrom: card?.takeId } : {}),
      };
      if (card?.shotId) p = landTake(p, card.shotId, take);
      if (msg) {
        p = {
          ...p,
          threads: p.threads.map((t) => (t.id === act.threadId
            ? { ...t, messages: t.messages.map((m) => (m.id === act.messageId ? { ...m, tool: { ...m.tool, output: { kind: 'take', shotId: card?.shotId, take }, cost: 1 } } : m)) }
            : t)),
        };
      }
      p = removeActivity(p, act.id);
      p = appendMessage(p, act.threadId, {
        role: 'agent',
        text: `That render finished while you were away — it was still running at Seedance, so I picked it back up.`,
      });
    } catch (err) {
      p = removeActivity(p, act.id);
      p = appendMessage(p, act.threadId, {
        role: 'agent',
        text: `The render that was in flight could not be recovered: ${err.message}`,
      });
    }
    onProgress(p);
  }
  return p;
};
