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

export const mergeChanges = (prev, before, after) => {
  if (!before || !after) return prev;
  if (before === after) return prev;
  return {
    ...prev,
    film: { shots: remap(prev.film.shots, before.film.shots, after.film.shots) },
    bible: remap(prev.bible, before.bible, after.bible),
    updatedAt: after.updatedAt || prev.updatedAt,
  };
};
