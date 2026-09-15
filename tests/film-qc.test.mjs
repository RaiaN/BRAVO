import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFilmQC, FILM_QC_AGENTS } from '../agents/film-qc.js';
import { DEFAULT_PERSONA, withPersonaDefaults, problemsIn } from '../agents/persona.js';
import { openJournal, journaledClient } from '../agents/journal.js';
import { runChain } from '../agents/chain.js';
import { applyDeployModels } from '../utils/film/suiteConfig.js';
import { summarize } from '../pages/api/extend.js';
import { DEFAULT_AGENT_CONFIG } from '../agents/config.js';

const inspection = {
  score: 8, summary: 'Readable action with a focus slip.', strengths: ['Clear performance'],
  limitations: ['Previous shot is not attached'], findings: [
    { id: 'f1', category: 'focus', severity: 'minor', timecode: 3, evidence: 'Eyes soften during the turn', impact: 'Expression is less readable' },
  ],
};
const receipt = {
  title: 'Preserve the turn, maintain focus', summary: 'Keep eyes in focus through the action',
  preserve: ['Performance and blocking'], limitations: ['Re-render needs verification'],
  actions: [{ priority: 1, findingIds: ['f1'], department: 'prompt', change: 'Track focus through the turn', rationale: 'Preserves the expression at 3s', risk: 'Background may become sharper', verify: 'Eyes remain sharp across the turn' }],
  revisedPrompt: 'A person turns toward the window; track focus on their eyes.',
};
const options = {
  shot: { id: 's1', seconds: 20, prompt: 'A person turns toward the window.' },
  take: { taskId: 'take1', variant: 2, file: 'shot-s1-attempt1-v2.mov', providerUrl: 'https://video.example/take1.mov', prompt: 'Track the turn.' },
  previous: null, idea: 'A quiet realization.', logline: 'A person recognizes a new possibility.',
  style: { audio: false, look: { style: 'naturalistic' } }, persona: DEFAULT_PERSONA,
};
const selectionFor = (takeId = 'take1') => ({
  receiptId: `s1:${takeId}:director`, reason: 'Best preservation of performance with a feasible focus correction.',
  comparisons: FILM_QC_AGENTS.map((agent) => ({ receiptId: `s1:${takeId}:${agent.id}`, assessment: `Considered ${agent.name}'s feasibility and preservation of the take.` })),
});
const answer = (value) => ({ content: JSON.stringify(value), metadata: { model: 'test-seed-pro', usage: { total_tokens: 20 } } });
const normalResponse = (args) => answer(args.stage === 'inspect' ? inspection : args.stage === 'receipt' ? receipt : selectionFor(args.takeId));

const fixture = async (fn) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bravo-film-qc-'));
  const journal = await openJournal({ dir });
  try { await fn(journal, dir); } finally {
    await journal.close();
    await rm(dir, { recursive: true, force: true });
  }
};

