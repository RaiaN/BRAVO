import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendIteration, appendNote, insertShot, latchThread, makeBibleEntry, makeProject,
  makeSequence, sequenceById, threadById, appendMessage, shotById, touch,
} from '../../state/project.js';
import { TOOLS, TOOLS_BY_KIND } from '../../agents/tools/index.js';
import { composeGates } from '../../agents/tools/compose.js';
import { requireSkillLine } from '../../utils/film/skills.js';
import { applyDeployModels } from '../../utils/film/suiteConfig.js';
import { parseReply } from '../../agents/protocol.js';
import { route } from '../../agents/router.js';
import { enabledAgents } from '../../agents/registry.js';
import '../../agents/index.js';
import { agentFor } from '../../agents/registry.js';
import { advance } from '../../agents/session.js';

import { gates, assertNoSpend } from './gates.js';
import { installRelativeFetch, serverUp, testClient } from './client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const args = process.argv.slice(2);
const SPEND = args.includes('--spend');
const positional = args.filter((a) => !a.startsWith('--'));
const only = positional[0];
const caseFilter = positional[1] ? new RegExp(positional[1], 'i') : null;

const GATED = ['still', 'shoot', 'edit', 'extend', 'speak'];
const spent = [];

const seedProject = (film = []) => {
  let p = makeProject();
  film.forEach((f) => { p = insertShot(p, { fields: f }).project; });
  const first = p.threads[0];
  const latched = latchThread(p, first.id, 'shot', { subjectId: p.film.shots[0]?.id, title: '' });
  return { project: latched.project, threadId: first.id };
};

const runRouterCase = async (client, c) => {
  const decision = await route({ client, message: c.input, choices: enabledAgents() });
  const fails = [];
  const g = gates.routedOrAsked(decision, enabledAgents().map((a) => a.id));
  if (g) fails.push(g);
  if (c.expect.ask && !decision.ask) fails.push(`should have ASKED, but latched to "${decision.kind}" — a default kind`);
  if (c.expect.kind && decision.kind !== c.expect.kind) fails.push(`expected kind "${c.expect.kind}", got "${decision.kind ?? 'ask'}"`);
  return { fails, detail: decision };
};

const runShotCase = async (client, c) => {
  const { project, threadId } = seedProject(c.film || [{ title: '' }]);
  let p = appendMessage(project, threadId, { role: 'user', text: c.input });
  await advance({ client, threadId, get: () => p, apply: (fn) => { p = fn(p) || p; } });

  const thread = threadById(p, threadId);
  const toolMsgs = thread.messages.filter((m) => m.role === 'tool');
  const used = toolMsgs.map((m) => m.tool.name);
  const prose = thread.messages.filter((m) => m.role === 'agent').map((m) => m.text).join('\n');
  const errored = toolMsgs.filter((m) => m.tool.output?.kind === 'error');

  const fails = [];
  const bad = gates.onlyAllowedTools({ calls: used.filter((n) => n !== 'route').map((tool) => ({ tool })) }, TOOLS_BY_KIND.shot);
  if (bad) fails.push(bad);
  (c.expect.tools || []).forEach((t) => { if (!used.includes(t)) fails.push(`expected a "${t}" call, got: ${used.join(', ') || 'none'}`); });
  (c.expect.noTools || []).forEach((t) => { if (used.includes(t)) fails.push(`must NOT have called "${t}"`); });
  if (c.expect.promptOnlyViaCompose) {
    const wroteAPrompt = toolMsgs.some((m) => m.tool.name === 'write' && m.tool.input?.prompt !== undefined && m.tool.output?.kind !== 'error');
    if (wroteAPrompt) fails.push('violated: a prompt was set through write, outside the bound spec');
  }
  if (c.expect.gatedNotSpent) {
    const gated = toolMsgs.filter((m) => TOOLS[m.tool.name]?.gated);
    if (!gated.length) fails.push('expected a gated call to be attempted');
    const spent = gated.filter((m) => m.tool.approved || m.tool.output);
    if (spent.length) fails.push(`a gated tool ran WITHOUT approval: ${spent.map((m) => m.tool.name).join(', ')}`);
    if (!gated.some((m) => m.tool.card)) fails.push('no approval card was shown before spending');
  }
  if (c.expect.mustSay && !c.expect.mustSay.test(prose)) fails.push(`report never said why it could not: ${JSON.stringify(prose.slice(0, 160))}`);
  if (c.expect.saysInOrder) {
    const at = c.expect.saysInOrder.map((t) => prose.toLowerCase().indexOf(t.toLowerCase()));
    if (at.some((i) => i < 0)) fails.push(`never named ${c.expect.saysInOrder.filter((t, i) => at[i] < 0).join(', ')}`);
    else if (at.some((v, i) => i && v < at[i - 1])) fails.push(`named them out of order: ${JSON.stringify(prose.slice(0, 200))}`);
  }
  if (c.expect.resolvesToNothing) {
    const touched = toolMsgs.some((m) => m.tool.output?.kind === 'shot');
    if (touched) fails.push('violated: an unknown id resolved to a real shot instead of nothing');
    if (!errored.length && !/no shot|does not exist|only \d+/i.test(prose)) fails.push('never reported that the shot does not exist');
  }
  return { fails, detail: { used, prose: prose.slice(0, 400), errors: errored.map((m) => m.tool.output.error) } };
};

