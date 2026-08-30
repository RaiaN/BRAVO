import { parseBlocks } from './protocol.js';

const systemFor = (choices) => `You route a new conversation to the right agent in BRAVO, a film studio.

The agents:
${choices.map((a) => `- ${a.id}: ${a.job}`).join('\n')}

Read the person's first message and answer with ONE fenced block tagged \`bravo\`:

\`\`\`bravo
{ "kind": "shot", "title": "the collision" }
\`\`\`

"title" is a SHORT name for what this thread is about — AT MOST FIVE WORDS, in the
person's own words where you can. Lowercase, plain words: "the collision".

If the message genuinely does not indicate which agent is wanted, do NOT pick one. Ask:

\`\`\`bravo
{ "ask": "Do you want to make a shot, or start a reference plate?" }
\`\`\`

Guessing is worse than asking. Answer with the block and nothing else.`;

export const route = async ({ client, message, modelId = null, choices = [] }) => {
  const kinds = choices.map((a) => a.id);
  const { content } = await client.reason({
    prompt: message,
    systemPrompt: systemFor(choices),
    modelId,
    reasoningEffort: 'low',
  });

  const { blocks } = parseBlocks(content);
  const answer = blocks[0];

  if (!answer) {
    return { ask: `I could not tell what this thread is for. This studio has: ${kinds.join(', ')}.` };
  }
  if (typeof answer.ask === 'string' && answer.ask.trim()) return { ask: answer.ask.trim() };
  if (!kinds.includes(answer.kind)) {
    return { ask: `I could not place that (it suggested "${answer.kind ?? 'nothing'}"). This studio has: ${kinds.join(', ')}.` };
  }
  return { kind: answer.kind, title: shortTitle(answer.title) };
};

export const shortTitle = (raw) => {
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
