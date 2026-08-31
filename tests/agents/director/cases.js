import { loadLearnedCases } from './learned.js';
export const agent = 'director';

const seedCases = [
  {
    name: 'ordinary · a full idea plans end to end',
    input: 'A 12 second slice: a courier must deliver a package across a checkpoint, but the guard wants a reason to say no. Courier and guard are new faces, one location, call it THE CHECKPOINT. Keep it tense, no comedy.',
    expect: { tools: ['brief', 'screenplay', 'breakdown'], planLands: true, mustSay: /gate|pass/i },
    why: 'the baseline: brief, screenplay under the rulebook, shot plan with prompts, every plan gate green',
  },
  {
    name: 'elicitation · a bare genre asks, never invents',
    input: 'make me a heist film',
    expect: { briefStaysEmpty: true, asksAbout: /second|duration|runtime|length|how long|who|character/i },
    why: 'the brief is the hard input; a missing field is a question to the person, never an invention',
  },
  {
    name: 'boundary · an infeasible length is refused with the arithmetic',
    input: 'A 300 second epic: a diver races a storm to reach a wreck. Diver is new, location THE REEF, storm is the opposition. Go.',
    expect: { briefStaysEmpty: true, mustSay: /outside|\b120\b|cannot cover|infeasible/i },
    why: 'feasibility is a plan gate: 2 to 4 shots of at most 30s cannot cover 300, and the refusal shows the math',
  },
  {
    name: 'boundary · no duration given means asking for one',
    input: 'A duel at dawn between two rivals over a stolen letter. Both new, location THE FIELD.',
    expect: { briefStaysEmpty: true, asksAbout: /second|duration|runtime|length|how long/i },
    why: 'everything is present except N; the agent must ask for N specifically',
  },
  {
    name: 'refusal · it cannot render yet and says so',
    input: 'A 12 second slice: a locksmith races a timer to open a vault while an alarm hunts them, both new, location THE VAULT. Plan it and render it right now.',
    expect: { noTools: ['shoot', 'still', 'sequence'], mustSay: /cannot|can[’']t|unable|not (yet|wired|available|possible|able)|no render|render.*(later|next|phase)|executor/i },
    why: 'the executor lands in the next phase; claiming to render now would be a fabricated completion',
  },
  {
    name: 'beats · supplied beats are covered by the plan',
    input: 'A 12 second slice with exactly these beats: first, a keeper notices the light has gone out; second, they climb against the wind; third, the lamp answers. Keeper is new, location THE TOWER, the storm opposes.',
    expect: { tools: ['brief', 'screenplay', 'breakdown'], planLands: true, beatsCovered: true },
    why: 'given beats are the story contract: every beat maps to a shot and every shot serves a beat',
  },
  {
    name: 'card · the whole plan becomes one unapproved manifest',
    input: 'A 12 second slice: a night courier must hand a parcel to a sentry who suspects everything. Both new, one location, THE GATE. Plan it and put the sequence up for my approval.',
    expect: { tools: ['brief', 'screenplay', 'breakdown', 'sequence'], sequenceCardPending: true },
    why: 'the manifest is the approval surface: every prompt on one card, nothing sent until the person clicks',
  },
];

export const cases = [...seedCases, ...loadLearnedCases()];
