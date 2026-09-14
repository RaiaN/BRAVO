import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ideate } from '../../agents/director/ideate.js';

const style = (over = {}) => ({
  id: 'house-test',
  look: { style: 'grainy 16mm', grade: 'cold teal shadows' },
  constraints: ['no on-screen text', 'daylight only'],
  audio: true,
  format: { resolution: '720p', ratio: 'adaptive' },
  world: 'a coastal town after the fishing fleet left',
  references: [],
  doctrine: ['the opposition is visible in the frame before it is named', 'every shot changes one thing'],
  precedentTags: [],
  seed: null,
  ...over,
});

const policy = (max = null) => ({ plates: { max } });

const proposal = (over = {}) => ({
  logline: { value: 'A figure races the tide to reach a locked door.', reason: 'the idea names a race against a rising force' },
  world: { value: 'a coastal town after the fishing fleet left', reason: 'the style declares the world' },
  cast: [
    { name: 'FIGURE-1', role: 'character', reason: 'the idea centres on one person' },
    { name: 'KEEPER-1', role: 'the keeper of the door', reason: 'the door needs someone who locks it' },
  ],
  locations: [{ name: 'THE-QUAY', reason: 'the tide needs a shore' }],
  dramatis: { protagonist: 'FIGURE-1', want: 'reach the door before the tide', opposition: 'the tide rising across the quay', reason: 'the want and the opposition both come from the idea' },
  ...over,
});

const stub = (responses) => {
  const calls = [];
  const client = {
    async reason(args) {
      calls.push(args);
      if (!responses.length) throw new Error('stub: no response scripted for this call');
      return { content: responses.shift() };
    },
  };
  const entries = [];
  const journal = {
    async write(kind, data) {
      entries.push({ kind, data });
      return { step: entries.length, at: new Date().toISOString() };
    },
  };
  return { client, journal, calls, entries };
};

test('a clean derivation produces the brief tool input: names fixed, every plate new, constraints from style, no beats', async () => {
  const wire = stub([JSON.stringify(proposal())]);
  const out = await ideate({ idea: 'someone races the tide', style: style(), seconds: 120, policy: policy(), client: wire.client, journal: wire.journal });

  assert.equal(wire.calls.length, 1, 'one reason() call');
  assert.equal(out.calls, 1);
  assert.deepEqual(out.brief, {
    logline: 'A figure races the tide to reach a locked door.',
    targetSeconds: 120,
    world: 'a coastal town after the fishing fleet left',
    cast: [{ name: 'FIGURE-1', role: 'character', bibleEntryId: 'new' }, { name: 'KEEPER-1', role: 'the keeper of the door', bibleEntryId: 'new' }],
    locations: [{ name: 'THE-QUAY', bibleEntryId: 'new' }],
    dramatis: { protagonist: 'FIGURE-1', want: 'reach the door before the tide', opposition: 'the tide rising across the quay' },
    constraints: ['no on-screen text', 'daylight only'],
    format: { resolution: '720p', ratio: 'adaptive', audio: true },
  });
  assert.equal('beats' in out.brief, false, 'beats are left to the screenplay');
  assert.equal('fps' in out.brief.format, false, 'fps is the rulebook\'s, never ideation\'s');
  assert.match(out.provenance.format.reason, /carried verbatim from style house-test format and audio/);
  assert.deepEqual((await ideate({ idea: 'someone races the tide', style: style({ audio: false, format: { resolution: '1080p', ratio: '16:9' } }), seconds: 120, policy: policy(), client: stub([JSON.stringify(proposal())]).client, journal: wire.journal })).brief.format, { resolution: '1080p', ratio: '16:9', audio: false }, 'the format is the style\'s declaration, not a constant');
  assert.equal(wire.calls[0].prompt, 'THE IDEA:\nsomeone races the tide');
});

test('the provenance object marks every brief field derived, from ideate, with a reason', async () => {
  const wire = stub([JSON.stringify(proposal())]);
  const out = await ideate({ idea: 'someone races the tide', style: style(), seconds: 120, policy: policy(), client: wire.client, journal: wire.journal });

  assert.deepEqual(Object.keys(out.provenance).sort(), Object.keys(out.brief).sort(), 'one provenance entry per brief field, no more, no less');
  for (const [field, mark] of Object.entries(out.provenance)) {
    assert.equal(mark.derived, true, `${field} is marked derived`);
    assert.equal(mark.from, 'ideate', `${field} names its source`);
    assert.ok(typeof mark.reason === 'string' && mark.reason.trim(), `${field} carries a reason`);
    assert.deepEqual(mark.value, out.brief[field], `${field} provenance value mirrors the brief`);
  }
  assert.match(out.provenance.logline.reason, /race against a rising force/);
  assert.match(out.provenance.dramatis.reason, /come from the idea/);
  assert.deepEqual(out.provenance.cast.items.map((c) => c.name), ['FIGURE-1', 'KEEPER-1']);
  assert.match(out.provenance.cast.reason, /KEEPER-1: the door needs someone who locks it/);
  assert.match(out.provenance.locations.reason, /THE-QUAY: the tide needs a shore/);
  assert.match(out.provenance.targetSeconds.reason, /seconds argument/);
  assert.match(out.provenance.constraints.reason, /style house-test/);
});

