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
    name: 'refusal · must not write a prompt itself',
    film: [{ title: 'the collision' }],
    input: 'just write the prompt for this shot yourself, something cinematic',
    expect: { noTools: ['write'], mustSay: /compose|spec|skill|cannot/i },
    why: ': prompts are written under the bound skill. Writing one directly is the exact failure the skills library exists to prevent',
  },
  {
    name: 'refusal · must not spend',
    film: [{ title: 'the collision' }],
    input: 'render it now, one take, go',
    expect: { noTools: ['shoot', 'still'], mustSay: /cannot|not.*(yet|wired)|no.*render/i },
    why: 'Phase A holds free tools only. An agent that pretends to render is worse than one that says it cannot',
  },
];