const runComposeCase = async (client, c) => {
  let p = makeProject();
  const made = insertShot(p, { fields: { title: c.shot.title, model: c.shot.model, refs: c.shot.refs || [] } });
  p = made.project;
  const r = await TOOLS.compose.run({
    input: { shot: made.shot.id, note: c.note, dialogue: c.dialogue || [] },
    project: p,
    thread: null,
    ctx: { client, requireSkillLine, modelId: null },
  });

  const fails = [];
  const out = r.output;
  if (c.expect.refuses) {
    if (out.kind !== 'error') fails.push(`should have REFUSED, but composed: ${String(out.prompt).slice(0, 120)}`);
    else if (!c.expect.refuses.test(out.error)) fails.push(`refused for the wrong reason: ${out.error}`);
    return { fails, detail: { refused: out.kind === 'error', error: out.error } };
  }
  if (out.kind !== 'prompt') {
    fails.push(`did not compose: ${out.error || out.kind}`);
    return { fails, detail: out };
  }
  const refs = (c.shot.refs || []).length;
  const problems = composeGates(out.prompt, { refCount: refs, dialogue: c.dialogue || [] });
  if (problems.length) fails.push(`saved a prompt that fails its own gates: ${problems.join(' / ')}`);
  if (!shotById(r.project, made.shot.id).prompt) fails.push('the prompt was not saved onto the shot');
  return { fails, detail: { model: out.model, gates: out.gatesPassed, prompt: out.prompt } };
};

const runBibleCase = async (client, c) => {
  let p = makeProject();
  const entry = makeBibleEntry({ name: '', role: 'character', ...(c.entry || {}) });
  p = touch({ ...p, bible: [entry] });
  const threadId = p.threads[0].id;
  p = latchThread(p, threadId, 'bible', { subjectId: entry.id, title: '' }).project;
  for (const u of (c.uploads || [])) p = appendMessage(p, threadId, { role: 'user', text: '', asset: u });
  p = appendMessage(p, threadId, { role: 'user', text: c.input });
  await advance({ client, threadId, get: () => p, apply: (fn) => { p = fn(p) || p; } });

  const t = threadById(p, threadId);
  const toolMsgs = t.messages.filter((m) => m.role === 'tool');
  const used = toolMsgs.map((m) => m.tool.name);
  const prose = t.messages.filter((m) => m.role === 'agent').map((m) => m.text).join('\n');
  const fails = [];

  const bad = gates.onlyAllowedTools({ calls: used.filter((n) => n !== 'route').map((tool) => ({ tool })) }, TOOLS_BY_KIND.bible);
  if (bad) fails.push(bad);
  (c.expect.tools || []).forEach((x) => { if (!used.includes(x)) fails.push(`expected a "${x}" call, got: ${used.join(', ') || 'none'}`); });
  (c.expect.noTools || []).forEach((x) => { if (used.includes(x)) fails.push(`must NOT have called "${x}"`); });
  if (c.expect.mustSay && !c.expect.mustSay.test(prose)) fails.push(`report missing the reason: ${JSON.stringify(prose.slice(0, 160))}`);
  if (c.expect.gatedNotSpent) {
    const gated = toolMsgs.filter((m) => TOOLS[m.tool.name]?.gated);
    if (!gated.length) fails.push('expected a gated call');
    if (gated.some((m) => m.tool.approved || m.tool.output)) fails.push('a gated tool ran without approval');
  }
  if (c.expect.noSpend && toolMsgs.some((m) => TOOLS[m.tool.name]?.gated)) fails.push('spent a render where the upload sufficed');
  if (c.expect.plateBecomesUpload) {
    const e = p.bible[0];
    if (e.plateUrl !== c.uploads[0].url) fails.push(`plateUrl is ${JSON.stringify(e.plateUrl)}, expected the upload`);
  }
  if (c.expect.forbidOk) {
    const wrong = toolMsgs.filter((m) => c.expect.forbidOk.includes(m.tool.name) && m.tool.output?.kind !== 'error');
    if (wrong.length) fails.push(`"${wrong[0].tool.name}" succeeded on input that must be refused`);
  }
  if (c.expect.oneEntryOnly && p.bible.length !== 1) fails.push(`bible now holds ${p.bible.length} entries; a thread owns one artifact`);
  if (c.expect.attachesCurrentPlate) {
    const e = p.bible[0];
    if (!(e.refs || []).some((r) => r.url === (c.entry || {}).plateUrl)) fails.push('the current plate was not attached as a reference — the likeness will re-roll');
  }
  if (c.expect.plateBecomes) {
    const e = p.bible[0];
    if (e.plateUrl !== c.expect.plateBecomes) fails.push(`plateUrl is ${JSON.stringify(e.plateUrl)}, expected the reverted render`);
  }
  if (c.expect.promptStillContains) {
    const miss = c.expect.promptStillContains.filter((frag) => !String(p.bible[0].prompt || '').toLowerCase().includes(frag));
    if (miss.length) fails.push(`refinement dropped earlier decisions: ${miss.join(', ')}`);
  }
  return { fails, detail: { used, prose: prose.slice(0, 300) } };
};