test('five independent branches overlap; Persona sees all receipts only after they finish; logs survive on disk', async () => {
  await fixture(async (journal, dir) => {
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const requests = [];
    let inspectors = 0;
    let finishedReceipts = 0;
    const client = journaledClient(journal, {
      async reason(args) {
        requests.push(args);
        if (args.stage === 'inspect') {
          inspectors += 1;
          if (inspectors === 5) release();
          await barrier;
          assert.equal(args.video, options.take.providerUrl);
          assert.equal(args.reasoningEffort, 'high');
          assert.ok(!args.prompt.includes('YOUR VIDEO INSPECTION:'));
        } else if (args.stage === 'receipt') {
          assert.equal(args.video, undefined);
          assert.ok(args.prompt.includes('YOUR VIDEO INSPECTION:'));
          assert.ok(!args.prompt.includes('receiptId'));
          finishedReceipts += 1;
        } else {
          assert.equal(args.agentId, 'persona');
          assert.equal(finishedReceipts, 5);
          assert.equal(args.systemPrompt, DEFAULT_PERSONA.system);
          for (const agent of FILM_QC_AGENTS) assert.ok(args.prompt.includes(`s1:take1:${agent.id}`));
        }
        return normalResponse(args);
      },
    });
    const out = await runFilmQC({ ...options, journal, client });
    assert.equal(requests.length, 11);
    assert.equal(out.receipts.length, 5);
    assert.equal(out.selectedReceipt.agentId, 'director');
    const rows = (await readFile(path.join(dir, 'journal.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map((r) => r.step), rows.map((_, i) => i + 1));
    assert.equal(rows.filter((r) => r.kind === 'intent').length, 11);
    assert.equal(rows.filter((r) => r.kind === 'result').length, 11);
    assert.equal(rows.filter((r) => r.kind === 'qc.receipt').length, 5);
    assert.equal(rows.at(-1).kind, 'qc.complete');
    assert.ok(rows.find((r) => r.kind === 'result').data.metadata.usage);
    assert.ok(rows.find((r) => r.kind === 'intent').data.systemPrompt);
  });
});

test('malformed output is logged, then only its failing stage is retried', async () => {
  await fixture(async (journal) => {
    const calls = [];
    const client = { async reason(args) {
      calls.push(args);
      if (args.agentId === 'vfx' && args.stage === 'receipt' && args.attempt === 1) return { content: '{bad-json' };
      return normalResponse(args);
    } };
    await runFilmQC({ ...options, journal, client });
    assert.equal(calls.filter((c) => c.stage === 'inspect').length, 5);
    assert.equal(calls.filter((c) => c.stage === 'receipt').length, 6);
    assert.equal(journal.entries('qc.response').filter((r) => r.data.response === '{bad-json').length, 1);
    assert.ok(calls.find((c) => c.agentId === 'vfx' && c.attempt === 2).prompt.includes('Your last attempt failed'));
  });
});

test('permanent agent failure waits for peers, records successes, and prevents Persona selection', async () => {
  await fixture(async (journal) => {
    let failures = 0;
    const client = journaledClient(journal, { async reason(args) {
      assert.notEqual(args.stage, 'persona-selection');
      if (args.agentId === 'sound') { failures += 1; throw new Error('Provider unavailable'); }
      return normalResponse(args);
    } });
    await assert.rejects(runFilmQC({ ...options, journal, client }), /all five receipts are required/);
    assert.equal(failures, 3);
    assert.equal(journal.entries('qc.receipt').length, 4);
    assert.equal(journal.entries('persona.receipt-choice').length, 0);
    assert.equal(journal.entries('qc.failed').length, 1);
    assert.equal(journal.entries('intent').length, journal.entries('result').length);
  });
});

test('Persona cannot invent a receipt or omit comparisons', async () => {
  await fixture(async (journal) => {
    const client = { async reason(args) {
      if (args.stage === 'persona-selection') return answer({ ...selectionFor(), receiptId: 'invented' });
      return normalResponse(args);
    } };
    await assert.rejects(runFilmQC({ ...options, journal, client }), /persona-selection failed after 3 attempts/);
    assert.equal(journal.entries('persona.receipt-choice').length, 0);
    assert.equal(journal.entries('qc.failed')[0].data.failures[0].agentId, 'persona');
    assert.equal(journal.entries('qc.receipt').length, 5);
  });
});

test('legacy Persona customization survives the new receipt stage', () => {
  const legacy = { system: 'Custom director', review: DEFAULT_PERSONA.review, choice: DEFAULT_PERSONA.choice };
  const persona = withPersonaDefaults(legacy);
  assert.equal(persona.system, legacy.system);
  assert.equal(persona.receiptChoice, DEFAULT_PERSONA.receiptChoice);
  assert.deepEqual(problemsIn(persona), []);
  assert.ok(problemsIn({ ...persona, receiptChoice: '{unknown}' }).length > 0);
});

test('chain completes QC before assembly, keeps chosen footage, and exposes receipts in progress API', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bravo-chain-'));
  const runId = 'test_run';
  const journal = await openJournal({ dir: path.join(root, 'runs', runId) });
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd();
  let renderCalls = 0;
  applyDeployModels({ reasoner: 'test-seed-pro', seedance25: 'test-seedance' });
  try {
    globalThis.fetch = async (url) => {
      if (url === '/api/seedance') { renderCalls += 1; return Response.json({ id: 'take1' }); }
      if (url === '/api/film/upload') return Response.json({ assetId: 'asset1', url: 'https://video.example/take1.mov' });
      if (url === '/api/film/stitch') {
        assert.equal(journal.entries('qc.complete').length, 1);
        return Response.json({ url: 'https://video.example/slice.mp4' });
      }
      if (url === '/api/film/measure') return Response.json({ duration: 20, fps: 24 });
      if (String(url).startsWith('https://video.example/')) return new Response(new Uint8Array([1, 2, 3]));
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const client = {
      async reason(args) {
        assert.equal(args.modelId, 'test-seed-pro');
        assert.equal(args.reasoningEffort, 'high');
        if (['inspect', 'receipt', 'persona-selection'].includes(args.stage)) return normalResponse(args);
        if (args.systemPrompt.startsWith('You plan')) return answer({ logline: options.logline, shots: [options.shot] });
        if (args.systemPrompt.startsWith('You rewrite')) return answer({ prompts: [options.take.prompt] });
        if (args.video) return answer({ score: 8, notes: 'A good take.' });
        return answer({ variant: 1, reason: 'This take serves the film.' });
      },
      async pollVideo() { return { videoUrl: options.take.providerUrl }; },
    };
    const out = await runChain({ idea: options.idea, seconds: 20, style: { ...options.style, format: { resolution: '1080p', ratio: '16:9' } }, client, journal, runId, persona: DEFAULT_PERSONA, candidates: 1, backoffMs: 0 });
    assert.equal(renderCalls, 1);
    assert.equal(out.shots[0].url, options.take.providerUrl);
    assert.equal(out.shots[0].filmQC.receipts.length, 5);
    const choiceStep = journal.entries('persona.choice')[0].step;
    assert.ok(choiceStep < journal.entries('qc.started')[0].step);
    assert.equal(journal.entries('intent').length, journal.entries('result').length);
    assert.deepEqual(journal.entries('agents.config')[0].data.config, DEFAULT_AGENT_CONFIG);
    for (const request of journal.entries('intent').filter((r) => r.data.call === 'reason')) {
      assert.ok(request.data.agentId);
      assert.ok(request.data.stage);
    }
    process.chdir(root);
    const state = summarize(runId);
    assert.equal(state.shots[0].filmQC.status, 'complete');
    assert.equal(state.shots[0].filmQC.receipts.length, 5);
    assert.equal(state.shots[0].filmQC.selection.selectedReceipt.agentId, 'director');
    assert.equal(state.shots[0].status, 'done');
  } finally {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    applyDeployModels(null);
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('customized agent prompts are executed and journaled independently', async () => {
  await fixture(async (journal) => {
    const agents = structuredClone(DEFAULT_AGENT_CONFIG.qc);
    agents[0].name = 'Drama director';
    agents[0].focus = 'Subtle performances';
    agents[0].system = 'Custom {name}: {focus}';
    agents[0].inspect = 'Inspect performance: {brief}';
    agents[0].receipt = 'Correct performance: {brief}\n{inspection}';
    const client = { async reason(args) {
      if (args.agentId === 'director') {
        assert.equal(args.systemPrompt, 'Custom Drama director: Subtle performances');
        assert.ok(args.prompt.startsWith(args.stage === 'inspect' ? 'Inspect performance:' : 'Correct performance:'));
      } else if (args.agentId !== 'persona') {
        assert.ok(!args.systemPrompt.includes('Custom Drama director'));
      }
      return normalResponse(args);
    } };
    await runFilmQC({ ...options, agents, journal, client });
    assert.deepEqual(journal.entries('qc.started')[0].data.agents, agents);
    assert.equal(journal.entries('intent').length, 11);
    assert.equal(journal.entries('result').length, 11);
    assert.equal(journal.entries('qc.receipt').find((r) => r.data.agentId === 'director').data.agentName, 'Drama director');
  });
});
