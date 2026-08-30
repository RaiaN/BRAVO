const CLAIMS_WORK = /\b(queued|queueing|in the queue|render job|unattended|in the background|processing will|will process|complete automatically|automatically when|(you|you'll|you will)[^.]{0,40}\bnotified\b|notify you when|when (it|the render|it's|the take) is ready)\b/i;

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
