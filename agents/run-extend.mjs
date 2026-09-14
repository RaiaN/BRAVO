import fs from 'node:fs';
import path from 'node:path';
import { openJournal } from './journal.js';
import { runChain } from './chain.js';
import { createBrowserClient } from '../utils/film/core/client.js';
import { applyDeployModels } from '../utils/film/suiteConfig.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const idea = arg('idea', '');
const seconds = Number(arg('seconds', '120'));
const server = arg('server', '');
const runId = arg('run-id', `run_${Date.now().toString(36)}`);
const cwd = process.cwd();
if (!idea.trim() || !server || !Number.isInteger(seconds)) { console.error('usage: run-extend --idea "<story>" --server <url> [--seconds 120] [--run-id <id>]'); process.exit(2); }

const real = globalThis.fetch;
globalThis.fetch = (input, init) => real(typeof input === 'string' && input.startsWith('/') ? `${server}${input}` : input, init);

const POLICY = { attempts: 3, backoffMs: 20000, dMin: 20, dMax: 30 };

const main = async () => {
  const dir = path.join(cwd, 'runs', runId);
  const journal = await openJournal({ dir });
  await journal.write('pass', { runId, command: 'extend', idea, seconds, server, policy: POLICY });
  try {
    const cfg = await (await fetch('/api/film/config')).json();
    if (!cfg?.models) throw new Error(`E-SERVER: ${server} returned no models`);
    applyDeployModels(cfg.models);
    const style = JSON.parse(fs.readFileSync(path.join(cwd, 'looks', 'default.json'), 'utf8'));
    await journal.write('intake', { models: Object.fromEntries(Object.entries(cfg.models).map(([k, v]) => [k, !!v])), style: style.id, mode: 'chain — no QC, no rules' });
    const client = createBrowserClient(undefined);
    const out = await runChain({ idea, style, seconds, client, journal, runId, slot: 'seedance25', dMin: POLICY.dMin, dMax: POLICY.dMax, attempts: POLICY.attempts, backoffMs: POLICY.backoffMs });
    const lines = [`# ${runId}`, '', `**${out.plan.logline}**`, '', `Target ${seconds}s · measured ${out.slice.totalMeasured}s at ${out.slice.fps} fps`, '', '| shot | seconds | attempts | shipped | score |', '|---|---|---|---|---|', ...out.shots.map((s) => `| ${s.shotId} | ${s.seconds} | — | rendered | — |`), '', `Film: media/slice.mp4 · journal: journal.ndjson`];
    fs.writeFileSync(path.join(dir, 'report.md'), lines.join('\n') + '\n');
    await journal.write('complete', { runId, status: 'complete', slice: out.slice, shots: out.shots.length });
    await journal.close();
    console.log(JSON.stringify({ status: 'complete', runId, slice: path.join(dir, 'media', 'slice.mp4') }));
  } catch (err) {
    await journal.write('pass.failed', { runId, stage: 'extend', code: err.code || 'E-PASS-FAILED', detail: err.message, stack: String(err.stack || '').split('\n').slice(0, 6) });
    await journal.close();
    console.error(JSON.stringify({ status: 'failed', runId, detail: err.message }));
    process.exit(1);
  }
};
main();
