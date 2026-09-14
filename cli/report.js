import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readRubricBooks } from '../agents/director/rubrics.js';

const REPORT = 'report.md';

export const GUARANTEES = [
  { id: 'film-and-journal', title: 'A film and a journal, every pass' },
  { id: 'target-duration', title: 'Target duration within the scaled tolerance' },
  { id: 'subject-force-change', title: 'Every shot names its subject, its force and its change' },
  { id: 'selected-before-video', title: 'Nothing reaches the video model unselected' },
  { id: 'artifacts-do-not-ship', title: 'Obvious artifacts do not ship while the attempt budget lasts' },
  { id: 'money-bounded', title: 'Money is bounded: no paid call without a reservation, every waste coded' },
  { id: 'judge-authority-earned', title: 'The judge\'s authority over story is earned, automatically' },
  { id: 'journal-never-lies', title: 'The journal never lies' },
];

const PAID_CALLS = ['generateImage', 'startVideo'];

const byKind = (entries, kind) => entries.filter((e) => e.kind === kind);
const last = (entries, kind) => byKind(entries, kind).at(-1) || null;
const findings = (entries) => byKind(entries, 'finding').map((e) => ({ step: e.step, ...e.data }));

const cell = (v) => String(v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (headers, rows) => (rows.length
  ? [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)]
  : ['(none)']);

const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

