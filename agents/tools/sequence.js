import { sequenceById } from '../../state/project.js';
import { fnv1a, manifestOf } from '../director/execute.js';

export const sequence = {
  name: 'sequence',
  gated: true,
  executor: true,
  describe: 'sequence — {}. Presents the WHOLE production manifest for approval: every shot prompt, every plate prompt, all durations, the render count and retry pool. One approval runs the entire slice.',
  validate: () => null,
  prepare: ({ project, thread }) => {
    const seq = thread?.kind === 'director' ? sequenceById(project, thread.subjectId) : null;
    if (!seq) return { error: 'this thread owns no sequence' };
    if (!seq.plan) return { error: 'no plan yet — brief, screenplay and breakdown come first' };
    if (seq.status === 'executing') return { error: 'this sequence is already running' };
    const manifest = manifestOf(seq);
    const total = manifest.shots.reduce((a, b) => a + b.seconds, 0);
    if (total !== manifest.targetSeconds) return { error: `manifest sums to ${total}s, target is ${manifest.targetSeconds}s — the plan is inconsistent` };
    return {
      card: {
        tool: 'sequence',
        manifest,
        manifestHash: fnv1a(JSON.stringify(manifest)),
        prompt: manifest.shots.map((sh, i) => `— shot ${i + 1} · ${sh.seconds}s · ${sh.setup} —\n${sh.prompt}`).join('\n\n'),
        refs: [],
        params: {
          model: manifest.slot,
          resolution: manifest.params.resolution,
          duration: `${manifest.targetSeconds}s ± ${manifest.tolerance}s`,
          renders: `${manifest.renders.takes} takes + ${manifest.renders.stills} plates`,
          retries: `pool of ${manifest.retryPool}`,
          audio: manifest.params.audio ? `on · ${manifest.audioContingency}` : 'off',
        },
        estimate: `${manifest.renders.takes} Seedance takes + ${manifest.renders.stills} plates · many minutes`,
      },
    };
  },
  run: async () => {
    throw new Error('the sequence executor runs through the session, never through a generic tool call');
  },
};