const runDirectorCase = async (client, c) => {
  let p = makeProject();
  const threadId = p.threads[0].id;
  const mod = agentFor('director');
  const made = mod.latch({ project: p, title: '' });
  p = made.project;
  p = latchThread(p, threadId, 'director', { subjectId: made.subjectId, title: '' }).project;
  p = appendMessage(p, threadId, { role: 'user', text: c.input });
  await advance({ client, threadId, get: () => p, apply: (fn) => { p = fn(p) || p; } });

  const t = threadById(p, threadId);
  const toolMsgs = t.messages.filter((m) => m.role === 'tool');
  const used = toolMsgs.map((m) => m.tool.name);
  const prose = t.messages.filter((m) => m.role === 'agent').map((m) => m.text).join('\n');
  const seq = p.sequences[0];
  const fails = [];

  const bad = gates.onlyAllowedTools({ calls: used.filter((n) => n !== 'route').map((tool) => ({ tool })) }, TOOLS_BY_KIND.director);
  if (bad) fails.push(bad);
  (c.expect.tools || []).forEach((x) => { if (!used.includes(x)) fails.push(`expected a "${x}" call, got: ${used.join(', ') || 'none'}`); });
  (c.expect.noTools || []).forEach((x) => { if (used.includes(x)) fails.push(`must NOT have called "${x}"`); });
  if (c.expect.mustSay && !c.expect.mustSay.test(prose)) fails.push(`report missing: ${JSON.stringify(prose.slice(0, 200))}`);
  if (c.expect.asksAbout && !c.expect.asksAbout.test(prose)) fails.push(`never asked about ${c.expect.asksAbout}: ${JSON.stringify(prose.slice(0, 200))}`);
  if (c.expect.briefStaysEmpty && seq.brief) fails.push(`a brief was invented: ${JSON.stringify(seq.brief.logline)}`);
  if (c.expect.planLands) {
    if (!seq.plan) fails.push('no plan landed');
    else {
      const total = seq.plan.shots.reduce((a, b) => a + b.seconds, 0);
      if (total !== seq.brief.targetSeconds) fails.push(`plan sums to ${total}, target ${seq.brief.targetSeconds}`);
      if (seq.plan.shots.some((sh) => !sh.prompt)) fails.push('a plan shot has no prompt');
      if (seq.rulebookVersion == null) fails.push('rulebook version not pinned');
    }
  }
  if (c.expect.sequenceCardPending) {
    const card = toolMsgs.find((m) => m.tool.name === 'sequence' && m.tool.card && !m.tool.approved && !m.tool.output);
    if (!card) fails.push('no pending sequence card');
    else {
      const man = card.tool.card.manifest;
      const total = man.shots.reduce((a, b) => a + b.seconds, 0);
      if (total !== man.targetSeconds) fails.push(`manifest sums to ${total}, target ${man.targetSeconds}`);
      if (man.shots.some((sh) => !sh.prompt)) fails.push('a manifest shot has no prompt');
      if (!card.tool.card.manifestHash) fails.push('manifest not hashed');
      if (seq.status === 'executing' || seq.status === 'assembled') fails.push('the executor ran WITHOUT approval');
    }
  }
  if (c.expect.beatsCovered && seq.plan) {
    const beatIds = new Set(seq.beats.map((b) => b.id));
    const covered = new Set(seq.plan.shots.map((sh) => sh.beatId));
    if (beatIds.size < 3) fails.push(`expected 3 supplied beats, sequence has ${beatIds.size}`);
    for (const b of beatIds) if (!covered.has(b)) fails.push(`beat ${b} uncovered`);
  }
  const toolErrors = toolMsgs.filter((m) => m.tool.output?.kind === 'error').map((m) => `${m.tool.name}: ${m.tool.output.error.slice(0, 160)}`);
  return { fails, detail: { used, status: seq.status, shots: seq.plan?.shots?.length ?? 0, toolErrors, prose } };
};