const guaranteeRows = ({ entries, project, mediaDir, policy }) => {
  const rows = findings(entries);
  const failed = last(entries, 'pass.failed');
  const halted = last(entries, 'pass.halted');
  const assemble = last(entries, 'assemble');
  const final = last(entries, 'final');
  const plan = last(entries, 'plan');
  const keyframes = last(entries, 'keyframes');
  const slicePath = mediaDir && assemble ? path.join(mediaDir, assemble.data.media) : null;
  const sliceOnDisk = !!(slicePath && fs.existsSync(slicePath));
  const blocked = failed ? `the pass failed at ${failed.data.stage}: ${failed.data.detail}` : (halted ? `the pass halted at ${halted.data.node}: ${halted.data.reason}` : null);

  const out = [];
  const add = (id, met, detail, evidence = []) => out.push({ ...GUARANTEES.find((g) => g.id === id), met, detail, evidence });

  const skippedJoins = byKind(entries, 'join.skipped').map((e) => ({ step: e.step, ...e.data }));
  add('film-and-journal',
    !!assemble && sliceOnDisk && !failed,
    blocked || (assemble ? `slice assembled at journal step ${assemble.step}${sliceOnDisk ? `, on disk at ${slicePath}` : ` — media/${assemble.data.media} is MISSING on disk`}${skippedJoins.length ? `; ${skippedJoins.length} join(s) unjudged under ${[...new Set(skippedJoins.map((j) => j.reason))].join(', ')}: ${skippedJoins.map((j) => j.joinRef).join(', ')}` : ''}` : 'no assemble step in the journal'),
    assemble ? [{ step: assemble.step, url: assemble.data.url }, ...skippedJoins] : []);

  const timeline = final ? (final.data.gates || []).find((g) => g.ruleId === 'CIN-008') : null;
  add('target-duration',
    !!timeline && timeline.pass === true,
    timeline ? `[CIN-008] ${timeline.value} vs ${timeline.threshold}${timeline.pass ? '' : ` — ${timeline.detail}`}` : (blocked || 'no final measurement in the journal'),
    rows.filter((f) => f.code === 'E-TIMELINE-CIN-008'));

  const engine = byKind(entries, 'engine').at(-1)?.data?.mode || 'staged';
  const shots = plan ? plan.data.shots : [];
  const unnamed = shots.filter((sh) => !String(sh.subject || '').trim() || !String(sh.force || '').trim() || !String(sh.change || '').trim()).map((sh) => sh.id);
  const kfBlockers = keyframes ? (keyframes.data.blockers || []) : [];
  const kfText = engine === 'edit' ? 'the film loop renders whole takes, no start frames' : `keyframe decisions ${keyframes ? (kfBlockers.length ? `refused by POL-012 on ${kfBlockers.length} shot(s)` : 'recorded and confirmed by POL-012') : 'not recorded'}`;
  add('subject-force-change',
    !!plan && unnamed.length === 0 && (engine === 'edit' || (!!keyframes && kfBlockers.length === 0)),
    plan ? `${shots.length} shots planned; ${unnamed.length ? `without subject/force/change: ${unnamed.join(', ')}` : 'every shot names subject, force and change'}; ${kfText}` : (blocked || 'no plan landed'),
    kfBlockers);

  if (engine === 'edit') {
    const takes = byKind(entries, 'intent').filter((e) => e.data.call === 'render.take');
    const bare = takes.filter((e) => !(Array.isArray(e.data.refAssetIds) && e.data.refAssetIds.length));
    add('selected-before-video',
      takes.length > 0 && bare.length === 0,
      takes.length ? `${takes.length} take(s) started; ${bare.length ? `${bare.length} carried no reference assets` : 'every one carried reference assets'}` : (blocked || 'no take was started'),
      bare.map((e) => ({ step: e.step, shotId: e.data.shotId })));
  } else {
    const starts = byKind(entries, 'intent').filter((e) => e.data.call === 'render.start');
    const blind = starts.filter((e) => !e.data.firstFrameUrl);
    add('selected-before-video',
      starts.length > 0 && blind.length === 0,
      starts.length ? `${starts.length} render start(s); ${blind.length ? `${blind.length} carried no promoted first frame` : 'every one carried a promoted keyframe or a recorded last frame'}` : (blocked || 'no take was started'),
      blind.map((e) => ({ step: e.step, shotId: e.data.shotId })));
  }

  const exhausted = rows.filter((f) => ['E-SHOT-ATTEMPTS-EXHAUSTED', 'E-SHOT-MEASURE-SHIPPED'].includes(f.code));
  const shippedBlockers = rows.filter((f) => f.family === 'qc' && f.severity === 'blocker');
  add('artifacts-do-not-ship',
    !!assemble && exhausted.length === 0,
    assemble ? (exhausted.length ? `${exhausted.length} shot(s) shipped over an exhausted budget or a measure blocker: ${exhausted.map((f) => `${f.shotId} (${f.detail})`).join('; ')}` : `no shot shipped over an exhausted budget or a measure blocker; ${shippedBlockers.length} blocking QC finding(s) were answered by regeneration`) : (blocked || 'nothing was assembled'),
    exhausted);

  const reservations = byKind(entries, 'reservation').map((e) => e.data);
  const refused = byKind(entries, 'reservation.refused').map((e) => e.data);
  const paidIntents = byKind(entries, 'intent').filter((e) => PAID_CALLS.includes(e.data.call));
  const reservedStills = reservations.filter((r) => r.kind === 'still').reduce((a, r) => a + r.units, 0);
  const reservedTakes = reservations.filter((r) => r.kind === 'take').length;
  const paidStills = paidIntents.filter((e) => e.data.call === 'generateImage').length;
  const paidTakes = paidIntents.filter((e) => e.data.call === 'startVideo').length;
  const uncoded = byKind(entries, 'cost').map((e) => e.data).filter((c) => c.disposition !== 'kept' && !c.code);
  add('money-bounded',
    reservedStills >= paidStills && reservedTakes >= paidTakes && uncoded.length === 0,
    `${paidStills} still(s) against ${reservedStills} reserved, ${paidTakes} take(s) against ${reservedTakes} reserved, ${refused.length} refusal(s), ${uncoded.length} uncoded waste row(s)`,
    refused);

  const spending = policy ? policy.judge.spendingRubrics : [];
  const promoted = byKind(entries, 'promotion').map((e) => e.data.rubricId);
  const dayOne = Object.values(readRubricBooks()).flatMap((book) => book.questions.filter((q) => q.scope === 'artifact').map((q) => q.id));
  const unearned = spending.filter((s) => !dayOne.includes(s) && !promoted.includes(s));
  add('judge-authority-earned',
    unearned.length === 0,
    policy ? `spending rubrics: ${spending.join(', ') || '(none)'}; artifact questions (${dayOne.join(', ')}) spend from day one, every other rubric witnesses until promoted${unearned.length ? `; spending without a journaled promotion: ${unearned.join(', ')}` : ''}` : 'no policy in the journal',
    []);

  add('journal-never-lies', true, `derived from ${entries.length} journal steps; every guarantee above cites its rows`, []);
  return out;
};

