import fs from 'node:fs';
import path from 'node:path';
import { openJournal } from './journal.js';
import { runChain } from './chain.js';
import { readAgentSettings } from './settings-store.js';
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

const POLICY = { attempts: 3, backoffMs: 20000, dMin: 20, dMax: 30, candidates: 5 };

const main = async () => {
  const dir = path.join(cwd, 'runs', runId);
  const journal = await openJournal({ dir });
  await journal.write('pass', { runId, command: 'extend', idea, seconds, server, policy: POLICY });
  try {
    const cfg = await (await fetch('/api/film/config')).json();
    if (!cfg?.models) throw new Error(`E-SERVER: ${server} returned no models`);
    applyDeployModels(cfg.models);
    const style = JSON.parse(fs.readFileSync(path.join(cwd, 'looks', 'default.json'), 'utf8'));
    const settings = readAgentSettings(cwd);
    await journal.write('intake', { models: cfg.models, style, configRevision: settings.revision, agents: settings.config, mode: 'Persona take selection → five parallel film QC agents → Persona receipt selection', reasoningEngine: 'Seed 2.0 Pro' });
    const client = createBrowserClient(undefined, { onEvent: (kind, data) => journal.write(kind, data) });
    const out = await runChain({ idea, style, seconds, client, journal, runId, slot: 'seedance25', dMin: POLICY.dMin, dMax: POLICY.dMax, attempts: POLICY.attempts, backoffMs: POLICY.backoffMs, candidates: POLICY.candidates, agentConfig: settings.config, configRevision: settings.revision });
    const lines = [`# ${runId}`, '', `**${out.plan.logline}**`, '', `Target ${seconds}s · measured ${out.slice.totalMeasured}s at ${out.slice.fps} fps`, '', '| shot | seconds | receipts | Persona’s selected agent |', '|---|---|---|---|', ...out.shots.map((s) => `| ${s.shotId} | ${s.seconds} | ${s.filmQC.receipts.length} | ${s.filmQC.selectedReceipt.agentName} |`), '', 'Receipts describe proposed improvements; they have not been applied to the assembled takes.', ...out.shots.flatMap((s) => ['', `## ${s.shotId}: ${s.filmQC.selectedReceipt.receipt.title}`, '', s.filmQC.selection.reason, '', '```json', JSON.stringify(s.filmQC, null, 2), '```']), '', `Film: media/slice.mp4 · journal: journal.ndjson`];
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
