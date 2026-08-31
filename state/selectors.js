export const STALE_RUN_MS = 90000;

export const staleRunning = (seq) => seq?.status === 'executing' && Object.values(seq.run?.nodes || {}).some((n) => {
  if (n.status !== 'running') return false;
  const beat = n.lastCheckAt || n.startedAt;
  return beat && Date.now() - new Date(beat).getTime() > STALE_RUN_MS;
});

export const runResumable = (seq) => !!seq?.run
  && ((seq.status === 'halted' && !seq.run.halted?.ruleId) || staleRunning(seq));

export const elapsedLabel = (iso) => {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
};
