export const agent = 'router';

export const cases = [
  {
    name: 'ordinary · a shot',
    input: 'shot 3 is the collision — the wolf lands on the log and the dog is already committed',
    expect: { kind: 'shot' },
    why: 'the plainest possible request for a shot',
  },
  {
    name: 'ordinary · an edit',
    input: 'take the take I just rendered and make the ending land harder, trim the tail',
    expect: { kind: 'edit' },
    why: 'operates on an existing take — edit row',
  },
  {
    name: 'ordinary · a bible entry',
    input: 'I want a reference plate for the wolf so every shot draws the same animal',
    expect: { kind: 'bible' },
    why: 'consistency is attachment — this is a plate, not a shot',
  },
  {
    name: 'boundary · storyboard vs shot',
    input: 'draw me the whole film as a storyboard before we render anything',
    expect: { kind: 'storyboard' },
    why: 'the whole film, not one shot — must not collapse to shot',
  },
  {
    name: 'ambiguity · must ask, never guess',
    input: 'hey',
    expect: { ask: true },
    why: 'substituting a default. Guessing a kind here latches the thread wrongly, and latching is one-way',
  },
  {
    name: 'ambiguity · a question about the tool itself',
    input: 'what can you actually do?',
    expect: { ask: true },
    why: 'not a request for any agent — asking is the only honest answer',
  },
  {
    name: 'ordinary · a whole film goes to the director',
    input: 'produce a 20 second film: a stray signal reaches a night-shift radio operator who must decide whether to answer',
    expect: { kind: 'director' },
    why: 'an N-second story is an orchestration across shots — the director owns it, not a single shot thread',
  },
];
