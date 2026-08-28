// Dependency-wave scheduling — pure, no imports. Steps that don't depend on each
// other (every blueprint keyframe; every animate once its keyframe exists) run
// together, bounded by a small concurrency cap so parallelism doesn't trigger the
// very server-overload errors the retry layer exists to absorb.

const TERMINAL = new Set(['approved', 'skipped', 'failed']);

export const isTerminalStatus = (status) => TERMINAL.has(status);

// Steps runnable NOW: not yet terminal/running, with every dependency settled.
// A failed dependency still releases its dependents (matching the old sequential
// behavior — the dependent then skips itself for lack of input, rather than
// deadlocking the run). 'review' steps are included so a resumed auto-run can
// approve them without regenerating.
export const readySteps = (steps = []) => {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return steps.filter((s) => {
    if (s.status !== 'pending' && s.status !== 'review') return false;
    return (s.dependsOn || []).every((depId) => {
      const dep = byId.get(depId);
      return !dep || TERMINAL.has(dep.status);
    });
  });
};

/**
 * Run async task fns through a worker pool of `cap` — order of start preserved,
 * never more than `cap` in flight. Tasks are expected to handle their own errors
 * (the engine marks a step failed rather than throwing), so the pool itself
 * doesn't abort siblings on rejection.
 */
export const runWithConcurrency = async (tasks = [], cap = 3) => {
  const queue = [...tasks];
  const width = Math.max(1, Math.min(cap, queue.length));
  const worker = async () => {
    while (queue.length) {
      const task = queue.shift();
      await task(); // eslint-disable-line no-await-in-loop
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
};
