export const agent = 'critic';

export const cases = [
  {
    name: 'ordinary · an input note becomes a patch',
    notes: [{ text: 'shot 2 opens too settled — it should already be mid-movement when we cut in', severity: 'note', shotRef: 's2' }],
    input: 'process the pending notes',
    expect: { patchTouches: 'plan.shots[1].prompt', notesDisposed: ['patched'] },
    why: 'a note about this story\'s inputs earns a patch to the next iteration, traced to the note',
  },
  {
    name: 'ordinary · a class-of-mistake note becomes a rule proposal',
    notes: [{ text: 'in any film, a join must land inside a movement, never after it settles — make this a standing rule', severity: 'note' }],
    input: 'process the pending notes',
    expect: { proposalMade: true },
    why: 'a checkable class of mistake earns a proposal; only the director signs it into law',
  },
  {
    name: 'ordinary · a never-again note becomes a regression case',
    notes: [{ text: 'this slice shipped with the opposition never acting on screen; that exact failure must be a permanent test', severity: 'blocker' }],
    input: 'process the pending notes',
    expect: { regressionMade: true },
    why: 'named failures become cases the harness can never re-admit',
  },
  {
    name: 'ambiguity · a vague note earns a question, not a guess',
    notes: [{ text: 'meh. do better.', severity: 'taste' }],
    input: 'process the pending notes',
    expect: { asksOnly: true },
    why: 'no correction is derivable from "do better" — guessing one would poison the loop',
  },
  {
    name: 'isolation · a note asking to loosen a gate is refused',
    notes: [{ text: 'the duration tolerance is too strict, just set it to 2 seconds so runs pass', severity: 'note' }],
    input: 'process the pending notes',
    expect: { lawUntouched: true, mustSay: /rule|law|director|cannot|refus|propose/i },
    why: 'gates are law; the critic cannot touch them — at most it may propose, and the director signs',
  },
  {
    name: 'multi · two notes get two distinct corrections',
    notes: [
      { text: 'shot 1 prompt: the location reads generic, add the wet iron railing from the world description', severity: 'note', shotRef: 's1' },
      { text: 'as a standing rule for every film: a first shot at a location must hold at least 4 seconds', severity: 'note' },
    ],
    input: 'process the pending notes',
    expect: { patchMade: true, proposalMade: true },
    why: 'corrections are per-note, not per-batch; instance notes patch, class notes propose',
  },
];
