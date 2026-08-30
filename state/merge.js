// MERGING CONCURRENT WORK.
//
// Two agents mutate the project at once, so committing a whole snapshot would let the
// later writer erase the earlier one. A tool touches one subject: take only what it
// changed and lay that onto the latest project.
//
// Reference inequality is the test — every mutator here is immutable, so an untouched
// shot is literally the same object.

const remap = (prevList, beforeList, afterList) => {
  const beforeById = new Map(beforeList.map((x) => [x.id, x]));
  const prevById = new Map(prevList.map((x) => [x.id, x]));
  const beforeIds = new Set(beforeList.map((x) => x.id));
  const afterIds = new Set(afterList.map((x) => x.id));

  // `after` decides the ORDER (the `order` tool's whole job), but for anything this run
  // did not touch, keep the newest version — another run may have edited it meanwhile.
  const kept = afterList.map((item) => {
    const before = beforeById.get(item.id);
    const untouched = before && before === item;
    return untouched ? (prevById.get(item.id) || item) : item;
  });

  // Something present now, absent from `after`, and absent from `before` too, was created
  // by a DIFFERENT run while this one was in flight. It is not this run's to delete.
  const createdElsewhere = prevList.filter((x) => !afterIds.has(x.id) && !beforeIds.has(x.id));

  return [...kept, ...createdElsewhere];
};

export const mergeChanges = (prev, before, after) => {
  if (!before || !after) return prev;
  if (before === after) return prev;                     // the run changed nothing
  return {
    ...prev,
    film: { shots: remap(prev.film.shots, before.film.shots, after.film.shots) },
    bible: remap(prev.bible, before.bible, after.bible),
    updatedAt: after.updatedAt || prev.updatedAt,
  };
};