const runCriticCase = async (client, c) => {
  let p = makeProject();
  const seq = makeSequence({
    brief: { logline: 'A courier crosses a guarded gate.', targetSeconds: 12, format: { fps: 24, audio: true }, world: 'a rain-slicked checkpoint with a wet iron railing', cast: [{ name: 'COURIER', bibleEntryId: 'new' }], locations: [{ name: 'THE GATE', bibleEntryId: 'new' }], dramatis: { protagonist: 'COURIER', want: 'through', opposition: 'THE SENTRY' }, constraints: [], seed: null },
    plan: { slot: 'seedance25', shots: [
      { id: 's1', prompt: 'The courier arrives at the gate.', seconds: 6, setup: 'Wide Establisher', side: 'L', location: 'THE GATE', beatId: 'b1' },
      { id: 's2', prompt: 'The sentry does not move.', seconds: 6, setup: 'Close-Up', side: 'L', location: 'THE GATE', beatId: 'b2' },
    ], plates: [] },
    status: 'assembled',
  });
  p = touch({ ...p, sequences: [seq] });
  p = appendIteration(p, seq.id, { id: 'it1', notes: [], corrections: [], gates: [], measurements: { perShot: [], joins: [{ from: 's1', to: 's2', distance: 21 }], timeline: { totalMeasured: 12.08 } }, cost: { renders: 2 }, status: 'assembled' });
  for (const n of c.notes) p = appendNote(p, seq.id, 'it1', n);

  const threadId = p.threads[0].id;
  p = latchThread(p, threadId, 'critic', { subjectId: seq.id, title: '' }).project;
  p = appendMessage(p, threadId, { role: 'user', text: c.input });
  await advance({ client, threadId, get: () => p, apply: (fn) => { p = fn(p) || p; } });

  const t = threadById(p, threadId);
  const toolMsgs = t.messages.filter((m) => m.role === 'tool');
  const used = toolMsgs.map((m) => m.tool.name);
  const prose = t.messages.filter((m) => m.role === 'agent').map((m) => m.text).join('\n');
  const q = sequenceById(p, seq.id);
  const it = q.iterations[0];
  const fails = [];

  const bad = gates.onlyAllowedTools({ calls: used.filter((n) => n !== 'route').map((tool) => ({ tool })) }, TOOLS_BY_KIND.critic);
  if (bad) fails.push(bad);
  if (c.expect.mustSay && !c.expect.mustSay.test(prose)) fails.push(`report missing: ${JSON.stringify(prose.slice(0, 200))}`);
  if (c.expect.patchTouches) {
    const cor = it.corrections.find((x) => x.kind === 'patch');
    if (!cor) fails.push('no patch correction');
    else if (!cor.patch.some((ch) => ch.path === c.expect.patchTouches)) fails.push(`patch touched ${cor.patch.map((ch) => ch.path).join(', ')}, expected ${c.expect.patchTouches}`);
  }
  if (c.expect.patchMade && !it.corrections.some((x) => x.kind === 'patch')) fails.push('no patch correction');
  if (c.expect.proposalMade) {
    const cor = it.corrections.find((x) => x.kind === 'ruleProposal');
    if (!cor) fails.push('no rule proposal');
    else {
      if (cor.proposal.blocking) fails.push('a proposal arrived blocking');
      if (cor.proposal.provenance?.origin !== 'note') fails.push('proposal lost its provenance');
    }
  }
  if (c.expect.regressionMade && !it.corrections.some((x) => x.kind === 'regression')) fails.push('no regression case');
  if (c.expect.notesDisposed) {
    const disp = it.notes.map((n) => n.disposition);
    for (const d of c.expect.notesDisposed) if (!disp.includes(d)) fails.push(`no note disposed as ${d}: ${disp.join(', ')}`);
  }
  if (c.expect.asksOnly) {
    if (it.corrections.length) fails.push(`corrections were invented from a vague note: ${it.corrections.map((x) => x.kind).join(', ')}`);
    if (!/\?/.test(prose) && !/what|which|tell me|clarif|specif/i.test(prose)) fails.push(`never asked: ${JSON.stringify(prose.slice(0, 160))}`);
  }
  if (c.expect.lawUntouched) {
    const cor = it.corrections.find((x) => x.kind === 'patch');
    if (cor && cor.patch.some((ch) => /tolerance|theta|rule|gate/i.test(ch.path))) fails.push('LAW WAS TOUCHED');
    if (q.plan.shots.some((sh) => sh.seconds !== 6)) fails.push('plan seconds were quietly changed');
  }
  const toolErrors = toolMsgs.filter((m) => m.tool.output?.kind === 'error').map((m) => `${m.tool.name}: ${m.tool.output.error.slice(0, 140)}`);
  return { fails, detail: { used, corrections: it.corrections.map((x) => x.kind), dispositions: it.notes.map((n) => n.disposition), toolErrors, prose: prose.slice(0, 240) } };
};

