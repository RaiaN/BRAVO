// THE SESSION — decides when a turn runs, and what must happen first: routing a blank
// thread, latching it to its artifact, approving or cancelling a gated card.
//
// Separate from the engine because routing is a policy about the studio, not a step
// inside a turn — and a thread that never routes must never reach the engine.

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

// Route a unisex thread and latch it (from here it owns exactly one artifact).
// Returns true when the thread is ready for a turn.
const ensureRouted = async ({ client, threadId, get, apply, modelId }) => {
  const thread = threadById(get(), threadId);
  if (!thread) return false;
  if (thread.kind) return true;

  const first = [...thread.messages].reverse().find((m) => m.role === 'user');
  // The router is only ever offered agents that are actually switched on, so it cannot
  // route a thread to something that will then refuse to run.
  const decision = await route({ client, message: first?.text || '', modelId, choices: enabledAgents() });

  if (decision.ask) {
    apply((prev) => appendMessage(prev, threadId, { role: 'agent', text: decision.ask }));
    apply((prev) => setThreadStatus(prev, threadId, 'needs-you'));
    return false;                                          // stays unisex, on purpose
  }

  // The module decides how its own kind acquires a subject — the session does not know.
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

// The one entry point the shell calls: get this thread to the point where it can work,
// then work.
export const advance = async ({ client, threadId, get, apply, modelId = null }) => {
  const ready = await ensureRouted({ client, threadId, get, apply, modelId });
  if (!ready) return;
  await runTurn({ client, threadId, get, apply, modelId });
};

// Run a gated call the person approved. The card is the record of what was shown before
// spending, so this sends exactly that and nothing reassembled.
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

  // The activity row is written the moment a task id exists — so a render that takes
  // minutes is visible while it runs, and recoverable if the tab closes.
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

  // Let the agent see what came back and report on it.
  await runTurn({ client, threadId, get, apply, modelId });
};

// Cancel: the card is marked refused and nothing is ever sent.
export const cancelCall = (project, threadId, messageId) => setThreadStatus({
  ...project,
  threads: project.threads.map((t) => (t.id === threadId
    ? { ...t, messages: t.messages.map((m) => (m.id === messageId ? { ...m, tool: { ...m.tool, output: { kind: 'cancelled' }, approved: false } } : m)) }
    : t)),
}, threadId, 'idle');
