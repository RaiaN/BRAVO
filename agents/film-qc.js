import { fill } from './persona.js';
import { DEFAULT_AGENT_CONFIG } from './config.js';
import { journaledClient } from './journal.js';

export const FILM_QC_AGENTS = DEFAULT_AGENT_CONFIG.qc;

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const score = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10;
const list = (value) => Array.isArray(value) && value.every(text);
const parse = (content) => JSON.parse(String(content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim());

export const validateInspection = (value, seconds) => {
  if (!value || !score(value.score) || !text(value.summary) || !list(value.strengths) || !list(value.limitations) || !Array.isArray(value.findings)) {
    throw new Error('Inspection needs score (0–10), summary, strengths, limitations and findings');
  }
  const ids = new Set();
  for (const f of value.findings) {
    if (!f || !text(f.id) || ids.has(f.id) || !text(f.category) || !text(f.evidence) || !text(f.impact)
      || !['critical', 'major', 'minor'].includes(f.severity)
      || !(f.timecode === null || (typeof f.timecode === 'number' && Number.isFinite(f.timecode) && f.timecode >= 0 && f.timecode <= seconds))) {
      throw new Error('Each finding needs a unique id, category, severity, evidence, impact and valid timecode or null');
    }
    ids.add(f.id);
  }
  return value;
};

export const validateReceipt = (value, inspection) => {
  if (!value || !text(value.title) || !text(value.summary) || !list(value.preserve) || !list(value.limitations)
    || !text(value.revisedPrompt) || !Array.isArray(value.actions)) {
    throw new Error('Receipt needs title, summary, preserve, limitations, revisedPrompt and actions');
  }
  const ids = new Set(inspection.findings.map((f) => f.id));
  for (const a of value.actions) {
    if (!a || !Number.isInteger(a.priority) || a.priority < 1 || !list(a.findingIds)
      || a.findingIds.some((id) => !ids.has(id))
      || !['prompt', 'edit', 'vfx', 'grade', 'sound'].includes(a.department)
      || !text(a.change) || !text(a.rationale) || !text(a.risk) || !text(a.verify)) {
      throw new Error('Each action needs priority, existing findingIds, department, change, rationale, risk and verification');
    }
  }
  if (inspection.findings.some((f) => !value.actions.some((a) => a.findingIds.includes(f.id)))) {
    throw new Error('Every inspection finding must be addressed by a receipt action');
  }
  return value;
};

// Each branch owns its inspection and receipt context. Siblings never see one another's outputs.
export const runFilmQC = async ({ shot, take, previous, idea, logline, style, persona, client: transport, journal, attempts = 3, agents = FILM_QC_AGENTS }) => {
  const client = journaledClient(journal, transport);
  const context = { shotId: shot.id, takeId: take.taskId, variant: take.variant, file: take.file };
  const video = take.providerUrl || take.url;
  const brief = `THE FILM: ${logline}\nTHE STORY: ${idea}\nTHE SHOT (${shot.seconds}s): ${shot.prompt}\nSELECTED TAKE PROMPT: ${take.prompt}\nLOOK AND CONSTRAINTS: ${JSON.stringify(style)}\nPREVIOUS TAKE REFERENCE: ${JSON.stringify(previous)}\nThis is Persona's selected good take. Preserve its strengths while pursuing the highest achievable film quality.`;

  const ask = async ({ agentId, stage, prompt, systemPrompt, validate, attachVideo = false }) => {
    let rejection = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await journal.write('qc.stage', { ...context, agentId, stage, attempt, status: 'running' });
      try {
        const { content } = await client.reason({
          ...context, agentId, stage, attempt,
          prompt: `${prompt}${rejection ? `\n\nYour last attempt failed: ${rejection}\nReturn a corrected complete JSON object.` : ''}`,
          systemPrompt, reasoningEffort: 'high', ...(attachVideo ? { video } : {}),
        });
        // Preserve even malformed answers before parsing or validation.
        await journal.write('qc.response', { ...context, agentId, stage, attempt, response: content });
        const result = validate(parse(content));
        await journal.write('qc.stage', { ...context, agentId, stage, attempt, status: 'done' });
        return result;
      } catch (err) {
        rejection = err.message;
        await journal.write('qc.stage', { ...context, agentId, stage, attempt, status: 'failed', error: rejection });
      }
    }
    throw new Error(`E-FILM-QC: ${agentId} ${stage} failed after ${attempts} attempts: ${rejection}`);
  };

  await journal.write('qc.started', { ...context, agents, video, previous, stages: ['inspect', 'receipt', 'persona-selection'] });
  const settled = await Promise.allSettled(agents.map(async (agent) => {
    const systemPrompt = fill(agent.system, { name: agent.name, focus: agent.focus });
    const inspection = await ask({
      agentId: agent.id, stage: 'inspect', systemPrompt, attachVideo: true,
      prompt: fill(agent.inspect, { brief }),
      validate: (value) => validateInspection(value, shot.seconds),
    });
    await journal.write('qc.inspection', { ...context, agentId: agent.id, inspection });
    const receipt = await ask({
      agentId: agent.id, stage: 'receipt', systemPrompt,
      prompt: fill(agent.receipt, { brief, inspection: JSON.stringify(inspection) }),
      validate: (value) => validateReceipt(value, inspection),
    });
    const result = { ...context, agentId: agent.id, agentName: agent.name, receiptId: `${shot.id}:${take.taskId}:${agent.id}`, inspection, receipt };
    await journal.write('qc.receipt', result);
    return result;
  }));

  const failures = settled.flatMap((r, i) => r.status === 'rejected' ? [{ agentId: agents[i].id, error: r.reason?.message || String(r.reason) }] : []);
  if (failures.length) {
    await journal.write('qc.failed', { ...context, failures });
    throw new Error(`E-FILM-QC: all five receipts are required; failed: ${failures.map((f) => f.agentId).join(', ')}`);
  }
  const receipts = settled.map((r) => r.value);
  let selection;
  try {
    selection = await ask({
      agentId: 'persona', stage: 'persona-selection', systemPrompt: persona.system, attachVideo: true,
      prompt: fill(persona.receiptChoice, { logline, story: idea, seconds: shot.seconds, shot: shot.prompt, prompt: take.prompt, receipts: JSON.stringify(receipts) }),
      validate: (value) => {
        if (!value || !receipts.some((r) => r.receiptId === value.receiptId) || !text(value.reason)
          || !Array.isArray(value.comparisons) || value.comparisons.length !== receipts.length
          || new Set(value.comparisons.map((c) => c?.receiptId)).size !== receipts.length
          || value.comparisons.some((c) => !c || !receipts.some((r) => r.receiptId === c.receiptId) || !text(c.assessment))) {
          throw new Error('Persona must select an existing receiptId, give a reason and assess all five receipts once');
        }
        return value;
      },
    });
  } catch (err) {
    await journal.write('qc.failed', { ...context, failures: [{ agentId: 'persona', error: err.message }] });
    throw err;
  }
  const selectedReceipt = receipts.find((r) => r.receiptId === selection.receiptId);
  await journal.write('persona.receipt-choice', { ...context, ...selection, selectedReceipt });
  await journal.write('qc.complete', { ...context, receiptId: selection.receiptId, count: receipts.length });
  return { receipts, selection, selectedReceipt };
};