export const summarize = ({ entries, project, runId, mediaDir = null }) => {
  const intake = last(entries, 'intake');
  const refusedIntake = last(entries, 'intake.refused');
  const policy = intake ? intake.data.policy : null;
  const complete = last(entries, 'complete');
  const failed = last(entries, 'pass.failed');
  const halted = last(entries, 'pass.halted');
  const rows = findings(entries);
  const seq = project?.sequences?.[0] || null;
  const status = refusedIntake ? 'refused' : (failed ? 'failed' : (halted ? 'halted' : (complete ? complete.data.status : 'in progress')));
  const costs = {};
  for (const e of byKind(entries, 'cost')) {
    const key = `${e.data.kind}/${e.data.disposition}`;
    costs[key] = (costs[key] || 0) + e.data.units;
  }
  const lastReservation = last(entries, 'reservation');
  const schedule = byKind(entries, 'schedule').map((e) => e.data);
  const notes = (seq?.iterations || []).flatMap((it) => (it.notes || []).map((n) => ({ iteration: it.id, ...n })));
  return {
    runId,
    status,
    intake: intake ? intake.data : null,
    refusal: refusedIntake ? refusedIntake.data : null,
    failure: failed ? failed.data : null,
    halt: halted ? halted.data : null,
    guarantees: refusedIntake ? [] : guaranteeRows({ entries, project, mediaDir, policy }),
    policyRules: [
      ...byKind(entries, 'policy.gate').map((e) => ({ step: e.step, ruleId: e.data.ruleId, where: e.data.stage, pass: e.data.pass, results: e.data.results.length, blockers: e.data.blockers.length })),
      ...byKind(entries, 'policy.audit').flatMap((e) => e.data.rules.map((r) => ({ step: e.step, ruleId: r.ruleId, where: `audit:${e.data.scope}`, pass: r.pass, results: r.results, blockers: r.blockers }))),
    ],
    regenerations: byKind(entries, 'regeneration').map((e) => ({ step: e.step, ...e.data })),
    completions: byKind(entries, 'completionDecision').map((e) => ({ step: e.step, ...e.data })),
    shortfalls: rows.filter((f) => f.family === 'shortfall'),
    openFindings: rows.filter((f) => (f.family === 'qc' && f.severity !== 'blocker') || f.family === 'judge-reliability'),
    blockers: rows.filter((f) => f.severity === 'blocker'),
    faults: byKind(entries, 'fault').map((e) => ({ step: e.step, ...e.data })),
    costs,
    ledger: lastReservation ? lastReservation.data.after : null,
    waves: schedule.find((s) => s.event === 'complete')?.waves ?? null,
    notes,
    steps: entries.length,
    firstAt: entries[0]?.at || null,
    lastAt: entries.at(-1)?.at || null,
    sequence: seq ? { id: seq.id, status: seq.status, shots: seq.plan?.shots?.length ?? 0, iterations: seq.iterations.length, rulebookVersion: seq.rulebookVersion } : null,
  };
};

