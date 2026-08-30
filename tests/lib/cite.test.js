import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertShot, makeProject, makeBibleEntry, markCitationsStale, newId, touch } from '../../state/project.js';
import { TOOLS } from '../../agents/tools/index.js';

const seed = () => {
  let p = makeProject();
  const entry = makeBibleEntry({ name: 'the keeper', role: 'character', plateUrl: '/api/film/media?key=abc.jpg', assetId: null });
  const bare = makeBibleEntry({ name: 'the tower', role: 'location' });
  p = touch({ ...p, bible: [entry, bare] });
  const made = insertShot(p, { fields: { title: 'the railing', model: 'seedance25' } });
  return { p: made.project, shot: made.shot, entry, bare };
};

test('cite attaches a plate as the next ordered reference', () => {
  const { p, shot, entry } = seed();
  const r = TOOLS.cite.run({ input: { shot: shot.id, entry: 'The Keeper' }, project: p, thread: null });
  const refs = r.project.film.shots[0].refs;
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, entry.plateUrl);
  assert.equal(refs[0].bibleEntryId, entry.id);
  assert.equal(r.output.shot.refs[0].n, 1);
});

test('cite refuses the unknown, the plateless, and the duplicate', () => {
  const { p, shot } = seed();
  assert.match(TOOLS.cite.run({ input: { shot: shot.id, entry: 'nobody' }, project: p, thread: null }).output.error, /matches/);
  assert.match(TOOLS.cite.run({ input: { shot: shot.id, entry: 'the tower' }, project: p, thread: null }).output.error, /no plate yet/);
  const once = TOOLS.cite.run({ input: { shot: shot.id, entry: 'the keeper' }, project: p, thread: null }).project;
  assert.match(TOOLS.cite.run({ input: { shot: shot.id, entry: 'the keeper' }, project: once, thread: null }).output.error, /already reference 1/);
});

test('cite remove detaches by position and renumbers', () => {
  const { p, shot } = seed();
  const once = TOOLS.cite.run({ input: { shot: shot.id, entry: 'the keeper' }, project: p, thread: null }).project;
  const r = TOOLS.cite.run({ input: { shot: shot.id, remove: 1 }, project: once, thread: null });
  assert.equal(r.project.film.shots[0].refs.length, 0);
  assert.match(TOOLS.cite.run({ input: { shot: shot.id, remove: 5 }, project: once, thread: null }).output.error, /matches none/);
});

test('a re-rendered plate marks only shots with a chosen take citing it', () => {
  const { p, shot, entry } = seed();
  let cited = TOOLS.cite.run({ input: { shot: shot.id, entry: 'the keeper' }, project: p, thread: null }).project;
  assert.equal(markCitationsStale(cited, entry.id).film.shots[0].stale, false);
  cited = {
    ...cited,
    film: { shots: cited.film.shots.map((s) => ({ ...s, chosenTakeId: newId('take') })) },
  };
  assert.equal(markCitationsStale(cited, entry.id).film.shots[0].stale, true);
});

test('a cited shot puts the plate on the shoot card', () => {
  const { p, shot } = seed();
  let cited = TOOLS.cite.run({ input: { shot: shot.id, entry: 'the keeper' }, project: p, thread: null }).project;
  cited = { ...cited, film: { shots: cited.film.shots.map((s) => ({ ...s, prompt: 'The keeper waits at the railing.' })) } };
  const { card } = TOOLS.shoot.prepare({ input: { shot: shot.id }, project: cited, thread: null });
  assert.equal(card.refs.length, 1);
  assert.equal(card.refs[0].url, '/api/film/media?key=abc.jpg');
  assert.equal(card.refPrefix, '@');
});

test('attach takes only images uploaded in this thread, once each', () => {
  const p0 = makeProject();
  const entry = makeBibleEntry({ name: 'the keeper', role: 'character' });
  const p1 = touch({ ...p0, bible: [entry] });
  const thread = {
    id: 't', kind: 'bible', subjectId: entry.id,
    messages: [{ id: 'm1', role: 'user', text: '', asset: { url: '/api/film/media?key=up.jpg', name: 'up.jpg', assetId: 'asset-9' } }],
  };
  assert.match(TOOLS.attach.run({ input: { url: '/api/film/media?key=other.jpg' }, project: p1, thread }).output.error, /was not uploaded/);
  const once = TOOLS.attach.run({ input: { url: '/api/film/media?key=up.jpg' }, project: p1, thread });
  assert.equal(once.project.bible[0].refs[0].assetId, 'asset-9');
  assert.match(TOOLS.attach.run({ input: { url: '/api/film/media?key=up.jpg' }, project: once.project, thread }).output.error, /already reference 1/);
  const removed = TOOLS.attach.run({ input: { remove: 1 }, project: once.project, thread });
  assert.equal(removed.project.bible[0].refs.length, 0);
});

test('an attached reference reaches the plate render card', () => {
  const p0 = makeProject();
  const entry = makeBibleEntry({ name: 'the keeper', role: 'character', prompt: 'A weathered keeper, square to camera.', model: 'seedream', refs: [{ id: 'r1', kind: 'image', url: '/api/film/media?key=up.jpg', assetId: null, label: 'up.jpg', role: 'frame', bibleEntryId: null }] });
  const p1 = touch({ ...p0, bible: [entry] });
  const thread = { id: 't', kind: 'bible', subjectId: entry.id, messages: [] };
  const { card } = TOOLS.still.prepare({ input: {}, project: p1, thread });
  assert.equal(card.refs.length, 1);
  assert.equal(card.refs[0].url, '/api/film/media?key=up.jpg');
});
