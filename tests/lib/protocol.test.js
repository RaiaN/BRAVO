// Layer 1: the gates, as pure functions. No model, no network, no money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateCall, parseBlocks, parseReply, retryPrompt } from '../../agents/protocol.js';
import { TOOLS, resolveShot } from '../../agents/tools/index.js';
import { gates } from './gates.js';
import { insertShot, makeProject } from '../../state/project.js';

const block = (o) => '```bravo\n' + JSON.stringify(o) + '\n```';

test('parses prose and calls apart', () => {
  const r = parseReply(`Retitling it.\n\n${block({ tool: 'write', input: { shot: 3, title: 'x' } })}`);
  assert.equal(r.prose, 'Retitling it.');
  assert.deepEqual(r.calls, [{ tool: 'write', input: { shot: 3, title: 'x' } }]);
  assert.equal(r.errors.length, 0);
});

test('several calls keep their order', () => {
  const r = parseReply(block({ tool: 'read' }) + '\n' + block({ tool: 'write', input: { title: 'x' } }));
  assert.deepEqual(r.calls.map((c) => c.tool), ['read', 'write']);
});

test('malformed blocks are reported, never guessed at', () => {
  const r = parseReply('```bravo\n{ nope }\n```');
  assert.equal(r.calls.length, 0);
  assert.match(r.errors[0].error, /not valid JSON/);
  assert.match(retryPrompt(r.errors), /not valid JSON/);   // the fault is quoted back
});

test('a block that is not an object is rejected', () => {
  assert.equal(parseReply('```bravo\n[1,2]\n```').errors.length, 1);
  assert.equal(parseReply('```bravo\n"write"\n```').errors.length, 1);
  assert.equal(parseReply('```bravo\n{"input":{}}\n```').errors[0].error, 'the object needs a "tool" name');
});

test('a tool outside the agent row is refused, not run', () => {
  const g = gateCall({ tool: 'shoot', input: {} }, ['read', 'write'], TOOLS);
  assert.equal(g.ok, false);
  assert.match(g.reason, /not a tool this agent holds/);
});

test('write cannot set the prompt — that is compose, under the skill (§7)', () => {
  const g = gateCall({ tool: 'write', input: { prompt: 'a wolf' } }, ['write'], TOOLS);
  assert.equal(g.ok, false);
  assert.match(g.reason, /compose/);
});

test('an unknown shot reference resolves to NOTHING (§8)', () => {
  let p = makeProject();
  p = insertShot(p, { fields: { title: 'the ridge' } }).project;
  assert.equal(resolveShot(p, 9, null), null);
  assert.equal(resolveShot(p, 'shot_nope', null), null);
  assert.equal(resolveShot(p, 1, null).title, 'the ridge');
});

test('citations outside the ref count are caught', () => {
  assert.equal(gates.citationsInRange('@Image1 is the wolf', 2), null);
  assert.match(gates.citationsInRange('@Image7 is the wolf', 2), /cites image 7/);
});

test('duration, ratio and resolution must never reach prompt text (§8)', () => {
  // The state a world model should be given — no parameters anywhere in it.
  assert.equal(gates.noParametersInPromptText('the wolf is cornered and means it'), null);
  assert.equal(gates.noParametersInPromptText('the log is wet and the dog has left the ground'), null);
  // Every shape of leak. Singular "second" is the one people actually write.
  for (const leak of ['a 6 second shot', '6 seconds', '10 sec', '5s', 'shot in 1080p', 'framed 16:9', '9:16 vertical', 'in 4K']) {
    assert.match(gates.noParametersInPromptText(leak), /leaked/, `should have caught: ${leak}`);
  }
});

// REGRESSION: the router's block is {kind}/{ask}, not a tool call. Reading it with the
// tool-call rules discarded every valid answer as "missing a tool name", so every route
// fell through to "ask". The two shapes must stay parseable apart.
test('a non-tool block is readable by the block parser', () => {
  const { blocks, errors } = parseBlocks('```bravo\n{"kind":"shot","title":"the collision"}\n```');
  assert.equal(errors.length, 0);
  assert.deepEqual(blocks[0], { kind: 'shot', title: 'the collision' });
  // ...and is still, correctly, not a tool call.
  assert.equal(parseReply('```bravo\n{"kind":"shot"}\n```').calls.length, 0);
});

// REGRESSION: the router returned the person's entire first sentence as the title, which
// then truncated mid-word in every rail row. The prompt asks for five words; this is what
// makes it true.
test('a thread title is capped at five words (§8 gate)', async () => {
  const { shortTitle } = await import('../../agents/router.js');
  assert.equal(shortTitle('the collision'), 'the collision');
  assert.equal(shortTitle('shot 3 is the collision where the wolf lands on the log'), 'shot 3 is the collision');
  assert.equal(shortTitle('  "The Collision."  '), 'the collision');
  assert.equal(shortTitle(''), '');
  assert.equal(shortTitle(null), '');
  assert.ok(shortTitle('supercalifragilistic expialidocious extraordinarily verbose naming').length <= 42);
});

// REGRESSION: an agent ran `write` and then reported "Shot 03 is queued for render… this
// render job will process unattended… you will be notified automatically." Nothing was
// queued — BRAVO has no job runner. The person then waits for something that will never
// arrive, which is the most damaging thing a model can get wrong.
//
// The first version of this gate also flagged an HONEST sentence describing what a card
// would do once approved. A gate that cries wolf gets ignored, so both directions matter.
test('fabricated completion is caught, and honest reports are not', async () => {
  const { fabricatedCompletion } = await import('../../agents/loop.js');

  for (const lie of [
    'Shot 03 is now queued for render. This render job will process unattended.',
    'Processing will complete automatically. You will be notified when ready.',
    'It is rendering in the background now.',
  ]) {
    assert.ok(fabricatedCompletion(lie, false), `should have caught: ${lie}`);
  }

  for (const honest of [
    'The render card is now presented for your approval. This will render one complete take using seedance25.',
    'I retitled shot 03 and set its duration.',
    'I cannot render yet — this shot has no prompt.',
  ]) {
    assert.equal(fabricatedCompletion(honest, false), null, `false positive on: ${honest}`);
  }

  // When a render genuinely happened this turn, the same words are simply true.
  assert.equal(fabricatedCompletion('Shot 03 is now queued for render.', true), null);
});
