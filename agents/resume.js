import {
  appendMessage, makeMessage, newId, patchActivity, removeActivity, setShotFields, shotById, threadById,
} from '../state/project.js';

const landTake = (project, shotId, take) => {
  const shot = shotById(project, shotId);
  if (!shot) return project;
  return setShotFields(project, shotId, {
    takes: [...shot.takes, take],
    chosenTakeId: shot.chosenTakeId || take.id,
  });
};

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

export const reconcileInterrupted = (project) => {
  const stillRendering = new Set((project.activity || []).filter((a) => a.state === 'running').map((a) => a.threadId));
  const stuck = project.threads.filter((t) => t.status === 'working' && !stillRendering.has(t.id));
  if (!stuck.length) return project;
  return {
    ...project,
    threads: project.threads.map((t) => (stuck.includes(t)
      ? {
        ...t,
        status: 'needs-you',
        messages: [...t.messages, makeMessage({
          role: 'agent',
          text: 'That turn was interrupted — the page reloaded while I was working. Nothing was lost. Say it again and I will pick it up.',
        })],
      }
      : t)),
  };
};
