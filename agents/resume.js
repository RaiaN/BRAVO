import {
  appendMessage, makeMessage, newId, patchActivity, removeActivity, setShotFields, shotById, threadById,
} from '../state/project.js';
import { tracedClient } from './trace.js';

const landTake = (project, shotId, take) => {
  const shot = shotById(project, shotId);
  if (!shot) return project;
  return setShotFields(project, shotId, {
    takes: [...shot.takes, take],
    chosenTakeId: shot.chosenTakeId || take.id,
  });
};

export const resumeActivity = async ({ get, apply }) => {
  const running = (get().activity || []).filter((a) => a.state === 'running' && a.taskId && !a.seqId);

  for (const act of running) {
    apply((prev) => patchActivity(prev, act.id, { resumed: true }));
    try {
      // eslint-disable-next-line no-await-in-loop
      const { videoUrl, lastFrameUrl, videoCacheUrl, lastFrameCacheUrl } = await tracedClient(act.threadId).pollVideo({ taskId: act.taskId });
      apply((prev) => {
        const msg = threadById(prev, act.threadId)?.messages.find((m) => m.id === act.messageId);
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
        let next = card?.shotId ? landTake(prev, card.shotId, take) : prev;
        if (msg) {
          next = {
            ...next,
            threads: next.threads.map((t) => (t.id === act.threadId
              ? { ...t, messages: t.messages.map((m) => (m.id === act.messageId ? { ...m, tool: { ...m.tool, output: { kind: 'take', shotId: card?.shotId, take }, cost: 1 } } : m)) }
              : t)),
          };
        }
        next = removeActivity(next, act.id);
        return appendMessage(next, act.threadId, {
          role: 'agent',
          text: `That render finished while you were away — it was still running at Seedance, so I picked it back up.`,
        });
      });
    } catch (err) {
      apply((prev) => appendMessage(removeActivity(prev, act.id), act.threadId, {
        role: 'agent',
        text: `The render that was in flight could not be recovered: ${err.message}`,
      }));
    }
  }
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
