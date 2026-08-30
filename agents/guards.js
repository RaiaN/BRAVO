// OUTPUT GUARDS — the checks that run on what an agent SAYS, after its tools have run.
//
// §8: "Every LLM promise needs a code gate — a deterministic check, a retry, a visible
// report." A guard is that gate as a composable unit: `(report) → correction | null`.
// The turn engine runs them without knowing what any of them check, and an agent module
// can add its own.
//
// A guard corrects; it never silently rewrites. The agent's words stay in the transcript
// and the correction sits beneath them, so what happened is legible afterwards.

// ONLY claims that work is happening WITHOUT the person. Describing what a card will do
// once approved ("this will render one take") is honest and must not trip this — a gate
// that cries wolf gets ignored, which is worse than no gate at all.
const CLAIMS_WORK = /\b(queued|queueing|in the queue|render job|unattended|in the background|processing will|will process|complete automatically|automatically when|(you|you'll|you will)[^.]{0,40}\bnotified\b|notify you when|when (it|the render|it's|the take) is ready)\b/i;

// Observed live: an agent ran `write`, then reported "Shot 03 is queued for render… this
// render job will process unattended… you will be notified automatically." Nothing was
// queued. BRAVO has no job runner — a render happens only inside an approved card. The
// person then waits for something that will never arrive, which is the most damaging
// thing a model can get wrong.
export const noFabricatedCompletion = ({ prose, rendered }) => {
  if (rendered) return null;
  const hit = CLAIMS_WORK.exec(String(prose || ''));
  if (!hit) return null;
  return `Correction, from BRAVO rather than the agent: nothing was queued or rendered. There is no background render queue — a render only happens after you approve a card, and no card was approved in this turn. The claim above ("${hit[0]}") is wrong; ignore it.`;
};

export const DEFAULT_GUARDS = [noFabricatedCompletion];

export const runGuards = (guards, report) => guards
  .map((g) => { try { return g(report); } catch { return null; } })
  .filter(Boolean);

// ---- thrash ------------------------------------------------------------------------
// An agent repeating the SAME failing call is not making progress. Seen once observed:
// five identical still→error rounds in a single turn.

export const makeThrashGuard = (limit = 2) => {
  const seen = new Map();
  return (toolName, error) => {
    if (!error) return null;
    const key = `${toolName}:${error}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n < limit) return null;
    return `\`${toolName}\` failed the same way ${n} times: ${error}\n\nI have stopped rather than keep retrying. Tell me how you want to proceed.`;
  };
};
