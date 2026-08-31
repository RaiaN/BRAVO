const remap = (prevList, beforeList, afterList) => {
  const beforeById = new Map(beforeList.map((x) => [x.id, x]));
  const prevById = new Map(prevList.map((x) => [x.id, x]));
  const beforeIds = new Set(beforeList.map((x) => x.id));
  const afterIds = new Set(afterList.map((x) => x.id));

  const kept = afterList.map((item) => {
    const before = beforeById.get(item.id);
    const untouched = before && before === item;
    return untouched ? (prevById.get(item.id) || item) : item;
  });

  const createdElsewhere = prevList.filter((x) => !afterIds.has(x.id) && !beforeIds.has(x.id));

  return [...kept, ...createdElsewhere];
};

const mergeSequences = (prevList, beforeList, afterList) => {
  const merged = remap(prevList, beforeList, afterList);
  const prevById = new Map(prevList.map((q) => [q.id, q]));
  const beforeById = new Map(beforeList.map((q) => [q.id, q]));
  for (const q of merged) {
    const prevQ = prevById.get(q.id);
    const beforeQ = beforeById.get(q.id);
    if (!prevQ || !beforeQ || beforeQ === q) continue;
    const prevIts = prevQ.iterations || [];
    const nextIts = q.iterations || [];
    if (prevIts.length > nextIts.length) {
      throw new Error(`merge refused: sequence ${q.id} would lose iteration records (${prevIts.length} -> ${nextIts.length}) — iterations are append-only`);
    }
    for (let i = 0; i < prevIts.length; i += 1) {
      if (nextIts[i]?.id !== prevIts[i].id) {
        throw new Error(`merge refused: sequence ${q.id} rewrites iteration ${i} — records are append-only`);
      }
    }
  }
  return merged;
};

export const mergeChanges = (prev, before, after) => {
  if (!before || !after) return prev;
  if (before === after) return prev;
  return {
    ...prev,
    film: { shots: remap(prev.film.shots, before.film.shots, after.film.shots) },
    bible: remap(prev.bible, before.bible, after.bible),
    sequences: mergeSequences(prev.sequences || [], before.sequences || [], after.sequences || []),
    updatedAt: after.updatedAt || prev.updatedAt,
  };
};
