import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadProject, makeProject, saveProject } from '../../state/project.js';
import { reconcileInterrupted } from '../../agents/resume.js';

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};

const put = (project) => {
  store.clear();
  store.set('bravo:projects', JSON.stringify([project.id]));
  store.set('bravo:open', JSON.stringify(project.id));
  store.set(`bravo:project:${project.id}`, JSON.stringify(project));
};

test('an old record gains new fields without losing what it had', () => {
  const p = makeProject('the film');
  const old = JSON.parse(JSON.stringify(p));
  delete old.activity;
  old.film.shots = [{ id: 'shot_1', title: 'the shoreline', prompt: 'a prompt', takes: [] }];
  old.threads[0].kind = 'shot';
  old.threads[0].subjectId = 'shot_1';
  delete old.threads[0].draft;
  delete old.threads[0].budget;
  put(old);
  const loaded = loadProject();
  assert.equal(loaded.film.shots[0].title, 'the shoreline');
  assert.equal(loaded.film.shots[0].prompt, 'a prompt');
  assert.deepEqual(loaded.film.shots[0].stills, []);
  assert.deepEqual(loaded.activity, []);
  assert.equal(loaded.threads[0].draft, '');
  assert.equal(loaded.threads[0].budget.takesCap, 4);
});

test('a record with no id is broken, not a new film', () => {
  const p = makeProject();
  const broken = JSON.parse(JSON.stringify(p));
  delete broken.id;
  store.clear();
  store.set('bravo:projects', JSON.stringify(['x']));
  store.set('bravo:open', JSON.stringify('x'));
  store.set('bravo:project:x', JSON.stringify(broken));
  assert.throws(() => loadProject(), /has no id.*NOT been overwritten/s);
});

test('a record with no film or no threads is broken, never repaired in place', () => {
  const p = makeProject();
  for (const wreck of [(o) => { delete o.film; }, (o) => { o.threads = 'nope'; }]) {
    const broken = JSON.parse(JSON.stringify(p));
    wreck(broken);
    put({ ...broken, id: p.id });
    assert.throws(() => loadProject(), /NOT been overwritten/);
  }
});

test('an unknown thread kind is preserved, not silently unlatched', () => {
  const p = makeProject();
  const odd = JSON.parse(JSON.stringify(p));
  odd.threads[0].kind = 'ghost';
  put(odd);
  assert.equal(loadProject().threads[0].kind, 'ghost');
});

test('reconcile flips only stuck threads, and only outside the loader', () => {
  let p = makeProject();
  p = { ...p, threads: p.threads.map((t) => ({ ...t, status: 'working' })) };
  put(p);
  const loaded = loadProject();
  assert.equal(loaded.threads[0].status, 'working', 'the loader must not editorialise');
  const fixed = reconcileInterrupted(loaded);
  assert.equal(fixed.threads[0].status, 'needs-you');
  assert.match(fixed.threads[0].messages.at(-1).text, /interrupted/);
  const live = { ...loaded, activity: [{ id: 'a', threadId: loaded.threads[0].id, state: 'running' }] };
  assert.equal(reconcileInterrupted(live).threads[0].status, 'working', 'a live render is not an interruption');
});
