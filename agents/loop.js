import { appendMessage, setThreadStatus, threadById } from '../state/project.js';
import { mergeChanges } from '../state/merge.js';
import { gateCall, parseReply, retryPrompt } from './protocol.js';
import { TOOLS } from './tools/index.js';
import { agentFor, explainMissing } from './registry.js';
import { DEFAULT_GUARDS, makeThrashGuard, runGuards } from './guards.js';
import { transcriptFor } from './transcript.js';
import { requireSkillLine } from '../utils/film/skills.js';

export const MAX_STEPS = 6;

export const runTurn = async ({ client, threadId, get, apply, modelId = null }) => {
  const p = () => get();
  const push = (msg) => apply((prev) => appendMessage(prev, threadId, msg));
  const status = (s) => apply((prev) => setThreadStatus(prev, threadId, s));

  const thread0 = threadById(p(), threadId);
  if (!thread0) return;

  const agent = agentFor(thread0.kind);
  if (!agent) {
    push({ role: 'agent', text: `I cannot run: ${explainMissing(thread0.kind)}.` });
    status('needs-you');
    return;
  }

  const system = agent.system();
  const guards = [...DEFAULT_GUARDS, ...(agent.guards || [])];
  const thrash = makeThrashGuard();
  let rendered = false;

  status('working');

  try {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const thread = threadById(p(), threadId);
      const prompt = [agent.context(p(), thread), '', transcriptFor(thread)].filter(Boolean).join('\n');

      let { content } = await client.reason({ prompt, systemPrompt: system, modelId });
      let { prose, calls, errors } = parseReply(content);

      if (errors.length && !calls.length) {
        const retry = await client.reason({
          prompt: `${prompt}\n\nYOUR REPLY:\n${content}\n\n${retryPrompt(errors)}`,
          systemPrompt: system,
          modelId,
        });
        ({ prose, calls, errors } = parseReply(retry.content));
        if (errors.length && !calls.length) {
          push({ role: 'agent', text: `${prose || 'I could not phrase that as a tool call.'}\n\n(${errors.length} unreadable block${errors.length === 1 ? '' : 's'} — nothing was changed.)` });
          status('needs-you');
          return;
        }
      }

      if (prose) {
        push({ role: 'agent', text: prose });
        runGuards(guards, { prose, calls, rendered, thread, agent })
          .forEach((correction) => push({ role: 'agent', text: correction }));
      }

      if (!calls.length) {
        status(threadById(p(), threadId).subjectId ? 'idle' : 'needs-you');
        return;
      }

      for (const call of calls) {
        const gate = gateCall(call, agent.tools, TOOLS);
        if (!gate.ok) {
          push({ role: 'tool', text: '', tool: { name: call.tool, input: call.input, output: { kind: 'error', error: gate.reason }, approved: true, cost: 0 } });
          continue;
        }

        const tool = TOOLS[call.tool];

        if (tool.gated) {
          const t = threadById(p(), threadId);
          const { takesCap, spentTakes } = t.budget;
          if (spentTakes >= takesCap) {
            push({ role: 'agent', text: `I have used this thread's budget of ${takesCap} render${takesCap === 1 ? '' : 's'}. Raise the cap if you want more.` });
            status('needs-you');
            return;
          }
          const prepared = tool.prepare({ input: call.input, project: p(), thread: t });
          if (prepared.error) {
            push({ role: 'tool', text: '', tool: { name: call.tool, input: call.input, output: { kind: 'error', error: prepared.error }, approved: true, cost: 0 } });
            continue;
          }
          push({ role: 'tool', text: '', tool: { name: call.tool, input: call.input, card: prepared.card, output: null, approved: false, cost: 0 } });
          status('needs-you');
          return;
        }

        const snapshot = p();
        // eslint-disable-next-line no-await-in-loop -- calls are ordered on purpose: each
        const result = await tool.run({
          input: call.input,
          project: snapshot,
          thread: threadById(snapshot, threadId),
          ctx: { client, modelId, requireSkillLine },
        });
        apply((prev) => mergeChanges(prev, snapshot, result.project));
        push({ role: 'tool', text: '', tool: { name: call.tool, input: call.input, output: result.output, approved: true, cost: result.cost || 0 } });

        const stop = thrash(call.tool, result.output?.kind === 'error' ? result.output.error : null);
        if (stop) {
          push({ role: 'agent', text: stop });
          status('needs-you');
          return;
        }
      }
    }

    const done = threadById(p(), threadId).messages.filter((m) => m.role === 'tool' && m.tool.output && m.tool.output.kind !== 'error').map((m) => m.tool.name);
    push({ role: 'agent', text: `I stopped after ${MAX_STEPS} rounds this turn. Completed so far: ${[...new Set(done)].join(', ') || 'nothing'}. Tell me the single next step and I will take it.` });
    status('needs-you');
  } catch (err) {
    push({ role: 'agent', text: `That failed: ${err.message}` });
    status('needs-you');
  }
};
