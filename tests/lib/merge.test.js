// Concurrency: two agents working at once must not erase each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertShot, makeProject, setShotFields } from '../../state/project.js';
import { mergeChanges } from '../../state/merge.js';

const twoShots = () => {
  let p = makeProject();
  p = insertShot(p, { fields: { title: 'one' } }).project;
  p = insertShot(p, { fields: { title: 'two' } }).project;
  return p;
};

test('a run only commits the shot it actually touched', () => {
  const before = twoShots();
  const [a, b] = before.film.shots;

  // Agent A retitles shot 1, from `before`.
  const afterA = setShotFields(before, a.id, { title: 'A renamed me' });
  // Meanwhile agent B has already landed a change to shot 2.
  const live = setShotFields(before, b.id, { title: 'B renamed me' });

  const merged = mergeChanges(live, before, afterA);
  assert.equal(merged.film.shots[0].title, 'A renamed me', "A's change must land");
  assert.equal(merged.film.shots[1].title, 'B renamed me', "B's change must survive — this is the bug");
});

test('committing a whole snapshot is what loses work — the merge is why', () => {
  const before = twoShots();
  const [a, b] = before.film.shots;
  const afterA = setShotFields(before, a.id, { title: 'A' });
  const live = setShotFields(before, b.id, { title: 'B' });

  // The old shape: last writer wins.
  assert.equal(afterA.film.shots[1].title, 'two', 'the snapshot never saw B');
  // The new shape keeps both.
  assert.equal(mergeChanges(live, before, afterA).film.shots[1].title, 'B');
});

test('reordering is honoured without clobbering a concurrent edit', () => {
  const before = twoShots();
  const [a, b] = before.film.shots;
  const reordered = { ...before, film: { shots: [b, a] } };     // agent A moved shot 2 first
  const live = setShotFields(before, a.id, { title: 'edited by B' });

  const merged = mergeChanges(live, before, reordered);
  assert.deepEqual(merged.film.shots.map((s) => s.id), [b.id, a.id], "A's order stands");
  assert.equal(merged.film.shots[1].title, 'edited by B', "B's edit survives the reorder");
});

test('a shot created by another run is not deleted by an older one', () => {
  const before = twoShots();
  const afterA = { ...before, film: { shots: before.film.shots.slice(0, 1) } };  // A removed shot 2
  const live = insertShot(before, { fields: { title: 'made by B' } }).project;   // B added shot 3

  const merged = mergeChanges(live, before, afterA);
  const titles = merged.film.shots.map((s) => s.title);
  assert.ok(titles.includes('made by B'), "B's new shot must survive A's removal");
  assert.ok(!titles.includes('two'), "A's removal must still take effect");
});
