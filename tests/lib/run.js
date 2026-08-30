// THE AGENT RUNNER — layer 2 of docs/TESTING.md.
//
// Each case goes through the REAL loop against the real reasoner. Assertions are
// structural, never wording: a differently-phrased report is not a regression, a call to
// a tool the agent does not hold is. Prompt quality goes into the report for a person to
// judge — no machine check will tell you a prompt is good.
//
// node tests/lib/run.js              gated tools stubbed, nothing spent
// node tests/lib/run.js --spend      actually renders
// node tests/lib/run.js router       one agent only

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertShot, latchThread, makeProject, threadById, appendMessage, shotById } from '../../state/project.js';
import { TOOLS, TOOLS_BY_KIND } from '../../agents/tools/index.js';
import { composeGates } from '../../agents/tools/compose.js';
import { requireSkillLine } from '../../utils/film/skills.js';
import { applyDeployModels } from '../../utils/film/suiteConfig.js';
import { parseReply } from '../../agents/protocol.js';
import { route } from '../../agents/router.js';
import { enabledAgents } from '../../agents/registry.js';
import '../../agents/index.js';                       // registers the roster
import { advance } from '../../agents/session.js';

import { gates, assertNoSpend } from './gates.js';
import { installRelativeFetch, serverUp, testClient } from './client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const args = process.argv.slice(2);
const SPEND = args.includes('--spend');
const only = args.find((a) => !a.startsWith('--'));

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
  // The loop now reads and mutates through get/apply so concurrent agents cannot clobber
  // one another; the harness supplies the same two functions.
  let p = appendMessage(project, threadId, { role: 'user', text: c.input });
  await advance({ client, threadId, get: () => p, apply: (fn) => { p = fn(p) || p; } });

  const thread = threadById(p, threadId);
  const toolMsgs = thread.messages.filter((m) => m.role === 'tool');
  const used = toolMsgs.map((m) => m.tool.name);
  const prose = thread.messages.filter((m) => m.role === 'agent').map((m) => m.text).join('\n');
  const errored = toolMsgs.filter((m) => m.tool.output?.kind === 'error');

  const fails = [];
  // row for this kind — not a frozen copy of what it held in Phase A.
  const bad = gates.onlyAllowedTools({ calls: used.filter((n) => n !== 'route').map((tool) => ({ tool })) }, TOOLS_BY_KIND.shot);
  if (bad) fails.push(bad);
  (c.expect.tools || []).forEach((t) => { if (!used.includes(t)) fails.push(`expected a "${t}" call, got: ${used.join(', ') || 'none'}`); });
  (c.expect.noTools || []).forEach((t) => { if (used.includes(t)) fails.push(`must NOT have called "${t}"`); });
  // A gated call must produce a CARD and spend nothing until a person approves it.
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
  // The gates again, from outside the tool — proving they held, not that they ran.
  const refs = (c.shot.refs || []).length;
  const problems = composeGates(out.prompt, { refCount: refs, dialogue: c.dialogue || [] });
  if (problems.length) fails.push(`saved a prompt that fails its own gates: ${problems.join(' / ')}`);
  if (!shotById(r.project, made.shot.id).prompt) fails.push('the prompt was not saved onto the shot');
  return { fails, detail: { model: out.model, gates: out.gatesPassed, prompt: out.prompt } };
};

const main = async () => {
  const client = testClient({
    onCall: ({ tool }) => { if (GATED.includes(tool)) spent.push(tool); },
  });

  if (!(await serverUp(client.base))) {
    console.error(`\nNo BRAVO server at ${client.base}.\n  Start one:  PORT=3210 npm run dev\n  Or point at another:  BRAVO_TEST_URL=http://localhost:3000 npm run test:agents\n`);
    process.exit(2);
  }

  // Give the kit's browser-shaped code an origin before anything calls it.
  installRelativeFetch(client.base);

  // The browser hydrates the model table from this route on boot; Node must too, or every
  // slot looks unconfigured and the wrong skill binds.
  try {
    const cfg = await (await fetch(`${client.base}/api/film/config`)).json();
    if (cfg?.models) applyDeployModels(cfg.models);
  } catch { /* reported by serverUp above */ }

  const suites = [
    { dir: 'router', run: runRouterCase },
    { dir: 'shot', run: runShotCase },
    { dir: 'compose', run: runComposeCase },
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

    for (const c of mod.cases) {
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
