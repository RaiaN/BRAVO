import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promotionDecision, recurrenceDecision } from '../agents/director/policy.js';

const INDEX = 'index.json';
const FOLDS = 'folds.ndjson';

const readNdjson = (file) => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`E-KB-UNREADABLE: ${file} line ${i + 1} is not JSON (${err.message})`);
    }
  });
};

const readJson = (file) => {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

export const signatureOf = (f) => (typeof f.signature === 'string' && f.signature.trim()
  ? f.signature
  : [f.family, f.stage, f.code, f.ruleId || f.rubricId || f.metricId || ''].join(':'));

const stats = (xs) => {
  const n = xs.length;
  if (!n) return { n: 0, min: null, max: null, mean: null };
  const sum = xs.reduce((a, b) => a + b, 0);
  return { n, min: Math.min(...xs), max: Math.max(...xs), mean: Math.round((sum / n) * 1000) / 1000 };
};

export const readRunDir = (dir) => {
  const runId = path.basename(dir);
  const entries = readNdjson(path.join(dir, 'journal.ndjson'));
  const findings = readNdjson(path.join(dir, 'errors.ndjson')).map((f) => ({ ...f, runId: f.runId || runId }));
  const project = readJson(path.join(dir, 'project.json'));
  const kind = (k) => entries.filter((e) => e.kind === k);
  const intake = kind('intake').at(-1)?.data || null;
  const plan = kind('plan').at(-1)?.data || null;
  const complete = kind('complete').at(-1)?.data || null;
  const failed = kind('pass.failed').at(-1)?.data || null;
  const refused = kind('intake.refused').at(-1)?.data || null;
  const notes = (project?.sequences || []).flatMap((q) => (q.iterations || []).flatMap((it) => (it.notes || []).map((n) => ({ sequenceId: q.id, iteration: it.id, ...n }))));
  const seconds = new Map((plan?.shots || []).map((sh) => [String(sh.id), sh.seconds]));
  const joins = kind('join').map((e) => e.data).filter((j) => Number.isInteger(j.distance) && j.joinType);
  const overshoot = kind('measure').map((e) => e.data).filter((m) => typeof m.measured === 'number' && seconds.has(String(m.shotId)))
    .map((m) => ({ shotId: m.shotId, planned: seconds.get(String(m.shotId)), measured: m.measured, overshoot: Math.round((m.measured - seconds.get(String(m.shotId))) * 1000) / 1000 }));
  const costs = kind('cost').map((e) => e.data);
  return {
    runId,
    dir,
    idea: intake?.idea ?? null,
    styleId: intake?.style?.id ?? null,
    seconds: intake?.seconds ?? null,
    status: refused ? 'refused' : (failed ? 'failed' : (complete ? complete.status : (entries.length ? 'in progress' : 'empty'))),
    steps: entries.length,
    findings,
    notes,
    joins,
    overshoot,
    costs,
  };
};

export const listRunDirs = (runsDir) => {
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(runsDir, d.name, 'journal.ndjson')))
    .map((d) => path.join(runsDir, d.name))
    .sort();
};

const count = (map, key, by = 1) => { map[key] = (map[key] || 0) + by; };

const requirePolicy = (policy, where) => {
  if (!policy || typeof policy !== 'object' || typeof policy.id !== 'string' || !policy.id) throw new Error(`E-KB-POLICY: ${where} runs under the policy values whose criteria it applies (policy.learn, policy.judge)`);
  return policy;
};

const requireAudit = (audit, where) => {
  if (typeof audit !== 'function') throw new Error(`E-KB-AUDIT: ${where} needs the knowledge audit (index => [[ruleId, gate]]) that runs POL-009 and POL-010 over the folded index`);
  return audit;
};

const auditSummary = (gates) => {
  if (!Array.isArray(gates) || !gates.length || gates.some(([ruleId, g]) => typeof ruleId !== 'string' || !g || typeof g.pass !== 'boolean' || !Array.isArray(g.blockers))) throw new Error('E-KB-AUDIT: the knowledge audit returns [[ruleId, { pass, results, blockers }]] rows');
  return { rules: gates.map(([ruleId, g]) => ({ ruleId, pass: g.pass, blockers: g.blockers.length })), blockers: gates.reduce((a, [, g]) => a + g.blockers.length, 0) };
};

