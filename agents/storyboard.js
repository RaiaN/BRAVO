// THE STORYBOARD AGENT — its artifact is a storyboard IMAGE: the film drawn as panels,
// before anything is rendered for real. Not in §4's table; defined here because §5 makes
// shot creation forking-only and a storyboard is one image, not N shots.
import { defineAgent } from './registry.js';
import { describeTools, TOOLS_BY_KIND } from './tools/index.js';
import { PROTOCOL_PROMPT } from './protocol.js';
import { filmLines, lookLine, SHARED } from './shared.js';
import { insertShot, subjectOf } from '../state/project.js';

export default defineAgent({
  id: 'storyboard',
  title: 'Storyboard',
  job: 'draw the film as a storyboard image',
  tools: TOOLS_BY_KIND.storyboard,

  // Its artifact is an IMAGE, so it belongs on an image slot — a video slot would bind it
  // to the wrong spec entirely.
  latch: ({ project, title, imageSlot }) => {
    const made = insertShot(project, { fields: { title }, modelSlot: imageSlot });
    return { project: made.project, subjectId: made.shot.id };
  },

  context: (project, thread) => {
    const subject = subjectOf(project, thread);
    return [
      'THE FILM SO FAR:', filmLines(project), '',
      'THIS THREAD OWNS the storyboard:',
      subject ? `  "${subject.title || '—'}"${subject.prompt ? ' · has a prompt' : ' · no prompt yet'}${subject.stills?.length ? ` · ${subject.stills.length} rendered` : ''}` : '  (nothing yet)',
      '', `THE LOOK: ${lookLine(project)}`,
    ].join('\n');
  },

  system: () => `You are the STORYBOARD agent in BRAVO, an AI film studio. Your job: draw the
film as ONE STORYBOARD IMAGE — its beats as panels, in order.

Your artifact is a single image, not a set of shots. You do not create the film's shots and
you do not render video.

HOW YOU WORK:
1. Establish the beats. If the person gave you an idea rather than a beat list, break it
   into 4–8 beats yourself and say what they are.
2. \`compose\` the storyboard prompt — one image, panels in a stated grid, one sentence of
   STATE per panel, one consistent drawn treatment throughout.
3. \`still\` renders it. That is the artifact.

A storyboard is for judging ORDER AND STAGING, not for beauty. Readable beats beat pretty
frames.

${SHARED}

TOOLS YOU HOLD:
${describeTools(TOOLS_BY_KIND.storyboard)}

${PROTOCOL_PROMPT}`,
});
