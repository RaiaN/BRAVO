import { installRelativeFetch } from './tests/lib/client.js';
const BASE = 'http://127.0.0.1:3000';
installRelativeFetch(BASE);
const sk = await import('./utils/film/skills.js');
const { applyDeployModels } = await import('./utils/film/suiteConfig.js');
applyDeployModels((await (await fetch(`${BASE}/api/film/config`)).json()).models);
const { createBrowserClient } = await import('./utils/film/core/client.js');
const real = createBrowserClient();
let seen = null;
const spy = { ...real, reason: (a) => { seen = a.systemPrompt; return real.reason(a); } };
const { makeProject, makeBibleEntry, touch } = await import('./state/project.js');
const { TOOLS } = await import('./agents/tools/index.js');
let p = makeProject();
const entry = makeBibleEntry({ name: 'the lighthouse keeper', role: 'character' });
p = touch({ ...p, bible: [entry] });
const thread = { id: 't', kind: 'bible', subjectId: entry.id, messages: [], budget: {} };
const r = await TOOLS.compose.run({
  input: { note: 'an elderly lighthouse keeper, weathered, in oilskins' },
  project: p, thread,
  ctx: { client: spy, requireSkillLine: sk.requireSkillLine, modelId: null },
});
console.log(r.output.kind === 'prompt' ? '  ✓ plate composed on the image slot' : '  ✗ ' + r.output.error);
console.log(seen.includes('<<<SPEC name: plate-pe') ? '  ✓ plate-pe reached the reasoner' : '  ✗ plate-pe missing');
console.log(seen.includes('sd25-pe') ? '  ✗ video spec leaked into the image path' : '  ✓ video specs stayed out');
console.log('  model slot used: ' + r.output.model);
console.log('\n' + r.output.prompt.slice(0, 300));
