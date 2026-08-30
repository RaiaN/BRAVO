export const FENCE = 'bravo';

export const PROTOCOL_PROMPT = `To use a tool, emit a fenced block tagged \`${FENCE}\` containing one JSON object:

\`\`\`${FENCE}
{ "tool": "write", "input": { "shot": 3, "title": "the collision" } }
\`\`\`

Rules:
- One JSON object per block. Emit several blocks to call several tools, in order.
- Write prose outside the blocks. That prose is what the person reads.
- Use ONLY the tools listed above. Any other name is refused.
- Refer to a shot by its number as shown in the film, or by its id. Never invent one.
- When you have nothing left to do, write your report as prose and emit no blocks.`;

const FENCE_RE = new RegExp(`\`\`\`${FENCE}\\s*\\n([\\s\\S]*?)\`\`\``, 'g');

export const parseBlocks = (text) => {
  const raw = String(text || '');
  const blocks = [];
  const errors = [];
  let prose = raw;

  for (const m of raw.matchAll(FENCE_RE)) {
    prose = prose.replace(m[0], '');
    const body = m[1].trim();
    if (!body) { errors.push({ body, error: 'the block is empty' }); continue; }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      errors.push({ body, error: `not valid JSON (${e.message})` });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push({ body, error: 'the block must be a single JSON object' });
      continue;
    }
    blocks.push(parsed);
  }

  return { prose: prose.replace(/\n{3,}/g, '\n\n').trim(), blocks, errors };
};

export const parseReply = (text) => {
  const { prose, blocks, errors } = parseBlocks(text);
  const calls = [];

  for (const parsed of blocks) {
    if (typeof parsed.tool !== 'string' || !parsed.tool.trim()) {
      errors.push({ body: JSON.stringify(parsed), error: 'the object needs a "tool" name' });
      continue;
    }
    const input = parsed.input === undefined ? {} : parsed.input;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      errors.push({ body: JSON.stringify(parsed), error: '"input" must be an object' });
      continue;
    }
    calls.push({ tool: parsed.tool.trim(), input });
  }

  return { prose, calls, errors };
};

export const gateCall = (call, allowed, tools) => {
  if (!allowed.includes(call.tool)) {
    return { ok: false, reason: `"${call.tool}" is not a tool this agent holds (it has: ${allowed.join(', ')})` };
  }
  const tool = tools[call.tool];
  if (!tool) return { ok: false, reason: `"${call.tool}" is not implemented` };
  const problem = tool.validate ? tool.validate(call.input) : null;
  if (problem) return { ok: false, reason: problem };
  return { ok: true };
};

export const retryPrompt = (errors) => [
  'Your last reply had blocks that could not be read:',
  ...errors.map((e, i) => `${i + 1}. ${e.error}\n   in: ${e.body.slice(0, 200)}`),
  '',
  'Emit the corrected blocks. Change nothing else.',
].join('\n');
