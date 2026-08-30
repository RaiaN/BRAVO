// THE ROUTER — what turns a unisex thread into an agent.
//
// A thread is born with no kind. The first message decides which agent it belongs to, and
// the kind then LATCHES (a thread owns exactly one artifact). This runs once per
// thread, ever.
//
// It is an LLM promise, so applies in full: the answer is checked against the known
// kinds, and anything else becomes a QUESTION rather than a guess. There is no default
// kind — "never substitute a default" covers routing too.

import { parseBlocks } from './protocol.js';

// The roster is not hardcoded here: it comes from whichever agents are REGISTERED AND
// ENABLED, so a switched-off agent can never be routed to and a new one needs no edit.
const systemFor = (choices) => `You route a new conversation to the right agent in BRAVO, a film studio.

The agents:
${choices.map((a) => `- ${a.id}: ${a.job}`).join('\n')}

Read the person's first message and answer with ONE fenced block tagged \`bravo\`:

\`\`\`bravo
{ "kind": "shot", "title": "the collision" }
\`\`\`

"title" is a SHORT name for what this thread is about — AT MOST FIVE WORDS, in the
person's own words where you can. Lowercase, no punctuation at the end. "the collision",
not "shot 3 is the collision where the wolf lands on the log".

If the message genuinely does not indicate which agent is wanted, do NOT pick one. Ask:

\`\`\`bravo
{ "ask": "Do you want to make a shot, or start a reference plate?" }
\`\`\`

Guessing is worse than asking. Answer with the block and nothing else.`;

// → { kind, title } when it routed, or { ask } when it could not, or { ask } again when
// the model returned something outside the known list. The caller latches only on `kind`.
export const route = async ({ client, message, modelId = null, choices = [] }) => {
  const kinds = choices.map((a) => a.id);
  const { content } = await client.reason({
    prompt: message,
    systemPrompt: systemFor(choices),
    modelId,
    reasoningEffort: 'low',      // a one-line classification, not the heavy thinking
  });

  // The router's block is `{kind}` or `{ask}` — NOT a tool call, so it is read with the
  // block parser, not parseReply. Reading it with the tool-call rules threw every valid
  // answer away as "missing a tool name".
  const { blocks } = parseBlocks(content);
  const answer = blocks[0];

  // THE GATE. Nothing below trusts the model's word for it.
  if (!answer) {
    return { ask: `I could not tell what this thread is for. This studio has: ${kinds.join(', ')}.` };
  }
  if (typeof answer.ask === 'string' && answer.ask.trim()) return { ask: answer.ask.trim() };
  if (!kinds.includes(answer.kind)) {
    return { ask: `I could not place that (it suggested "${answer.kind ?? 'nothing'}"). This studio has: ${kinds.join(', ')}.` };
  }
  return { kind: answer.kind, title: shortTitle(answer.title) };
};

// A title is a rail label, not a sentence — an over-long one truncates mid-word in every
// row that shows it. The prompt asks for five words; this is the gate that means it (// an LLM promise needs a deterministic check, not a hope).
export const shortTitle = (raw) => {
  // Trim BEFORE stripping quotes: anchored ^ and $ never reach them through padding, so
  // `  "The Collision."  ` came back still wearing its quotes.
  const clean = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'\u201c\u2018]+/, '')
    .replace(/["'\u201d\u2019.,;:!?]+$/, '')
    .trim()
    .toLowerCase();
  if (!clean) return '';
  const words = clean.split(' ').slice(0, 5).join(' ');
  return words.length > 42 ? `${words.slice(0, 41).trimEnd()}\u2026` : words;
};