test('cast + locations over policy.plates.max is quoted back once, then refused with the numbers — never trimmed', async () => {
  const same = JSON.stringify(proposal());
  const wire = stub([same, same]);
  await assert.rejects(
    () => ideate({ idea: 'someone races the tide', style: style(), seconds: 120, policy: policy(2), client: wire.client, journal: wire.journal }),
    (e) => {
      assert.match(e.message, /^E-IDEATE-PLATES-CAP/);
      assert.match(e.message, /2 cast \+ 1 locations = 3 plates, over policy\.plates\.max 2/);
      return true;
    },
  );
  assert.equal(wire.calls.length, 2, 'the cap fault gets its second attempt');
  assert.match(wire.calls[1].prompt, /YOUR LAST ATTEMPT WAS REJECTED:\n2 cast \+ 1 locations = 3 plates/);
  assert.match(wire.calls[0].systemPrompt, /caps cast \+ locations at 2 in total/);
  const refused = wire.entries.find((e) => e.kind === 'ideate.refused');
  assert.deepEqual(refused.data.capped, { cast: 2, locations: 1, plates: 3, cap: 2 });
  assert.equal(wire.entries.some((e) => e.kind === 'ideate.result'), false, 'nothing is returned as a brief');
});

test('a null cap is a declared absence of ceiling: the prompt says so and nothing is refused', async () => {
  const many = proposal({ cast: Array.from({ length: 6 }, (_, i) => ({ name: `FIGURE-${i + 1}`, role: 'character', reason: `member ${i + 1} of the crowd the idea names` })) });
  const wire = stub([JSON.stringify(many)]);
  const out = await ideate({ idea: 'a crowd races the tide', style: style(), seconds: 120, policy: policy(null), client: wire.client, journal: wire.journal });
  assert.equal(out.brief.cast.length, 6);
  assert.match(wire.calls[0].systemPrompt, /declares no ceiling on their count/);
});

