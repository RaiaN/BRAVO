// THE TOOL-CALL PROTOCOL.
//
// `/api/seed` has no function calling — it takes a prompt and returns a plain string
// (§10 keeps the kit unchanged, so we do not add `tools` to it). The agent therefore
// speaks a text grammar and BRAVO parses it.
//
// That makes this file the code gate §8 demands: "every LLM promise needs a code gate — a
// deterministic check, a retry, a visible report." Nothing downstream trusts the model.
// A call that does not parse, names a tool the agent does not hold, or carries the wrong
// shape of input, is REJECTED here and reported — never guessed at, never defaulted.

export const FENCE = 'bravo';

// The grammar, quoted into every agent's system prompt so there is exactly one definition
// of it in the codebase.
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

// ---- parsing ---------------------------------------------------------------------

const FENCE_RE = new RegExp(`\`\`\`${FENCE}\\s*\\n([\\s\\S]*?)\`\`\``, 'g');

// LAYER 1 — the block format itself: a JSON object inside a ```bravo fence. Every agent
// speaks this. What the object CONTAINS varies: a shot agent emits tool calls, the router
// emits a kind. Keeping the two apart matters — parsing a router answer with the tool-call
// rules discards it as malformed, which is a bug this file has already had once.
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

// LAYER 2 — the TOOL-CALL shape. Split a reply into the prose a person reads and the
// calls the machine runs. `errors` carries every block that failed, so the retry can quote
// the exact fault back to the model instead of asking it to try harder.
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

// ---- the gate --------------------------------------------------------------------

// A call the agent is not allowed to make is not an error to recover from — it is a
// refusal to report (§8: an unknown id resolves to nothing). `allowed` is the agent's own
// tool list from §4, so an agent can never reach a tool outside its row.
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

// The message handed back to the model when a reply did not parse. It quotes the fault
// verbatim — a retry that just says "try again" teaches the model nothing.
export const retryPrompt = (errors) => [
  'Your last reply had blocks that could not be read:',
  ...errors.map((e, i) => `${i + 1}. ${e.error}\n   in: ${e.body.slice(0, 200)}`),
  '',
  'Emit the corrected blocks. Change nothing else.',
].join('\n');
