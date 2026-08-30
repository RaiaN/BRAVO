import { installRelativeFetch } from './tests/lib/client.js';
const BASE = 'http://127.0.0.1:3000';
installRelativeFetch(BASE);
const { applyDeployModels } = await import('./utils/film/suiteConfig.js');
applyDeployModels((await (await fetch(`${BASE}/api/film/config`)).json()).models);
const { createBrowserClient } = await import('./utils/film/core/client.js');
await import('./agents/index.js');
const { advance } = await import('./agents/session.js');
const { makeProject, appendMessage, threadById } = await import('./state/project.js');

const client = createBrowserClient();
let p = makeProject();
const id = p.threads[0].id;
p = appendMessage(p, id, { role: 'user', text: 'create a bible entry: an elderly lighthouse keeper in oilskins' });
await advance({ client, threadId: id, get: () => p, apply: (fn) => { p = fn(p) || p; } });

const t = threadById(p, id);
console.log('kind:', t.kind, '| status:', t.status, '| messages:', t.messages.length);
for (const m of t.messages) {
  if (m.role === 'tool') {
    const o = m.tool.output;
    console.log(`[tool ${m.tool.name}] card=${!!m.tool.card} -> ${o ? o.kind + (o.error ? ': ' + o.error.slice(0,120) : '') : 'pending card'}`);
  } else {
    console.log(`[${m.role}] ${String(m.text).replace(/\n+/g, ' | ').slice(0, 160)}`);
  }
}
