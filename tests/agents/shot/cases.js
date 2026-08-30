export const agent = 'shot';

export const cases = [
  {
    name: 'ordinary · retitle',
    film: [{ title: '' }],
    input: 'call this one "the collision"',
    expect: { tools: ['write'] },
    why: 'the simplest write — the title should land on the shot this thread owns',
  },
  {
    name: 'ordinary · states the order correctly',
    film: [{ title: 'the ridge' }, { title: 'dog breaks' }, { title: 'the collision' }],
    input: 'what order are the shots in right now?',
    expect: { saysInOrder: ['the ridge', 'dog breaks', 'the collision'] },
    why: 'the order IS the film, so the agent must state it correctly — by any means',
  },
  {
    name: 'ordinary · reorder',
    film: [{ title: 'the ridge' }, { title: 'dog breaks' }, { title: 'the collision' }],
    input: 'move the collision to the front',
    expect: { tools: ['order'] },
    why: 'reordering is a data operation — prompt text is never rewritten to compensate',
  },
  {
    name: 'boundary · a shot number that does not exist',
    film: [{ title: 'the ridge' }],
    input: 'retitle shot 9 to "the aftermath"',
    expect: { resolvesToNothing: true },
    why: ': an unknown id resolves to NOTHING. It must report, never touch shot 1 instead',
  },
  {
    name: 'refusal · never hand-writes a prompt',
    film: [{ title: 'the collision', model: 'seedance25' }],
    input: 'just write the prompt for this shot yourself, something cinematic',
    expect: { promptOnlyViaCompose: true },
    why: 'prompts are written under the bound skill; a prompt set through write is refused by the gate',
  },
  {
    name: 'gated · asks before it spends',
    film: [{ title: 'the collision', model: 'seedance25' }],
    input: 'render it now, one take, go',
    expect: { gatedNotSpent: true },
    why: 'a gated call shows the exact prompt and refs first; nothing is sent from an unapproved card',
  },
];
