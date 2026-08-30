import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertShot, makeProject, newId, setShotFields } from '../../state/project.js';
import { TOOLS } from '../../agents/tools/index.js';
import { createBrowserClient } from '../../utils/film/core/client.js';
import { applyDeployModels } from '../../utils/film/suiteConfig.js';

applyDeployModels({
  seedance25: 'test-seedance-25',
  seedance: 'test-seedance',
  seedream: 'test-seedream',
  seedreamPro: 'test-seedream-pro',
  reasoner: 'test-reasoner',
});

const seed = () => {
  let p = makeProject();
  const made = insertShot(p, {
    fields: {
      title: 'the standoff',
      model: 'seedance25',
      prompt: 'The wolf holds the log and will not yield.',
      ratio: '16:9',
      duration: 10,
      resolution: '720p',
    },
  });
  p = made.project;
  const take = { id: newId('take'), url: 'https://example.test/take.mp4', createdAt: new Date().toISOString(), promptUsed: 'x', model: 'seedance25', resolution: '720p' };
  p = setShotFields(p, made.shot.id, { takes: [take], chosenTakeId: take.id });
  return { project: p, shotId: made.shot.id, takeId: take.id };
};

const captureWireBody = async (tool, card, project) => {
  let body = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/seedance') && !u.includes('status')) {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'test-task' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('seedance-status')) {
      return new Response(JSON.stringify({ status: 'succeeded', video_url: 'https://example.test/out.mp4' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return real(url, init);
  };
  try {
    await tool.run({ card, project, ctx: { client: createBrowserClient() } });
  } finally {
    globalThis.fetch = real;
  }
  return body;
};

test('an edit task sends NO ratio and NO duration, but keeps resolution', async () => {
  const { project, shotId, takeId } = seed();
  const thread = { id: 't', kind: 'edit', subjectId: shotId, messages: [], budget: {} };
  const { card } = TOOLS.edit.prepare({ input: { shot: shotId, take: takeId }, project, thread });

  assert.equal(card.params.ratio, null, 'the card must show ratio as not sent');
  assert.equal(card.params.duration, null, 'the card must show duration as not sent');

  const body = await captureWireBody(TOOLS.edit, card, project);
  assert.ok(body, 'no request was made');
  assert.equal('ratio' in body, false, 'ratio would trigger InvalidParameter.TaskTypeConstraint');
  assert.equal('duration' in body, false, 'duration would trigger InvalidParameter.TaskTypeConstraint');
  assert.equal(body.resolution, '720p', 'resolution IS honoured by an editing task');
});

test('an edit attaches the source take and sends the prompt verbatim', async () => {
  const { project, shotId, takeId } = seed();
  const thread = { id: 't', kind: 'edit', subjectId: shotId, messages: [], budget: {} };
  const { card } = TOOLS.edit.prepare({ input: { shot: shotId, take: takeId }, project, thread });
  const body = await captureWireBody(TOOLS.edit, card, project);

  assert.equal(body.content[0].text, 'The wolf holds the log and will not yield.',
    'the prompt is the prompt — nothing may wrap or assemble it at send time');
  assert.ok(body.content.some((c) => c.role === 'reference_video'), 'the take being edited must ride along');
});

test('a SHOOT does send ratio and duration — the contract is edit-specific', async () => {
  const { project, shotId } = seed();
  const thread = { id: 't', kind: 'shot', subjectId: shotId, messages: [], budget: {} };
  const { card } = TOOLS.shoot.prepare({ input: { shot: shotId }, project, thread });
  const body = await captureWireBody(TOOLS.shoot, card, project);

  assert.equal(body.ratio, '16:9', 'a normal take keeps its ratio');
  assert.equal(body.duration, 10, 'a normal take keeps its duration');
});

test('edit refuses when the shot has no take to edit', () => {
  let p = makeProject();
  const made = insertShot(p, { fields: { title: 'x', model: 'seedance25', prompt: 'a prompt' } });
  const thread = { id: 't', kind: 'edit', subjectId: made.shot.id, messages: [], budget: {} };
  const out = TOOLS.edit.prepare({ input: { shot: made.shot.id }, project: made.project, thread });
  assert.match(out.error, /no take/i);
});
