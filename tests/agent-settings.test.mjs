import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_AGENT_CONFIG, agentConfigProblems } from '../agents/config.js';
import { readAgentSettings, saveAgentSettings } from '../agents/settings-store.js';
import { createBrowserClient } from '../utils/film/core/client.js';
import { openJournal, journaledClient } from '../agents/journal.js';

test('saved configuration preserves legacy Persona, persists every agent, and journals old/new versions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bravo-agent-settings-'));
  try {
    await mkdir(path.join(root, 'looks'));
    const legacy = { ...DEFAULT_AGENT_CONFIG.persona, system: 'Custom Persona' };
    delete legacy.receiptChoice;
    await writeFile(path.join(root, 'looks', 'persona.json'), JSON.stringify(legacy));
    const initial = readAgentSettings(root);
    assert.equal(initial.config.persona.system, 'Custom Persona');
    assert.equal(initial.config.persona.receiptChoice, DEFAULT_AGENT_CONFIG.persona.receiptChoice);
    const edited = structuredClone(initial.config);
    edited.qc.forEach((agent) => { agent.focus = `Custom focus for ${agent.id}`; });
    edited.planner.system += '\nUse legible blocking.';
    edited.variator.system += '\nPreserve eyelines.';
    const saved = await saveAgentSettings(edited, initial.revision, { root });
    assert.deepEqual(readAgentSettings(root), saved);
    assert.notEqual(saved.revision, initial.revision);
    const rows = (await readFile(path.join(root, 'runs/agent-settings/journal.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].kind, 'intent');
    assert.deepEqual(rows[0].data.before, initial.config);
    assert.deepEqual(rows[0].data.after, edited);
    assert.equal(rows[1].data.status, 'saved');
    assert.equal(rows[1].data.revision, saved.revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown placeholders, missing agents, and stale concurrent saves are rejected and journaled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bravo-agent-validation-'));
  try {
    const initial = readAgentSettings(root);
    const invalid = structuredClone(initial.config);
    invalid.qc[0].inspect = '{unknown}';
    assert.ok(agentConfigProblems(invalid).some((p) => p.includes('unknown placeholder')));
    await assert.rejects(saveAgentSettings(invalid, initial.revision, { root }), { status: 400 });
    assert.deepEqual(readAgentSettings(root), initial);
    assert.ok(agentConfigProblems({ ...initial.config, qc: initial.config.qc.slice(1) }).length);
    const first = structuredClone(initial.config);
    first.qc[0].name = 'Drama director';
    const second = structuredClone(initial.config);
    second.qc[1].name = 'Lighting director';
    const results = await Promise.allSettled([
      saveAgentSettings(first, initial.revision, { root }),
      saveAgentSettings(second, initial.revision, { root }),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].reason.status, 409);
    assert.deepEqual(readAgentSettings(root).config, first);
    const rows = (await readFile(path.join(root, 'runs/agent-settings/journal.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter((r) => r.kind === 'settings.rejected').length, 2);
    assert.deepEqual(rows.map((r) => r.step), rows.map((_, i) => i + 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reasoner error details and each provider polling response reach the journal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bravo-transport-journal-'));
  const journal = await openJournal({ dir });
  const originalFetch = globalThis.fetch;
  try {
    let polls = 0;
    globalThis.fetch = async (url) => {
      if (url === '/api/seed') return Response.json({ error: 'Provider failure', details: { code: 'quota', request_id: 'request1' } }, { status: 429 });
      polls += 1;
      return Response.json(polls === 1 ? { status: 'running' } : { status: 'succeeded', video_url: 'https://example.com/video.mov' });
    };
    const client = journaledClient(journal, createBrowserClient(undefined, { onEvent: (kind, data) => journal.write(kind, data) }));
    await assert.rejects(client.reason({ agentId: 'director', stage: 'inspect', prompt: 'test' }), /Provider failure/);
    await client.pollVideo({ taskId: 'task1', intervalMs: 1, timeoutMs: 1000 });
    assert.deepEqual(journal.entries('render.poll').map((r) => r.data.response.status), ['running', 'succeeded']);
    const error = journal.entries('result').find((r) => r.data.error).data;
    assert.equal(error.agentId, 'director');
    assert.equal(error.error.status, 429);
    assert.equal(error.error.details.details.request_id, 'request1');
  } finally {
    globalThis.fetch = originalFetch;
    await journal.close();
    await rm(dir, { recursive: true, force: true });
  }
});
