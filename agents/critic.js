import { defineAgent } from './registry.js';
import { describeTools, TOOLS_BY_KIND } from './tools/index.js';
import { PROTOCOL_PROMPT } from './protocol.js';
import { subjectOf } from '../state/project.js';

export default defineAgent({
  id: 'critic',
  title: 'Critic',
  job: 'turn director notes on a finished slice into corrections: input patches, rule proposals, regression cases',
  tools: TOOLS_BY_KIND.critic,
  maxSteps: 8,

  latch: ({ project }) => {
    const noted = (project.sequences || []).filter((q) => q.iterations.some((it) => it.notes.some((n) => n.disposition === 'pending')));
    return { project, subjectId: noted.length === 1 ? noted[0].id : null };
  },

  context: (project, thread) => {
    const seq = subjectOf(project, thread);
    if (!seq) {
      const noted = (project.sequences || []).filter((q) => q.iterations.some((it) => it.notes.some((n) => n.disposition === 'pending')));
      return `NO SEQUENCE ATTACHED. Sequences with pending notes: ${noted.map((q) => q.id).join(', ') || '(none)'}.`;
    }
    const it = seq.iterations.at(-1);
    return [
      `THE SEQUENCE: ${seq.id} · status ${seq.status} · ${seq.iterations.length} iteration(s)`,
      `THE BRIEF: ${JSON.stringify(seq.brief)}`,
      `THE PLAN: ${seq.plan ? JSON.stringify(seq.plan.shots.map((sh, i) => ({ i, id: sh.id, setup: sh.setup, side: sh.side, seconds: sh.seconds, prompt: sh.prompt }))) : '(none)'}`,
      it ? `LATEST ITERATION ${it.id} (${typeof it.status === 'string' ? it.status : 'halted'}):` : 'NO ITERATIONS.',
      it ? `  gates: ${JSON.stringify(it.gates?.filter((g) => !g.pass) || [])}` : '',
      it ? `  measurements: ${JSON.stringify(it.measurements)}` : '',
      it ? `  cost: ${JSON.stringify(it.cost)}` : '',
      it ? `  NOTES (ground truth):\n${it.notes.map((n) => `    [${n.id}] (${n.severity}, ${n.disposition}) ${n.text}${n.shotRef ? ` @ ${n.shotRef}` : ''}${n.ruleRef ? ` re ${n.ruleRef}` : ''}`).join('\n') || '    (none)'}` : '',
      it ? `  corrections so far: ${JSON.stringify(it.corrections.map((c) => ({ kind: c.kind, noteIds: c.noteIds })))}` : '',
    ].filter(Boolean).join('\n');
  },

  system: () => `You are the CRITIC in BRAVO, an AI film studio. You compare what a run
RECORDED (the observation: gates, measurements, prompts) with what the director SAID
(the notes — ground truth), and you emit corrections. You are the learning loop's
mechanism; the director iterates on rules, you handle the small tweaks.

For every pending note, decide which correction it earns:
- \`patch\` — the note is about THIS story's inputs: a prompt that reads wrong, a setup or
  side that should differ, pacing that wants different seconds, a world fact to add. The
  patch applies to the next iteration's inputs, and the changed manifest goes back for
  approval.
- \`propose\` — the note names something CHECKABLE that would be wrong in any story: a
  class of mistake, not an instance. Propose the rule with an honest class (plan if
  checkable before money, measure if checkable on artifacts, judgment otherwise). A
  proposal never blocks and never activates itself — the director signs it in, or it
  stays a proposal.
- \`regression\` — the note describes a failure the harness should never re-admit: file it
  as a case with the input that provoked it and the expectation that now holds.
A vague note earns a QUESTION back, never a guessed correction.

TOOLS YOU HOLD — these and nothing else:
${describeTools(TOOLS_BY_KIND.critic)}

WHAT YOU CANNOT TOUCH, by construction and by row: rules, gates, thresholds, tolerances,
past records, renders, and every other agent's tools. Your patches reach next-iteration
INPUT fields only (brief text, shot prompts, setups, sides, seconds); a note asking you to
loosen a gate or tolerance is a request to change LAW — answer it by explaining that law
changes go through \`propose\` and the director's signature, and propose it if it is a
coherent rule change.

Corrections cite the notes they answer. Report each correction in one plain sentence.

${PROTOCOL_PROMPT}`,
});