const judgeAgreement = (runs, policy) => {
  const byRubric = {};
  for (const run of runs) {
    const looked = new Set(run.notes.filter((n) => n.author === 'human' && n.shotRef).map((n) => String(n.shotRef)));
    const flagged = new Set(run.notes.filter((n) => n.author === 'human' && n.shotRef && ['blocker', 'note'].includes(n.severity)).map((n) => String(n.shotRef)));
    if (!looked.size) continue;
    for (const f of run.findings.filter((x) => x.family === 'qc' && x.code === 'E-RUBRIC-FAIL' && x.rubricId && x.shotId && looked.has(String(x.shotId)))) {
      const r = byRubric[f.rubricId] || (byRubric[f.rubricId] = { rubricId: f.rubricId, instances: 0, agreements: 0, runs: new Set() });
      r.instances += 1;
      if (flagged.has(String(f.shotId))) r.agreements += 1;
      r.runs.add(run.runId);
    }
  }
  return Object.values(byRubric).map((r) => {
    const precision = r.instances ? Math.round((r.agreements / r.instances) * 1000) / 1000 : 0;
    const decision = promotionDecision({ policy, rubricId: r.rubricId, instances: r.instances, precision });
    return { rubricId: r.rubricId, instances: r.instances, agreements: r.agreements, precision, runs: [...r.runs], promote: decision.promote, reason: decision.reason };
  }).sort((a, b) => b.instances - a.instances || a.rubricId.localeCompare(b.rubricId));
};

export const foldRuns = ({ runsDir, policy }) => {
  if (typeof runsDir !== 'string' || !runsDir) throw new Error('E-KB-RUNS: foldRuns needs the runs directory');
  requirePolicy(policy, 'foldRuns');
  const runs = listRunDirs(runsDir).map(readRunDir);
  const byCode = {};
  const byFamily = {};
  const byStage = {};
  const bySeverity = {};
  const sigs = {};
  for (const run of runs) {
    for (const f of run.findings) {
      count(byCode, f.code);
      count(byFamily, f.family);
      count(byStage, f.stage);
      count(bySeverity, f.severity);
      const sig = signatureOf(f);
      const s = sigs[sig] || (sigs[sig] = { signature: sig, family: f.family, stage: f.stage, code: f.code, ruleId: f.ruleId || null, rubricId: f.rubricId || null, count: 0, cost: 0, runIds: new Set(), ideas: new Set(), corrections: new Set() });
      s.count += 1;
      s.cost += typeof f.cost === 'number' ? f.cost : 0;
      s.runIds.add(run.runId);
      if (run.idea) s.ideas.add(run.idea);
      if (f.correction) s.corrections.add(f.correction);
    }
  }
  const recurrence = Object.values(sigs).map((s) => {
    const row = { signature: s.signature, family: s.family, stage: s.stage, code: s.code, ruleId: s.ruleId, rubricId: s.rubricId, count: s.count, cost: s.cost, runs: s.runIds.size, ideas: s.ideas.size, runIds: [...s.runIds], corrections: [...s.corrections] };
    const d = recurrenceDecision({ policy, signature: s.signature, runs: s.runIds.size, ideas: s.ideas.size });
    row.propose = d.propose;
    row.reason = d.reason;
    return row;
  }).sort((a, b) => b.runs - a.runs || b.count - a.count || a.signature.localeCompare(b.signature));

  const joinsByType = {};
  for (const j of runs.flatMap((r) => r.joins)) (joinsByType[j.joinType] || (joinsByType[j.joinType] = [])).push(j.distance);
  const overshootByDuration = {};
  for (const o of runs.flatMap((r) => r.overshoot)) (overshootByDuration[String(o.planned)] || (overshootByDuration[String(o.planned)] = [])).push(o.overshoot);
  const waste = {};
  for (const c of runs.flatMap((r) => r.costs).filter((c) => c.disposition !== 'kept')) count(waste, `${c.kind}/${c.disposition}/${c.code}`, c.units);

  return {
    generatedAt: new Date().toISOString(),
    runsDir,
    policyId: policy.id,
    runs: runs.map((r) => ({ runId: r.runId, idea: r.idea, styleId: r.styleId, seconds: r.seconds, status: r.status, steps: r.steps, findings: r.findings.length, notes: r.notes.length })),
    totals: { runs: runs.length, findings: runs.reduce((a, r) => a + r.findings.length, 0), notes: runs.reduce((a, r) => a + r.notes.length, 0) },
    counts: { byCode, byFamily, byStage, bySeverity },
    recurrence,
    waste,
    calibration: {
      joins: Object.fromEntries(Object.entries(joinsByType).map(([t, xs]) => [t, { ...stats(xs), distances: xs }])),
      overshoot: Object.fromEntries(Object.entries(overshootByDuration).map(([d, xs]) => [d, { ...stats(xs), values: xs }])),
      judge: judgeAgreement(runs, policy),
    },
  };
};

