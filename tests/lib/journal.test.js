import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openJournal, journaledClient, FINDING_SCHEMA, validateFinding } from '../../agents/journal.js';
import { saveProjectFs, loadProjectFs } from '../../state/persist-fs.js';
import { makeProject, makeSequence, insertShot, touch } from '../../state/project.js';
import { scriptedClient } from './client.js';

const made = [];
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bravo-journal-'));
  made.push(dir);
  return dir;
};
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const finding = (over = {}) => ({
  finding_id: 'f_0001', runId: 'run_1', at: new Date().toISOString(),
  family: 'qc', stage: 'shoot', severity: 'blocker', code: 'QC-FROZEN',
  detail: 'the take holds still for 2.1s', evidence: ['media/shoot-s1-attempt1.mp4'],
  shotId: 's1', takeId: 'tk1', attempt: 1,
  ...over,
});

test('writes land in issue order with monotonic steps, one step file each, and resolve only after fsync', async () => {
  const dir = fresh();
  const probe = await fsp.open(path.join(dir, 'probe'), 'w');
  const FileHandle = Object.getPrototypeOf(probe);
  await probe.close();
  const origSync = FileHandle.sync;
  let syncs = 0;
  FileHandle.sync = function patched(...a) { syncs += 1; return origSync.apply(this, a); };
  try {
    const journal = await openJournal({ dir });
    const before = syncs;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => journal.write('node', { i })));
    assert.deepEqual(results.map((r) => r.step), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.ok(results.every((r) => !Number.isNaN(Date.parse(r.at))));
    assert.ok(syncs - before >= 40, `every write fsyncs the ndjson line and its step file (${syncs - before} syncs)`);
    const rows = lines(journal.paths.journal);
    assert.deepEqual(rows.map((r) => r.data.i), Array.from({ length: 20 }, (_, i) => i));
    assert.deepEqual(rows.map((r) => r.step), Array.from({ length: 20 }, (_, i) => i + 1));
    const steps = fs.readdirSync(journal.paths.steps).sort();
    assert.equal(steps.length, 20);
    assert.equal(steps[0], '0001-node.json');
    assert.equal(steps[19], '0020-node.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(journal.paths.steps, '0007-node.json'), 'utf8')), rows[6]);
    assert.ok(fs.existsSync(journal.paths.media));
    assert.equal(journal.entries().length, 20);
    assert.equal(journal.entries('node').length, 20);
    assert.equal(journal.entries('finding').length, 0);
    await journal.close();
    await assert.rejects(() => journal.write('node', { late: true }), /is closed/);
  } finally {
    FileHandle.sync = origSync;
  }
});

test('a write refuses a bad kind or non-object data, and a step is never written twice', async () => {
  const journal = await openJournal({ dir: fresh() });
  assert.throws(() => journal.write('', { a: 1 }), /must be a short token/);
  assert.throws(() => journal.write('9no', { a: 1 }), /must be a short token/);
  assert.throws(() => journal.write('node', 'text'), /needs an object/);
  assert.throws(() => journal.write('node', [1]), /needs an object/);
  await journal.write('render.start', { ok: true });
  assert.ok(fs.existsSync(path.join(journal.paths.steps, '0001-render-start.json')));
  await journal.close();
});

test('an intent gets an id, its result answers it, and a result without an intent throws by name', async () => {
  const journal = await openJournal({ dir: fresh() });
  const id = await journal.intent('startVideo', { content: [{ type: 'text', text: 'a moment' }], model: 'm' });
  assert.equal(id, 'int_0001');
  await assert.rejects(() => journal.result('int_9999', { taskId: 't' }), /no intent "int_9999" was journaled/);
  const res = await journal.result(id, { taskId: 'task1', ms: 12 });
  assert.equal(res.step, 2);
  await assert.rejects(() => journal.result(id, { taskId: 'again' }), /already has its result at step 2/);
  const [intent] = journal.entries('intent');
  const [result] = journal.entries('result');
  assert.deepEqual(intent.data, { intentId: 'int_0001', call: 'startVideo', content: [{ type: 'text', text: 'a moment' }], model: 'm' });
  assert.deepEqual(result.data, { intentId: 'int_0001', call: 'startVideo', taskId: 'task1', ms: 12 });
  assert.throws(() => journal.intent('reason', { intentId: 'mine' }), /may not carry/);
  await journal.close();
});