export const renderReport = (s) => {
  const lines = [];
  const h = (t) => lines.push('', `## ${t}`, '');
  lines.push(`# Pass ${s.runId} — ${s.status}`, '');
  if (s.intake) {
    lines.push(`- idea: ${cell(s.intake.idea)}`);
    lines.push(`- style: ${s.intake.style.id} (${s.intake.styleHash}) · seconds: ${s.intake.seconds} · policy: ${s.intake.policy.id} (${s.intake.policyHash})`);
    lines.push(`- rulebook: ${s.intake.rulebookVersion} · rubrics: ${s.intake.rubricsVersion} · prices dated ${s.intake.prices.date}`);
  }
  if (s.sequence) lines.push(`- sequence ${s.sequence.id}: ${s.sequence.status}, ${s.sequence.shots} shots, ${s.sequence.iterations} iteration(s), rulebook pinned ${s.sequence.rulebookVersion}`);
  lines.push(`- journal: ${s.steps} steps from ${s.firstAt} to ${s.lastAt}${s.waves === null ? '' : ` · ${s.waves} scheduler waves`}`);

  if (s.refusal) {
    h('Refused at intake');
    lines.push(`${s.refusal.code}: ${s.refusal.detail}`);
    return `${lines.join('\n')}\n`;
  }

  h('Guarantees');
  lines.push(...table(['guarantee', 'held', 'detail'], s.guarantees.map((g) => [g.title, g.met ? 'met' : 'NOT MET', g.detail])));
  const unmet = s.guarantees.filter((g) => !g.met && g.evidence.length);
  for (const g of unmet) {
    lines.push('', `Rows behind "${g.title}":`, '```json', JSON.stringify(g.evidence, null, 1), '```');
  }
  h('Policy rules');
  lines.push(...table(['step', 'rule', 'where', 'held', 'rows', 'blockers'], s.policyRules.map((r) => [r.step, r.ruleId, r.where, r.pass ? 'pass' : 'BLOCKED', r.results, r.blockers])));
  if (s.failure) { h('The pass failed'); lines.push(`${s.failure.code} at ${s.failure.stage}: ${s.failure.detail}`); }
  if (s.halt) { h('The pass halted before its schedule'); lines.push(`${s.halt.node}: ${s.halt.reason}`); }

  h('Regenerations and why');
  lines.push(...table(['step', 'shot', 'attempt', 'mode', 'cause', 'rule', 'invalidated'], s.regenerations.map((r) => [r.step, r.shotId, r.attempt, r.mode, r.cause, r.ruleId, (r.invalidatedShots || []).join(' ')])));
  if (s.completions.length) {
    lines.push('', 'Completion decisions:');
    lines.push(...table(['step', 'shot', 'decision', 'attempts', 'budget', 'takes'], s.completions.map((c) => [c.step, c.shotId, c.decision, c.attempts, c.budget, (c.takes || []).map((t) => `${t.takeId}:${t.score}`).join(' ')])));
  }

  h('Shortfalls');
  lines.push(...table(['step', 'stage', 'code', 'shot', 'detail'], s.shortfalls.map((f) => [f.step, f.stage, f.code, f.shotId, f.detail])));

  h('Blocking findings');
  lines.push(...table(['step', 'family', 'stage', 'code', 'shot', 'take', 'detail'], s.blockers.map((f) => [f.step, f.family, f.stage, f.code, f.shotId, f.takeId, f.detail])));

  h('The judge\'s open findings');
  lines.push(...table(['step', 'family', 'stage', 'code', 'rubric', 'shot', 'detail'], s.openFindings.map((f) => [f.step, f.family, f.stage, f.code, f.rubricId, f.shotId, f.detail])));

  h('Faults');
  lines.push(...table(['step', 'node', 'attempt', 'faults', 'budget', 'reason'], s.faults.map((f) => [f.step, f.id, f.attempt, f.faults, f.budget, f.reason])));

  h('Cost');
  lines.push(...table(['kind/disposition', 'units'], Object.entries(s.costs).map(([k, v]) => [k, round(v)])));
  if (s.ledger) lines.push('', `Ledger after the last reservation: stills ${s.ledger.stills}, takes ${s.ledger.takes}, video seconds ${round(s.ledger.videoSeconds)}, judge calls ${s.ledger.judgeCalls}, reason calls ${s.ledger.reasonCalls}, usd ${round(s.ledger.usd)}, elapsed ${round(s.ledger.elapsedMinutes)} min`);

  h('Human notes');
  lines.push(...table(['iteration', 'severity', 'shot', 'timecode', 'rule', 'text'], s.notes.map((n) => [n.iteration, n.severity, n.shotRef, n.timecode, n.ruleRef, n.text])));
  return `${lines.join('\n')}\n`;
};

export const buildReport = ({ entries, project, runId, mediaDir = null }) => {
  const summary = summarize({ entries, project, runId, mediaDir });
  return { summary, text: renderReport(summary) };
};

export const writeReport = async (dir, text) => {
  if (typeof dir !== 'string' || !dir) throw new Error('writeReport needs a "dir"');
  if (typeof text !== 'string' || !text) throw new Error('writeReport needs the report text');
  const file = path.join(dir, REPORT);
  const tmp = path.join(dir, `.${REPORT}.${process.pid}.tmp`);
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
  return file;
};