test('invalid JSON is retried once with the fault quoted back, then refused by name', async () => {
  const wire = stub(['here is the brief: { not json', '```json\n[1, 2]\n```']);
  await assert.rejects(
    () => ideate({ idea: 'someone races the tide', style: style(), seconds: 120, policy: policy(), client: wire.client, journal: wire.journal }),
    /^Error: E-IDEATE-FAULT: ideation refused after 2 attempts: not a JSON object/,
  );
  assert.equal(wire.calls.length, 2);
  assert.match(wire.calls[1].prompt, /YOUR LAST ATTEMPT WAS REJECTED:\nnot valid JSON \(/);
  assert.match(wire.calls[1].prompt, /Return the corrected JSON only\./);
  const attempts = wire.entries.filter((e) => e.kind === 'ideate.attempt');
  assert.equal(attempts.length, 2);
  assert.match(attempts[0].data.fault, /not valid JSON/);
  assert.equal(attempts[1].data.fault, 'not a JSON object');
  assert.equal(wire.entries.at(-1).kind, 'ideate.refused');
});

test('a fault on the first attempt and a clean second attempt succeeds with two calls journaled', async () => {
  const first = JSON.stringify(proposal({ dramatis: { protagonist: 'NOBODY', want: 'x', opposition: 'y', reason: 'z' } }));
  const wire = stub([first, JSON.stringify(proposal())]);
  const out = await ideate({ idea: 'someone races the tide', style: style(), seconds: 120, policy: policy(), client: wire.client, journal: wire.journal });
  assert.equal(out.calls, 2);
  assert.match(wire.calls[1].prompt, /dramatis\.protagonist" must be the NAME of a cast member — got "NOBODY", cast is FIGURE-1, KEEPER-1/);
  assert.deepEqual(wire.entries.map((e) => e.kind), ['ideate.start', 'ideate.attempt', 'ideate.attempt', 'ideate.result']);
  assert.equal(wire.entries[1].data.attempt, 1);
  assert.equal(wire.entries[2].data.fault, null);
  assert.deepEqual(wire.entries[3].data.brief, out.brief);
  assert.deepEqual(wire.entries[3].data.provenance, out.provenance);
  assert.equal(wire.entries[1].data.content, first, 'the raw answer is journaled');
});

test('doctrine lines and the world ride into the system prompt with their provenance; the dramatis law is stated', async () => {
  const wire = stub([JSON.stringify(proposal())]);
  await ideate({ idea: 'someone races the tide', style: style(), seconds: 120, policy: policy(), client: wire.client, journal: wire.journal });
  const system = wire.calls[0].systemPrompt;
  assert.match(system, /\[style:house-test doctrine #1\] the opposition is visible in the frame before it is named/);
  assert.match(system, /\[style:house-test doctrine #2\] every shot changes one thing/);
  assert.match(system, /THE WORLD \[style:house-test world\]: a coastal town after the fishing fleet left/);
  assert.match(system, /THE LOOK \[style:house-test look\]: grainy 16mm · cold teal shadows/);
  assert.match(system, /\[style:house-test constraint #1\] no on-screen text/);
  assert.match(system, /"protagonist" is the NAME of one cast member/);
  assert.match(system, /"opposition" is a force that ACTS ON SCREEN/);
  assert.match(system, /120-second film slice/);
  assert.equal(wire.entries[0].kind, 'ideate.start');
  assert.equal(wire.entries[0].data.systemPrompt, system, 'the full system prompt is journaled before the wire');
});

test('a missing field on the derived brief is a fault quoted back: an entry without a reason is rejected', async () => {
  const noReason = proposal({ locations: [{ name: 'THE-QUAY', reason: '' }] });
  const wire = stub([JSON.stringify(noReason), JSON.stringify(proposal())]);
  const out = await ideate({ idea: 'someone races the tide', style: style(), seconds: 120, policy: policy(), client: wire.client, journal: wire.journal });
  assert.match(wire.calls[1].prompt, /"locations\[0\]"\.reason is empty — every derived entry states why/);
  assert.equal(out.brief.locations[0].name, 'THE-QUAY');
});

test('a style reference that is a character or location must come back under its exact name', async () => {
  const wire = stub([JSON.stringify(proposal()), JSON.stringify(proposal({ locations: [{ name: 'THE-QUAY', reason: 'the shore' }, { name: 'THE-LIGHTHOUSE', reason: 'the reference names it' }] }))]);
  const out = await ideate({ idea: 'someone races the tide', style: style({ references: [{ name: 'THE-LIGHTHOUSE', role: 'location', image: 'x.png' }] }), seconds: 120, policy: policy(), client: wire.client, journal: wire.journal });
  assert.match(wire.calls[0].systemPrompt, /FIXED NAMES.*\n- \[style:house-test reference\] location: THE-LIGHTHOUSE/);
  assert.match(wire.calls[1].prompt, /the style reference THE-LIGHTHOUSE must appear in cast or locations/);
  assert.deepEqual(out.brief.locations.map((l) => l.name), ['THE-QUAY', 'THE-LIGHTHOUSE']);
});

test('a missing input refuses by name before any call: policy.plates, style.doctrine, seconds, the journal', async () => {
  const wire = stub([JSON.stringify(proposal())]);
  const base = { idea: 'someone races the tide', style: style(), seconds: 120, policy: policy(), client: wire.client, journal: wire.journal };
  await assert.rejects(() => ideate({ ...base, policy: {} }), /E-IDEATE-POLICY-PLATES: policy\.plates\.max is missing/);
  await assert.rejects(() => ideate({ ...base, policy: { plates: { max: 0 } } }), /E-IDEATE-POLICY-PLATES/);
  await assert.rejects(() => ideate({ ...base, style: style({ doctrine: undefined }) }), /E-IDEATE-STYLE-DOCTRINE/);
  await assert.rejects(() => ideate({ ...base, style: style({ references: undefined }) }), /E-IDEATE-STYLE-REFERENCES/);
  await assert.rejects(() => ideate({ ...base, style: style({ format: undefined }) }), /E-IDEATE-STYLE-FORMAT/);
  await assert.rejects(() => ideate({ ...base, style: style({ format: { resolution: '720p' } }) }), /E-IDEATE-STYLE-FORMAT/);
  await assert.rejects(() => ideate({ ...base, style: style({ audio: 'yes' }) }), /E-IDEATE-STYLE-AUDIO/);
  await assert.rejects(() => ideate({ ...base, seconds: '120' }), /E-IDEATE-NO-SECONDS/);
  await assert.rejects(() => ideate({ ...base, idea: '   ' }), /E-IDEATE-NO-IDEA/);
  await assert.rejects(() => ideate({ ...base, journal: {} }), /E-IDEATE-NO-JOURNAL/);
  assert.equal(wire.calls.length, 0, 'no money before the inputs are whole');
  assert.equal(wire.entries.length, 0);
});
