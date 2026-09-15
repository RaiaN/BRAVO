import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const RUN_ID = /^[a-z0-9_-]+$/i;
const MEDIA = /^[a-z0-9][a-z0-9._-]{0,120}\.(mp4|mov|jpg|jpeg|png|webp)$/i;
const runsDir = () => path.join(process.cwd(), 'runs');

const newRunId = () => `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;

const readJournal = (dir) => {
  const file = path.join(dir, 'journal.ndjson');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};

export const summarize = (runId) => {
  const dir = path.join(runsDir(), runId);
  if (!fs.existsSync(dir)) return { runId, exists: false };
  const rows = readJournal(dir);
  const kind = (k) => rows.filter((r) => r.kind === k);
  const plan = kind('plan').filter((r) => !(r.data.problems || []).length).at(-1)?.data || null;
  const shots = (plan?.shots || []).map((sh) => {
    const nodes = kind('node').filter((r) => r.data.id === `shot:${sh.id}`);
    const last = nodes.at(-1)?.data || null;
    const qc = kind('qc.take').filter((r) => r.data.shotId === sh.id);
    const decisions = kind('decision').filter((r) => r.data.shotId === sh.id).map((r) => ({ attempt: r.data.attempt, decision: r.data.decision, reason: r.data.reason }));
    const faults = kind('fault').filter((r) => r.data.shotId === sh.id).map((r) => ({ attempt: r.data.attempt, kind: r.data.kind, reason: r.data.reason }));
    const mediaDir = path.join(dir, 'media');
    const takes = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter((f) => f.startsWith(`shot-${sh.id}-`) && /\.(mp4|mov)$/.test(f)).sort() : [];
    const choice = kind('persona.choice').filter((r) => r.data.shotId === sh.id).at(-1)?.data || null;
    const reviews = kind('persona.review').filter((r) => r.data.shotId === sh.id).map((r) => ({ file: r.data.file, variant: r.data.variant, score: r.data.score, notes: r.data.notes }));
    const forTake = (k) => kind(k).filter((r) => r.data.shotId === sh.id && r.data.file === choice?.file);
    const qcStart = forTake('qc.started').at(-1)?.data;
    const receipts = forTake('qc.receipt').map((r) => r.data);
    const selection = forTake('persona.receipt-choice').at(-1)?.data || null;
    const qcFailure = forTake('qc.failed').at(-1)?.data || null;
    const stages = forTake('qc.stage').map((r) => r.data);
    const qcStatus = qcFailure ? 'failed' : selection ? 'complete' : receipts.length === 5 ? 'selecting' : 'reviewing';
    const filmQC = qcStart ? {
      status: qcStatus, receipts, selection, failures: qcFailure?.failures || [],
      agents: qcStart.agents.map((agent) => {
        const latest = stages.filter((s) => s.agentId === agent.id).at(-1);
        return { id: agent.id, name: agent.name, focus: agent.focus, stage: latest?.stage || 'inspect', status: latest?.status || 'pending', attempt: latest?.attempt || 0, error: latest?.error || null };
      }),
    } : null;
    return { ...sh, status: qcFailure ? 'failed' : last?.status || 'pending', phase: last?.phase || null, filmQC, chosen: choice ? { file: choice.file, variant: choice.variant, reason: choice.reason } : null, reviews, attempt: last?.attempt ?? choice?.attempt ?? null, shipped: last?.shipped || null, extendsFrom: nodes.find((r) => r.data.extendsFrom)?.data.extendsFrom || null, takes, qc: qc.map((r) => ({ attempt: r.data.attempt, pass: r.data.pass, score: r.data.score, findings: (r.data.findings || []).map((f) => `${f.rule}: ${f.detail}`) })), decisions, faults };
  });
  const final = kind('final').at(-1)?.data || null;
  const failed = kind('pass.failed').at(-1)?.data || null;
  const refused = kind('intake.refused').at(-1)?.data || null;
  const complete = kind('complete').at(-1)?.data || null;
  const assemble = kind('node').filter((r) => r.data.id === 'assemble' && r.data.status === 'done').at(-1)?.data || null;
  const slice = fs.existsSync(path.join(dir, 'media', 'slice.mp4')) ? 'slice.mp4' : null;
  const status = refused ? 'refused' : failed ? 'failed' : complete ? 'complete' : assemble ? 'assembled' : shots.some((s) => s.filmQC && !['complete', 'failed'].includes(s.filmQC.status)) ? 'reviewing' : plan ? 'rendering' : rows.length ? 'planning' : 'starting';
  return { runId, exists: true, status, steps: rows.length, logline: plan?.logline || null, seconds: kind('window').at(-1)?.data?.seconds ?? null, shots, final, failed, refused, slice, report: fs.existsSync(path.join(dir, 'report.md')), last: rows.at(-1) ? { kind: rows.at(-1).kind, at: rows.at(-1).at } : null };
};

export default function handler(req, res) {
  if (req.method === 'POST') {
    const { idea, seconds } = req.body || {};
    if (!String(idea || '').trim()) return res.status(400).json({ error: 'the story is empty' });
    const n = Number(seconds ?? 120);
    if (!Number.isInteger(n) || n < 40) return res.status(400).json({ error: 'seconds must be an integer of at least 40' });
    const runId = newRunId();
    fs.mkdirSync(runsDir(), { recursive: true });
    const log = fs.openSync(path.join(runsDir(), `${runId}.log`), 'a');
    const server = `http://${req.headers.host}`;
    const child = spawn(process.execPath, ['--env-file-if-exists=.env.local', '--import', './tools/hook.mjs', 'agents/run-extend.mjs', '--idea', String(idea).trim(), '--seconds', String(n), '--server', server, '--run-id', runId], {
      cwd: process.cwd(), detached: true, stdio: ['ignore', log, log], env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` },
    });
    child.unref();
    return res.status(200).json({ runId, pid: child.pid, log: `runs/${runId}.log` });
  }
  if (req.method === 'GET') {
    const { runId, file } = req.query;
    if (!RUN_ID.test(String(runId || ''))) return res.status(400).json({ error: 'runId must be a plain token' });
    if (req.query.journal === '1') {
      const filePath = path.join(runsDir(), String(runId), 'journal.ndjson');
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No journal yet' });
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', `attachment; filename="${runId}-journal.ndjson"`);
      return fs.createReadStream(filePath).pipe(res);
    }
    if (file) {
      if (!MEDIA.test(String(file))) return res.status(400).json({ error: 'not a media file name' });
      const p = path.join(runsDir(), runId, 'media', String(file));
      if (!fs.existsSync(p)) return res.status(404).json({ error: 'no such media yet' });
      const stat = fs.statSync(p);
      res.setHeader('Content-Type', String(file).endsWith('.mov') ? 'video/quicktime' : String(file).endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Accept-Ranges', 'bytes');
      return fs.createReadStream(p).pipe(res);
    }
    return res.status(200).json(summarize(String(runId)));
  }
  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
