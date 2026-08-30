// THE TURN ENGINE (§9: "loop.js — the turn: plan → tools → report").
//
// ─────────────────────────────────────────────────────────────────────────────────────
// RESPONSIBILITY, exactly one: run ONE turn of ONE already-routed thread.
//
// It owns:      the plan→act→observe cycle, the reasoner call and its one retry, parsing,
//               enforcing the agent's tool row, turning a gated call into an approval
//               card, budget, thrash detection, and running the output guards.
// It does NOT:  know which agents exist, what any of them believes, how a thread acquires
//               a subject, what a tool does, when to route, or what the UI shows.
//
// Everything it needs arrives through three seams: an AGENT MODULE (registry.js), a TOOL
// REGISTRY (tools/index.js), and STATE ACCESS (`get`/`apply`). Adding an agent, a tool or
// a guard therefore never touches this file — which is the whole point of the split.
// ─────────────────────────────────────────────────────────────────────────────────────
//
// §4 has agents running independently "while you work in another thread", so a turn never
// holds a snapshot of the project and writes it back — the later writer would erase the
// other agent's work. It reads live through `get()` and mutates through a serialized
// `apply()`.

import { appendMessage, setThreadStatus, threadById } from '../state/project.js';
import { mergeChanges } from '../state/merge.js';
import { gateCall, parseReply, retryPrompt } from './protocol.js';
import { TOOLS } from './tools/index.js';
import { agentFor, explainMissing } from './registry.js';
import { DEFAULT_GUARDS, makeThrashGuard, runGuards } from './guards.js';
import { transcriptFor } from './transcript.js';
import { requireSkillLine } from '../utils/film/skills.js';

export const MAX_STEPS = 6;      // tool rounds per turn, before the agent must report

export const runTurn = async ({ client, threadId, get, apply, modelId = null }) => {
  const p = () => get();
  const push = (msg) => apply((prev) => appendMessage(prev, threadId, msg));
  const status = (s) => apply((prev) => setThreadStatus(prev, threadId, s));

  const thread0 = threadById(p(), threadId);
  if (!thread0) return;                                   // unknown id → nothing (§8)

  // An unknown or switched-off kind resolves to NOTHING and says which it was — it is
  // never quietly replaced by another agent (§8).
  const agent = agentFor(thread0.kind);
  if (!agent) {
    push({ role: 'agent', text: `I cannot run: ${explainMissing(thread0.kind)}.` });
    status('needs-you');
    return;
  }

  const system = agent.system();
  const guards = [...DEFAULT_GUARDS, ...(agent.guards || [])];
  const thrash = makeThrashGuard();
  let rendered = false;          // did a gated tool actually return something this turn?

  status('working');

  try {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const thread = threadById(p(), threadId);
      const prompt = [agent.context(p(), thread), '', transcriptFor(thread)].filter(Boolean).join('\n');

      // ---- plan ---------------------------------------------------------------------
      let { content } = await client.reason({ prompt, systemPrompt: system, modelId });
      let { prose, calls, errors } = parseReply(content);

      // ONE retry, quoting the exact fault. Not "try again" — the parse error itself.
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

      // ---- report -------------------------------------------------------------------
      if (prose) {
        push({ role: 'agent', text: prose });
        runGuards(guards, { prose, calls, rendered, thread, agent })
          .forEach((correction) => push({ role: 'agent', text: correction }));
      }

      if (!calls.length) {
        status(threadById(p(), threadId).subjectId ? 'idle' : 'needs-you');
        return;
      }

      // ---- act ----------------------------------------------------------------------
      for (const call of calls) {
        const gate = gateCall(call, agent.tools, TOOLS);
        if (!gate.ok) {
          push({ role: 'tool', text: '', tool: { name: call.tool, input: call.input, output: { kind: 'error', error: gate.reason }, approved: true, cost: 0 } });
          continue;                                        // refused, recorded, visible
        }

        const tool = TOOLS[call.tool];

        // GATED (§6): real money. NOTHING IS SENT FROM AN UNAPPROVED CARD. The call
        // becomes a card showing the exact prompt and ordered references, and the turn
        // stops so a person can decide.
        if (tool.gated) {
          const t = threadById(p(), threadId);
          const { takesCap, spentTakes } = t.budget;
          if (spentTakes >= takesCap) {
            // §6: an agent that reaches its cap STOPS and reports. It does not ask to
            // continue in a loop.
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
          return;                                          // the turn waits for a person
        }

        // ---- observe -----------------------------------------------------------------
        // The tool computes against a snapshot; only what it CHANGED is laid onto the live
        // project, so a concurrent run in another thread is not overwritten.
        const snapshot = p();
        // eslint-disable-next-line no-await-in-loop -- calls are ordered on purpose: each
        // one sees the state the previous left behind.
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

    push({ role: 'agent', text: `I stopped after ${MAX_STEPS} rounds of tools without finishing. Tell me what to do next.` });
    status('needs-you');
  } catch (err) {
    push({ role: 'agent', text: `That failed: ${err.message}` });
    status('needs-you');
  }
};