test('finding validates against the taxonomy: missing columns, wrong vocabulary and unknown columns refuse; a lawful row lands in the step and in errors.ndjson', async () => {
  const journal = await openJournal({ dir: fresh() });
  assert.deepEqual(Object.keys(FINDING_SCHEMA.required), ['finding_id', 'runId', 'at', 'family', 'stage', 'severity', 'code', 'detail', 'evidence']);
  for (const key of Object.keys(FINDING_SCHEMA.required)) {
    const row = finding();
    delete row[key];
    assert.ok(validateFinding(row).some((p) => p.startsWith(`${key} is required`)), `${key} missing must be named`);
    assert.throws(() => journal.finding(row), new RegExp(`${key} is required`));
  }
  assert.throws(() => journal.finding(finding({ family: 'oops' })), /family must be one of gate\|fault/);
  assert.throws(() => journal.finding(finding({ stage: 'render' })), /stage must be one of/);
  assert.throws(() => journal.finding(finding({ severity: 'high' })), /severity must be one of blocker\|note\|taste/);
  assert.throws(() => journal.finding(finding({ evidence: 'a string' })), /evidence must be an array/);
  assert.throws(() => journal.finding(finding({ attempt: 'one' })), /attempt must be an integer/);
  assert.throws(() => journal.finding(finding({ mood: 'grim' })), /mood is not a column/);
  assert.throws(() => journal.finding(finding({ class: 'vibe' })), /class must be one of plan\|measure\|judgment\|policy/);
  assert.equal(fs.readFileSync(journal.paths.errors, 'utf8'), '', 'nothing refused was appended');

  const one = await journal.finding(finding());
  const two = await journal.finding(finding({ finding_id: 'f_0002', family: 'fault', stage: 'measure', severity: 'note', code: 'E-NET', ruleId: 'CIN-004', class: 'measure', value: 25, threshold: 24 }));
  assert.deepEqual([one.step, two.step], [1, 2]);
  assert.equal(journal.entries('finding').length, 2);
  const rows = lines(journal.paths.errors);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].step, 1);
  assert.equal(rows[0].code, 'QC-FROZEN');
  assert.equal(rows[1].ruleId, 'CIN-004');
  assert.deepEqual(journal.entries('finding')[1].data.evidence, ['media/shoot-s1-attempt1.mp4']);
  await journal.close();
});

test('cost rows append to cost.ndjson and a wasted or refused row must carry its code', async () => {
  const journal = await openJournal({ dir: fresh() });
  assert.throws(() => journal.cost({ kind: 'take', units: 1, disposition: 'wasted' }), /wasted cost row must carry a code/);
  assert.throws(() => journal.cost({ kind: 'frame', units: 1, disposition: 'kept' }), /kind must be one of still\|take\|judge\|reason/);
  assert.throws(() => journal.cost({ kind: 'take', units: 'one', disposition: 'kept' }), /units must be a finite number/);
  assert.throws(() => journal.cost({ kind: 'take', units: 1, disposition: 'kept', flavor: 'x' }), /flavor is not a column/);
  assert.throws(() => journal.cost({ kind: 'judge', units: 1, disposition: 'kept', reservationId: 7 }), /reservationId must be a non-empty string/);
  await journal.cost({ kind: 'still', units: 1, disposition: 'kept', nodeId: 'plate:FIGURE-1', reservationId: 'res_1' });
  await journal.cost({ kind: 'take', units: 1, disposition: 'wasted', code: 'QC-FROZEN', shotId: 's1', attempt: 1 });
  await journal.cost({ kind: 'take', units: 1, disposition: 'refused', code: 'E-BUDGET-RENDERS', shotId: 's2' });
  await journal.cost({ kind: 'judge', units: 1, disposition: 'kept', nodeId: 'qc:s1', reservationId: 'res_4' });
  const rows = lines(journal.paths.cost);
  assert.deepEqual(rows.map((r) => r.disposition), ['kept', 'wasted', 'refused', 'kept']);
  assert.deepEqual(rows.map((r) => r.step), [1, 2, 3, 4]);
  assert.equal(rows[1].code, 'QC-FROZEN');
  assert.deepEqual(rows.map((r) => r.reservationId), ['res_1', undefined, undefined, 'res_4']);
  assert.equal(journal.entries('cost').length, 4);
  await journal.close();
});