const writeAtomic = async (file, text) => {
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
};

export const foldKnowledge = async ({ runsDir, knowledgeDir, policy, audit, reason }) => {
  if (typeof knowledgeDir !== 'string' || !knowledgeDir) throw new Error('E-KB-DIR: foldKnowledge needs the knowledge directory');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('E-KB-REASON: foldKnowledge records why it folded');
  requirePolicy(policy, 'foldKnowledge');
  requireAudit(audit, 'foldKnowledge');
  const index = foldRuns({ runsDir, policy });
  const gates = audit(index);
  const summary = auditSummary(gates);
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const file = path.join(knowledgeDir, INDEX);
  await writeAtomic(file, JSON.stringify(index, null, 1));
  const fold = { at: index.generatedAt, reason, runs: index.totals.runs, findings: index.totals.findings, signatures: index.recurrence.length, policyId: index.policyId, audit: summary };
  await fsp.appendFile(path.join(knowledgeDir, FOLDS), `${JSON.stringify(fold)}\n`);
  return { index, path: file, fold, gates };
};

export const rebuildKnowledge = async ({ runsDir, knowledgeDir, policy, audit }) => {
  if (typeof knowledgeDir !== 'string' || !knowledgeDir) throw new Error('E-KB-DIR: rebuildKnowledge needs the knowledge directory');
  requirePolicy(policy, 'rebuildKnowledge');
  requireAudit(audit, 'rebuildKnowledge');
  const file = path.join(knowledgeDir, INDEX);
  const existed = fs.existsSync(file);
  if (existed) fs.rmSync(file);
  const out = await foldKnowledge({ runsDir, knowledgeDir, policy, audit, reason: existed ? 'rebuild (previous index deleted)' : 'rebuild (no previous index)' });
  return { ...out, deleted: existed };
};

export const readKnowledge = (knowledgeDir) => {
  const file = path.join(knowledgeDir, INDEX);
  if (!fs.existsSync(file)) throw new Error(`E-KB-NO-INDEX: no ${file} — run "bravo kb fold" first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

export const queryKnowledge = ({ knowledgeDir, runsDir, term }) => {
  if (typeof term !== 'string' || !term.trim()) throw new Error('E-KB-QUERY: kb query needs a term (a code, a signature fragment, a rule or rubric id, or a shot id)');
  const index = readKnowledge(knowledgeDir);
  const needle = term.trim().toLowerCase();
  const hit = (v) => String(v || '').toLowerCase().includes(needle);
  const recurrence = index.recurrence.filter((r) => hit(r.signature) || hit(r.code) || hit(r.ruleId) || hit(r.rubricId));
  const rows = listRunDirs(runsDir).flatMap((dir) => readRunDir(dir).findings.map((f) => ({ runId: path.basename(dir), ...f })))
    .filter((f) => hit(f.code) || hit(signatureOf(f)) || hit(f.ruleId) || hit(f.rubricId) || hit(f.shotId) || hit(f.detail));
  return { term, generatedAt: index.generatedAt, recurrence, rows };
};
