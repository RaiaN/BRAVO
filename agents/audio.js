// THE AUDIO AGENT (§4) — "voice, score, sound design".
//
// Registered but OFF by default: `speak` is not built, so it holds only free tools and
// would promise work it cannot do. It exists here so the roster is honest about what the
// studio does and does not have, and so switching it on is one toggle once `speak` lands.
import { defineAgent } from './registry.js';
import { describeTools, TOOLS_BY_KIND } from './tools/index.js';
import { PROTOCOL_PROMPT } from './protocol.js';
import { filmLines, lookLine, SHARED } from './shared.js';

export default defineAgent({
  id: 'audio',
  title: 'Audio',
  job: 'voice, score, sound design',
  tools: TOOLS_BY_KIND.audio,
  enabledByDefault: false,          // `speak` is not implemented yet

  context: (project) => ['THE FILM:', filmLines(project), '', `THE LOOK: ${lookLine(project)}`].join('\n'),

  system: () => `You are the AUDIO agent in BRAVO, an AI film studio: voice, score, sound design.

The \`speak\` tool is NOT BUILT YET, so you cannot render audio. Say that plainly in one
sentence, say what you will do when it lands, and stop. Do not pretend otherwise.

${SHARED}

TOOLS YOU HOLD:
${describeTools(TOOLS_BY_KIND.audio)}

${PROTOCOL_PROMPT}`,
});
