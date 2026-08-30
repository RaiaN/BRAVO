import { installRelativeFetch } from './tests/lib/client.js';
const BASE = 'http://127.0.0.1:3000';
installRelativeFetch(BASE);
const { applyDeployModels } = await import('./utils/film/suiteConfig.js');
applyDeployModels((await (await fetch(`${BASE}/api/film/config`)).json()).models);
const { createBrowserClient } = await import('./utils/film/core/client.js');
await import('./agents/index.js');
const { advance, approveCall } = await import('./agents/session.js');
const { makeProject, appendMessage, threadById } = await import('./state/project.js');

const client = createBrowserClient();
let p = makeProject();
const id = p.threads[0].id;
const get = () => p, apply = (fn) => { p = fn(p) || p; };
p = appendMessage(p, id, { role: 'user', text: 'create a bible entry: an elderly lighthouse keeper in oilskins' });
await advance({ client, threadId: id, get, apply });

let t = threadById(p, id);
const card = t.messages.find(m => m.role === 'tool' && m.tool.card && !m.tool.approved);
console.log('card:', card.tool.card.tool, '— approving (one Seedream image)…');
await approveCall({ client, threadId: id, messageId: card.id, get, apply });

t = threadById(p, id);
console.log('\nFULL TRANSCRIPT after approval follow-up:');
let toolRounds = 0;
for (const m of t.messages) {
  if (m.role === 'tool') {
    toolRounds++;
    const o = m.tool.output;
    console.log(`[tool ${m.tool.name}] input=${JSON.stringify(m.tool.input).slice(0,90)} -> ${o ? o.kind + (o.error ? ': ' + o.error.slice(0,140) : '') : 'card'}`);
  } else console.log(`[${m.role}] ${String(m.text).replace(/\n+/g,' | ').slice(0,150)}`);
}
console.log('\nstatus:', t.status, '| tool messages:', toolRounds);
console.log('bible:', p.bible.map(b => `${b.name}(${b.role}) plate=${!!b.plateUrl}`).join(', '));