test('media saves bytes into media/, journals the save, and never overwrites; a url is downloaded through fetch', async () => {
  const journal = await openJournal({ dir: fresh() });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const file = await journal.media('plate-FIGURE_1.png', bytes);
  assert.equal(file, path.join(journal.paths.media, 'plate-FIGURE_1.png'));
  assert.deepEqual(fs.readFileSync(file), bytes);
  const [saved] = journal.entries('media');
  assert.deepEqual(saved.data, { name: 'plate-FIGURE_1.png', path: file, bytes: 7, source: 'bytes' });
  await assert.rejects(() => journal.media('plate-FIGURE_1.png', bytes), /refuses to overwrite/);
  await assert.rejects(() => journal.media('../escape.png', bytes), /plain filename/);
  await assert.rejects(() => journal.media('notes.txt', bytes), /media extension/);
  await assert.rejects(() => journal.media('take.mp4', { url: 'x' }), /url string or bytes/);
  await assert.rejects(() => journal.media('take.mp4', 'ftp://x/take.mp4'), /http\(s\) or app-relative/);

  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (String(url).endsWith('missing.mp4')) return new Response('gone', { status: 404 });
    return new Response(new Uint8Array([7, 7, 7, 7]), { status: 200 });
  };
  try {
    const take = await journal.media('shoot-s1-attempt1.mp4', 'https://x.test/task1.mp4');
    assert.deepEqual([...fs.readFileSync(take)], [7, 7, 7, 7]);
    assert.equal(journal.entries('media')[1].data.source, 'https://x.test/task1.mp4');
    await assert.rejects(() => journal.media('shoot-s1-attempt2.mp4', 'https://x.test/missing.mp4'), /responded 404 — the media was NOT saved/);
    assert.ok(!fs.existsSync(path.join(journal.paths.media, 'shoot-s1-attempt2.mp4')));
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(asked, ['https://x.test/task1.mp4', 'https://x.test/missing.mp4']);
  assert.equal(journal.entries('media').length, 2);
  await journal.close();
});

test('journaledClient brackets every call with an intent carrying the full prompts and a result carrying the full answer', async () => {
  const journal = await openJournal({ dir: fresh() });
  const scripted = scriptedClient(['{"logline":"a figure crosses"}']);
  const raw = {
    ...scripted,
    reason: (args) => scripted.reason(args),
    async generateImage(args) { return { url: 'https://x.test/raw.jpg', cacheUrl: '/api/film/media?key=p.jpg', assetId: 'asset-1', prompt: args.prompt }; },
    async startVideo() { return { taskId: 'task1' }; },
    async pollVideo({ taskId }) {
      if (taskId === 'task-broken') throw new Error('the wire dropped');
      return { videoUrl: `https://x.test/${taskId}.mp4`, videoCacheUrl: `/api/film/media?key=${taskId}.mp4`, lastFrameUrl: null, lastFrameCacheUrl: null };
    },
  };
  const client = journaledClient(journal, raw);

  const out = await client.reason({ prompt: 'Derive the brief.', systemPrompt: 'You are the studio.', images: ['data:1', 'data:2'], video: 'https://x.test/v.mp4', modelId: 'test-r', reasoningEffort: 'high' });
  assert.equal(out.content, '{"logline":"a figure crosses"}');
  assert.equal(scripted.calls.length, 1);
  await client.generateImage({ prompt: 'A neutral plate.', model: 'test-srp', size: '2K', seed: 7, referenceImages: ['/api/film/media?key=ref.jpg'] });
  await client.startVideo({ content: [{ type: 'text', text: 'The first moment holds.' }, { type: 'image_url', role: 'first_frame', image_url: { url: '/k.jpg' } }], model: 'test-sd25', resolution: '720p', ratio: 'adaptive', duration: 6, generateAudio: false, seed: 7 });
  await client.pollVideo({ taskId: 'task1' });
  await assert.rejects(() => client.pollVideo({ taskId: 'task-broken' }), /the wire dropped/);

  const kinds = journal.entries().map((r) => `${r.kind}:${r.data.call}`);
  assert.deepEqual(kinds, [
    'intent:reason', 'result:reason',
    'intent:generateImage', 'result:generateImage',
    'intent:startVideo', 'result:startVideo',
    'intent:pollVideo', 'result:pollVideo',
    'intent:pollVideo', 'result:pollVideo',
  ]);
  const [reasonIntent, reasonResult, imageIntent, imageResult, videoIntent, videoResult, pollIntent, pollResult, brokenIntent, brokenResult] = journal.entries().map((r) => r.data);
  assert.deepEqual(reasonIntent, { intentId: 'int_0001', call: 'reason', prompt: 'Derive the brief.', systemPrompt: 'You are the studio.', images: 2, video: 'https://x.test/v.mp4', modelId: 'test-r', reasoningEffort: 'high' });
  assert.equal(reasonResult.content, '{"logline":"a figure crosses"}');
  assert.equal(typeof reasonResult.ms, 'number');
  assert.deepEqual(imageIntent.referenceImages, ['/api/film/media?key=ref.jpg']);
  assert.equal(imageIntent.prompt, 'A neutral plate.');
  assert.equal(imageResult.assetId, 'asset-1');
  assert.equal(videoIntent.content[1].image_url.url, '/k.jpg');
  assert.equal(videoIntent.duration, 6);
  assert.equal(videoResult.taskId, 'task1');
  assert.equal(pollIntent.taskId, 'task1');
  assert.equal(pollResult.videoCacheUrl, '/api/film/media?key=task1.mp4');
  assert.equal(brokenIntent.intentId, brokenResult.intentId);
  assert.deepEqual(brokenResult.error, { name: 'Error', message: 'the wire dropped' });
  assert.equal(client.calls, scripted.calls, 'the client keeps what it had');
  assert.throws(() => journaledClient(journal, null), /needs a client/);
  assert.throws(() => journaledClient({}, raw), /needs an open journal/);
  await journal.close();
});

