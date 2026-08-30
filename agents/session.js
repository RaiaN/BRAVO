import {
  addActivity, appendMessage, latchThread, newId, removeActivity,
  setThreadStatus, threadById,
} from '../state/project.js';
import { mergeChanges } from '../state/merge.js';
import { TOOLS } from './tools/index.js';
import { agentFor, enabledAgents } from './registry.js';
import { route } from './router.js';
import { runTurn } from './loop.js';
import { defaultImageModelKey, defaultVideoModelKey } from '../utils/film/suiteConfig.js';

const ensureRouted = async ({ client, threadId, get, apply, modelId }) => {
  const thread = threadById(get(), threadId);
  if (!thread) return false;
  if (thread.kind) return true;

  const first = [...thread.messages].reverse().find((m) => m.role === 'user');
  const decision = await route({ client, message: first?.text || '', modelId, choices: enabledAgents() });

  if (decision.ask) {
    apply((prev) => appendMessage(prev, threadId, { role: 'agent', text: decision.ask }));
    apply((prev) => setThreadStatus(prev, threadId, 'needs-you'));
    return false;
  }

  const mod = agentFor(decision.kind);
  apply((prev) => {
    const made = mod?.latch
      ? mod.latch({ project: prev, title: decision.title, videoSlot: defaultVideoModelKey(), imageSlot: defaultImageModelKey() })
      : { project: prev, subjectId: null };
    return latchThread(made.project, threadId, decision.kind, { subjectId: made.subjectId, title: decision.title }).project;
  });
  apply((prev) => appendMessage(prev, threadId, {
    role: 'tool',
    text: '',
    tool: { name: 'route', input: {}, output: { kind: 'routed', to: decision.kind, title: decision.title }, approved: true, cost: 0 },
  }));
  return true;
};

export const advance = async ({ client, threadId, get, apply, modelId = null }) => {
  const ready = await ensureRouted({ client, threadId, get, apply, modelId });
  if (!ready) return;
  await runTurn({ client, threadId, get, apply, modelId });
};

export const approveCall = async ({ client, threadId, messageId, get, apply, modelId = null }) => {
  const p = () => get();
  const msg = threadById(p(), threadId)?.messages.find((m) => m.id === messageId);
  if (!msg || msg.role !== 'tool' || msg.approved || !msg.tool?.card) return;

  const tool = TOOLS[msg.tool.name];
  if (!tool?.gated) return;

  const mark = (patch) => apply((prev) => ({
    ...prev,
    threads: prev.threads.map((t) => (t.id === threadId
      ? { ...t, messages: t.messages.map((m) => (m.id === messageId ? { ...m, tool: { ...m.tool, ...patch } } : m)) }
      : t)),
  }));

  apply((prev) => setThreadStatus(prev, threadId, 'working'));
  mark({ approved: true });

  const activityId = newId('act');
  const onTask = async ({ taskId, tool: name, label }) => {
    apply((prev) => addActivity(prev, { id: activityId, threadId, messageId, taskId, tool: name, label }));
  };

  try {
    const snapshot = p();
    const result = await tool.run({ card: msg.tool.card, project: snapshot, ctx: { client, modelId, onTask } });
    apply((prev) => removeActivity(mergeChanges(prev, snapshot, result.project), activityId));
    mark({ output: result.output, cost: result.cost || 0 });
    apply((prev) => ({
      ...prev,
      threads: prev.threads.map((t) => (t.id === threadId
        ? { ...t, budget: { ...t.budget, spentTakes: t.budget.spentTakes + (result.cost || 0) } }
        : t)),
    }));
  } catch (err) {
    apply((prev) => removeActivity(prev, activityId));
    mark({ output: { kind: 'error', error: err.message } });
    apply((prev) => setThreadStatus(prev, threadId, 'needs-you'));
    return;
  }

  await runTurn({ client, threadId, get, apply, modelId });
};

export const cancelCall = (project, threadId, messageId) => setThreadStatus({
  ...project,
  threads: project.threads.map((t) => (t.id === threadId
    ? { ...t, messages: t.messages.map((m) => (m.id === messageId ? { ...m, tool: { ...m.tool, output: { kind: 'cancelled' }, approved: false } } : m)) }
    : t)),
}, threadId, 'idle');
