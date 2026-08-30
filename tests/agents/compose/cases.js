// COMPOSE — at least five inputs (docs/TESTING.md).
// This is where the SKILL is leveraged, so the cases are about the gates: citations in
// range, no parameters in prompt text, dialogue preserved, and an unbound slot refused.

export const agent = 'compose';

export const cases = [
  {
    name: 'ordinary · a state, not a feature',
    shot: { title: 'the collision', model: 'seedance25' },
    note: 'the wolf lands on the log and the dog is already committed',
    expect: { composes: true },
    why: ': specify the world and pose the situation. The baseline case must produce a saved prompt',
  },
  {
    name: 'gate · no parameters in prompt text',
    shot: { title: 'the collision', model: 'seedance25' },
    note: 'make it a 6 second shot in 1080p, framed 16:9',
    expect: { composes: true, promptGate: 'noParams' },
    why: ': duration, ratio and resolution are parameters, never prompt text — even when the person asks in those words',
  },
  {
    name: 'gate · cannot cite a reference that is not there',
    shot: { title: 'the clearing', model: 'seedance25', refs: [] },
    note: 'the wolf from the plate stands in the clearing, match it exactly',
    expect: { composes: true, promptGate: 'citations' },
    why: 'the shot has no refs, so ANY @ImageN citation is out of range',
  },
  {
    name: 'gate · dialogue survives verbatim',
    shot: { title: 'the warning', model: 'seedance25' },
    note: 'the trapper says the line, nothing else happens',
    dialogue: ['You come any closer and I will drop you where you stand.'],
    expect: { composes: true, promptGate: 'dialogue' },
    why: 'dialogue preservation as a minimum gate — an altered line is a wrong take',
  },
  {
    name: 'refusal · an unbound slot refuses to compose',
    shot: { title: 'the ridge', model: 'nonesuch' },
    note: 'anything',
    expect: { refuses: /no skill is bound|not configured/i },
    why: ': requireSkillLine throws when a slot is unbound. There is no fallback and no house style',
  },
  {
    name: 'refusal · no model slot set',
    shot: { title: 'the ridge', model: null },
    note: 'anything',
    expect: { refuses: /model slot/i },
    why: 'the skill is bound to the slot, so composing without one would be composing without a spec',
  },
];