test('reopening a journal continues the counter, remembers open intents, and refuses a torn line', async () => {
  const dir = fresh();
  const first = await openJournal({ dir });
  await first.write('intake', { seconds: 12 });
  const id = await first.intent('startVideo', { model: 'm', content: [] });
  await first.close();

  const again = await openJournal({ dir });
  assert.equal(again.entries().length, 2);
  const res = await again.result(id, { taskId: 'task1' });
  assert.equal(res.step, 3);
  const w = await again.write('node', { id: 'shoot:s1' });
  assert.equal(w.step, 4);
  assert.equal(lines(again.paths.journal).length, 4);
  assert.equal(fs.readdirSync(again.paths.steps).length, 4);
  await again.close();

  const third = await openJournal({ dir });
  await assert.rejects(() => third.result(id, { taskId: 'twice' }), /already has its result at step 3/);
  await third.close();

  fs.appendFileSync(path.join(dir, 'journal.ndjson'), '{"step":5,"kind":"no');
  await assert.rejects(() => openJournal({ dir }), /unreadable line 5.*NOT been touched/s);
});

test('a project round-trips through project.json under the strict hydrate; a broken record and a missing file refuse by name', async () => {
  const dir = fresh();
  let p = makeProject('the film');
  p = insertShot(p, { fields: { title: 'the shoreline', prompt: 'a prompt' } }).project;
  p = touch({ ...p, sequences: [makeSequence({ brief: { logline: 'x' }, status: 'planned' })] });
  const file = await saveProjectFs(dir, p);
  assert.equal(file, path.join(dir, 'project.json'));
  assert.deepEqual(fs.readdirSync(dir), ['project.json'], 'no tmp file survives the rename');
  const loaded = await loadProjectFs(dir);
  assert.equal(loaded.id, p.id);
  assert.equal(loaded.title, 'the film');
  assert.equal(loaded.film.shots[0].title, 'the shoreline');
  assert.deepEqual(loaded.film.shots[0].stills, []);
  assert.equal(loaded.sequences[0].status, 'planned');
  assert.deepEqual(loaded.sequences[0].iterations, []);
  assert.equal(loaded.threads[0].budget.takesCap, 999);

  const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
  await saveProjectFs(dir, { ...p, title: 'renamed' });
  assert.equal((await loadProjectFs(dir)).title, 'renamed');
  assert.equal(stale.title, 'the film');

  const broken = JSON.parse(JSON.stringify(p));
  delete broken.film;
  await assert.rejects(() => saveProjectFs(dir, broken), /has no film.*NOT been overwritten/s);
  assert.equal((await loadProjectFs(dir)).title, 'renamed', 'a refused save leaves the file alone');
  fs.writeFileSync(file, '{"id":"x",');
  await assert.rejects(() => loadProjectFs(dir), /could not be read.*NOT been overwritten/s);
  await assert.rejects(() => loadProjectFs(fresh()), /No project at ".*project\.json" \(ENOENT\)/);
});