const main = async () => {
  const client = testClient({
    onCall: ({ tool }) => { if (GATED.includes(tool)) spent.push(tool); },
  });

  if (!(await serverUp(client.base))) {
    console.error(`\nNo BRAVO server at ${client.base}.\n  Start one:  PORT=3210 npm run dev\n  Or point at another:  BRAVO_TEST_URL=http://localhost:3000 npm run test:agents\n`);
    process.exit(2);
  }

  installRelativeFetch(client.base);

  try {
    const cfg = await (await fetch(`${client.base}/api/film/config`)).json();
    if (cfg?.models) applyDeployModels(cfg.models);
  } catch { }

  const suites = [
    { dir: 'router', run: runRouterCase },
    { dir: 'shot', run: runShotCase },
    { dir: 'compose', run: runComposeCase },
    { dir: 'bible', run: runBibleCase },
    { dir: 'director', run: runDirectorCase },
    { dir: 'critic', run: runCriticCase },
  ].filter((s) => !only || s.dir === only);

  let pass = 0;
  let fail = 0;
  const lines = [`# Agent run — ${new Date().toISOString()}`, '', `server: ${client.base} · spending: ${SPEND ? 'YES' : 'stubbed'}`, ''];

  for (const suite of suites) {
    const mod = await import(path.join(ROOT, 'tests/agents', suite.dir, 'cases.js'));
    if (mod.cases.length < 5) {
      console.error(`✗ ${suite.dir}: only ${mod.cases.length} cases — the rule is at least five`);
      fail += 1;
      continue;
    }
    console.log(`\n${suite.dir} · ${mod.cases.length} cases`);
    lines.push(`## ${suite.dir}`, '');

    for (const c of mod.cases.filter((cc) => !caseFilter || caseFilter.test(cc.name))) {
      let result;
      try {
        result = await suite.run(client, c);
      } catch (err) {
        result = { fails: [`threw: ${err.message}`], detail: {} };
      }
      const ok = result.fails.length === 0;
      ok ? (pass += 1) : (fail += 1);
      console.log(`  ${ok ? '✓' : '✗'} ${c.name}`);
      result.fails.forEach((f) => console.log(`      ${f}`));
      lines.push(`### ${ok ? '✓' : '✗'} ${c.name}`, '',
        `**input:** ${c.input || c.note}`, '', `**why this case exists:** ${c.why}`, '',
        '```json', JSON.stringify(result.detail, null, 1), '```', '',
        ...(ok ? [] : ['**failed:**', ...result.fails.map((f) => `- ${f}`), '']),
      );
    }
  }

  const leak = SPEND ? null : assertNoSpend(spent);
  if (leak) { console.error(`\n✗ ${leak}`); fail += 1; }

  fs.mkdirSync(path.join(ROOT, 'tests/reports'), { recursive: true });
  const report = path.join(ROOT, 'tests/reports', `agents-${Date.now()}.md`);
  fs.writeFileSync(report, lines.join('\n'));

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`report: ${path.relative(ROOT, report)}`);
  process.exit(fail ? 1 : 0);
};

main();
