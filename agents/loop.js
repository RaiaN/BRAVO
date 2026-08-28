// THE TURN: plan → tools → report (§9).
//
// One turn is one user message answered. Inside it the agent may call tools several
// times, seeing each result before deciding the next thing — that is the loop. It ends
// when the agent emits prose and no calls, when it hits the step cap, or when it needs
// the person.
//
// Every LLM promise here has a code gate (§8): the reply is parsed, each call is checked
// against the agent's own tool row, and a reply that does not parse is retried ONCE with
// the exact fault quoted back. A second failure is reported, not smoothed over.

import { appendMessage, latchThread, setThreadStatus, threadById } from '../state/project.js';
import { gateCall, parseReply, retryPrompt } from './protocol.js';
import { TOOLS, TOOLS_BY_KIND } from './tools/index.js';
import { route } from './router.js';
import { shotContext, shotSystem } from './shot.js';

export const MAX_STEPS = 6;      // tool rounds per turn, before the agent must report

// Per-kind wiring. Phase A implements `shot`; the others latch and say so honestly rather
// than pretending. Each entry: the system prompt, the live context, the tools it holds.
const AGENTS = {
  shot: { system: shotSystem, context: shotContext, tools: TOOLS_BY_KIND.shot },
};

const notYet = (kind) => ({
  system: () => `You are the ${kind} agent in BRAVO. Your implementation has not landed yet.
Say so in one sentence, say what you WILL do when it lands, and emit no tool blocks.`,
  context: () => '',
  tools: [],
});

const agentFor = (kind) => AGENTS[kind] || notYet(kind);

// The transcript the model sees. §4: the messages up to a cap, then a rolling summary of
// decisions beneath that. The cap is on TURNS, not characters, so a long tool result
// never silently evicts the thing the person actually said.
export const transcriptFor = (thread, cap = 24) => {
  const msgs = thread.messages;
  const recent = msgs.slice(-cap);
  const older = msgs.slice(0, -cap);
  const summary = older.length
    ? `EARLIER IN THIS THREAD (${older.length} messages, summarised): ${older
        .filter((m) => m.role !== 'tool')
        .slice(-12)
        .map((m) => `${m.role}: ${String(m.text || '').slice(0, 120)}`)
        .join(' | ')}\n\n`
    : '';
  const body = recent.map((m) => {
    // "YOU ALREADY RAN", not "[tool …]". Labelled neutrally, the agent reads its own
    // completed work as new information and second-guesses it — one observed run moved a
    // shot and then reported "no move was needed, the sequence is unchanged".
    if (m.role === 'tool') return `YOU ALREADY RAN ${m.tool.name} → ${JSON.stringify(m.tool.output).slice(0, 1200)}`;
    return `${m.role === 'user' ? 'PERSON' : 'YOU'}: ${m.text}`;
  }).join('\n');
  return summary + body;
};

// Run one turn. `onProgress(project)` is called after every state change so the rail and
// the transcript update live rather than all at the end.
export const runTurn = async ({ client, project, threadId, modelId = null, onProgress = () => {} }) => {
  let p = project;
  const push = (msg) => { p = appendMessage(p, threadId, msg); onProgress(p); };
  const status = (s) => { p = setThreadStatus(p, threadId, s); onProgress(p); };

  let thread = threadById(p, threadId);
  if (!thread) return p;                                  // unknown id → nothing (§8)

  status('working');

  try {
    // ---- route, if this thread is still unisex -------------------------------------
    if (!thread.kind) {
      const first = [...thread.messages].reverse().find((m) => m.role === 'user');
      const decision = await route({ client, message: first?.text || '', modelId });
      if (decision.ask) {
        push({ role: 'agent', text: decision.ask });
        status('needs-you');
        return p;                                          // stays unisex, on purpose
      }
      const latched = latchThread(p, threadId, decision.kind, { title: decision.title });
      p = latched.project;
      thread = latched.thread;
      onProgress(p);
      push({ role: 'tool', text: '', tool: { name: 'route', input: {}, output: { kind: 'routed', to: decision.kind, title: decision.title }, approved: true, cost: 0 } });
    }

    const agent = agentFor(thread.kind);
    const system = agent.system();

    // ---- the loop ------------------------------------------------------------------
    for (let step = 0; step < MAX_STEPS; step += 1) {
      thread = threadById(p, threadId);
      const prompt = [agent.context(p, thread), '', transcriptFor(thread)].filter(Boolean).join('\n');

      let { content } = await client.reason({ prompt, systemPrompt: system, modelId });
      let { prose, calls, errors } = parseReply(content);

      // ONE retry, quoting the exact fault. Not "try harder" — the parse error itself.
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
          return p;
        }
      }

      if (prose) push({ role: 'agent', text: prose });

      // No calls → the agent has reported. The turn is over.
      if (!calls.length) {
        status(thread.subjectId ? 'idle' : 'needs-you');
        return p;
      }

      for (const call of calls) {
        const gate = gateCall(call, agent.tools, TOOLS);
        if (!gate.ok) {
          push({ role: 'tool', text: '', tool: { name: call.tool, input: call.input, output: { kind: 'error', error: gate.reason }, approved: true, cost: 0 } });
          continue;                                        // refused, recorded, visible
        }
        const result = TOOLS[call.tool].run({ input: call.input, project: p, thread: threadById(p, threadId) });
        p = result.project;
        push({ role: 'tool', text: '', tool: { name: call.tool, input: call.input, output: result.output, approved: true, cost: result.cost || 0 } });
      }
    }

    push({ role: 'agent', text: `I stopped after ${MAX_STEPS} rounds of tools without finishing. Tell me what to do next.` });
    status('needs-you');
    return p;
  } catch (err) {
    push({ role: 'agent', text: `That failed: ${err.message}` });
    status('needs-you');
    return p;
  }
};
