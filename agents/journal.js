import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const KIND = /^[a-z][a-z0-9.-]{0,63}$/i;
const MEDIA_NAME = /^[a-z0-9][a-z0-9._-]{0,120}\.(png|jpg|jpeg|webp|mp4|webm|mov|wav|mp3)$/i;
const pad = (n) => String(n).padStart(4, '0');

export const FINDING_FAMILIES = ['gate', 'fault', 'qc', 'judge-reliability', 'waste', 'budget', 'drift', 'shortfall'];
export const FINDING_STAGES = ['intake', 'ideate', 'screenplay', 'breakdown', 'approve', 'plate', 'keyframe', 'select', 'shoot', 'measure', 'qc', 'join', 'assemble', 'final', 'complete'];
export const FINDING_SEVERITIES = ['blocker', 'note', 'taste'];
export const RULE_CLASSES = ['plan', 'measure', 'judgment', 'policy'];

export const FINDING_SCHEMA = {
  required: {
    finding_id: 'string',
    runId: 'string',
    at: 'iso',
    family: FINDING_FAMILIES,
    stage: FINDING_STAGES,
    severity: FINDING_SEVERITIES,
    code: 'string',
    detail: 'string',
    evidence: 'array',
  },
  optional: {
    ruleId: 'string',
    rubricId: 'string',
    metricId: 'string',
    shotId: 'string',
    joinRef: 'string',
    candidateId: 'string',
    takeId: 'string',
    taskId: 'string',
    attempt: 'integer',
    class: RULE_CLASSES,
    failureKind: 'string',
    timecode: 'number',
    value: 'any',
    threshold: 'any',
    signature: 'string',
    cost: 'number',
    disposition: 'string',
    correction: 'string',
  },
};

export const COST_KINDS = ['still', 'take', 'judge', 'reason'];
export const COST_DISPOSITIONS = ['kept', 'wasted', 'refused'];

export const COST_SCHEMA = {
  required: { kind: COST_KINDS, units: 'number', disposition: COST_DISPOSITIONS },
  optional: {
    code: 'string',
    runId: 'string',
    at: 'iso',
    nodeId: 'string',
    reservationId: 'string',
    intentId: 'string',
    taskId: 'string',
    shotId: 'string',
    candidateId: 'string',
    takeId: 'string',
    attempt: 'integer',
    price: 'number',
    currency: 'string',
    detail: 'string',
  },
};

const typeProblem = (key, type, value) => {
  if (Array.isArray(type)) return type.includes(value) ? null : `${key} must be one of ${type.join('|')}, got ${JSON.stringify(value)}`;
  if (type === 'string') return typeof value === 'string' && value.trim() ? null : `${key} must be a non-empty string`;
  if (type === 'iso') return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : `${key} must be an ISO timestamp`;
  if (type === 'array') return Array.isArray(value) ? null : `${key} must be an array`;
  if (type === 'integer') return Number.isInteger(value) ? null : `${key} must be an integer`;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : `${key} must be a finite number`;
  if (type === 'any') return value === undefined ? `${key} must carry a value` : null;
  throw new Error(`unknown schema type "${type}" for ${key}`);
};

const problemsAgainst = (schema, row) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return ['a row must be an object'];
  const problems = [];
  for (const [key, type] of Object.entries(schema.required)) {
    if (!(key in row)) { problems.push(`${key} is required`); continue; }
    const p = typeProblem(key, type, row[key]);
    if (p) problems.push(p);
  }
  for (const key of Object.keys(row)) {
    if (key in schema.required) continue;
    if (!(key in schema.optional)) { problems.push(`${key} is not a column of this taxonomy`); continue; }
    const p = typeProblem(key, schema.optional[key], row[key]);
    if (p) problems.push(p);
  }
  return problems;
};

export const validateFinding = (row) => problemsAgainst(FINDING_SCHEMA, row);

export const validateCost = (row) => {
  const problems = problemsAgainst(COST_SCHEMA, row);
  if (row && typeof row === 'object' && row.disposition && row.disposition !== 'kept' && !row.code) problems.push(`a ${row.disposition} cost row must carry a code`);
  return problems;
};

const readRecords = (file) => {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, i) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      throw new Error(`journal "${file}" has an unreadable line ${i + 1} (${err.message}) — it has NOT been touched`);
    }
    if (record?.step !== i + 1) throw new Error(`journal "${file}" line ${i + 1} carries step ${record?.step} — the counter is broken and it has NOT been touched`);
    return record;
  });
};

const writeNew = async (file, content) => {
  const handle = await fsp.open(file, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const appendSynced = async (handle, line) => {
  await handle.write(line);
  await handle.sync();
};

const checkKind = (kind) => {
  if (!KIND.test(String(kind || ''))) throw new Error(`journal kind "${kind}" must be a short token`);
};

const checkData = (kind, data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`journal ${kind} step needs an object of data`);
};

export const openJournal = async ({ dir } = {}) => {
  if (typeof dir !== 'string' || !dir) throw new Error('openJournal needs a "dir"');
  const paths = {
    dir,
    journal: path.join(dir, 'journal.ndjson'),
    steps: path.join(dir, 'steps'),
    media: path.join(dir, 'media'),
    errors: path.join(dir, 'errors.ndjson'),
    cost: path.join(dir, 'cost.ndjson'),
  };
  fs.mkdirSync(paths.steps, { recursive: true });
  fs.mkdirSync(paths.media, { recursive: true });

  const records = readRecords(paths.journal);
  const intents = new Map();
  for (const r of records) {
    if (r.kind === 'intent') intents.set(r.data.intentId, { call: r.data.call, step: r.step, resultStep: null });
    if (r.kind === 'result') {
      const open = intents.get(r.data.intentId);
      if (!open) throw new Error(`journal "${paths.journal}" step ${r.step} is a result for intent "${r.data.intentId}" that was never journaled`);
      open.resultStep = r.step;
    }
  }
  let counter = records.length;
  let closed = false;

  const handles = {
    journal: await fsp.open(paths.journal, 'a'),
    errors: await fsp.open(paths.errors, 'a'),
    cost: await fsp.open(paths.cost, 'a'),
  };

  let tail = Promise.resolve();
  const enqueue = (task) => {
    const run = tail.then(task, task);
    tail = run.then(() => {}, () => {});
    return run;
  };

  const record = async (kind, build) => {
    if (closed) throw new Error(`journal "${paths.journal}" is closed — nothing more can be written`);
    const step = counter + 1;
    const at = new Date().toISOString();
    const rec = { step, at, kind, data: build(step) };
    const line = `${JSON.stringify(rec)}\n`;
    await appendSynced(handles.journal, line);
    await writeNew(path.join(paths.steps, `${pad(step)}-${kind.replace(/[^a-z0-9]+/gi, '-')}.json`), JSON.stringify(rec, null, 1));
    counter = step;
    records.push(rec);
    return rec;
  };

  const write = (kind, data) => {
    checkKind(kind);
    checkData(kind, data);
    return enqueue(async () => {
      const rec = await record(kind, () => data);
      return { step: rec.step, at: rec.at };
    });
  };

  const intent = (kind, data) => {
    checkKind(kind);
    checkData(kind, data);
    if ('intentId' in data || 'call' in data) throw new Error(`journal.intent data for ${kind} may not carry "intentId" or "call" — the journal assigns them`);
    return enqueue(async () => {
      const rec = await record('intent', (step) => ({ intentId: `int_${pad(step)}`, call: kind, ...data }));
      intents.set(rec.data.intentId, { call: kind, step: rec.step, resultStep: null });
      return rec.data.intentId;
    });
  };

  const result = (intentId, data) => {
    checkData('result', data);
    return enqueue(async () => {
      const open = intents.get(intentId);
      if (!open) throw new Error(`journal.result: no intent "${intentId}" was journaled — a result must answer an intent`);
      if (open.resultStep !== null) throw new Error(`journal.result: intent "${intentId}" already has its result at step ${open.resultStep}`);
      const rec = await record('result', () => ({ intentId, call: open.call, ...data }));
      open.resultStep = rec.step;
      return { step: rec.step, at: rec.at };
    });
  };

  const finding = (row) => {
    const problems = validateFinding(row);
    if (problems.length) throw new Error(`journal.finding refuses the row: ${problems.join('; ')}`);
    return enqueue(async () => {
      const rec = await record('finding', () => row);
      await appendSynced(handles.errors, `${JSON.stringify({ step: rec.step, ...row })}\n`);
      return { step: rec.step, at: rec.at };
    });
  };

  const cost = (row) => {
    const problems = validateCost(row);
    if (problems.length) throw new Error(`journal.cost refuses the row: ${problems.join('; ')}`);
    return enqueue(async () => {
      const rec = await record('cost', () => row);
      await appendSynced(handles.cost, `${JSON.stringify({ step: rec.step, at: rec.at, ...row })}\n`);
      return { step: rec.step, at: rec.at };
    });
  };

  const media = async (name, urlOrBytes) => {
    if (!MEDIA_NAME.test(String(name || ''))) throw new Error(`journal.media name "${name}" must be a plain filename with a media extension`);
    const file = path.join(paths.media, name);
    if (fs.existsSync(file)) throw new Error(`journal.media refuses to overwrite "${file}" — a journal never loses its evidence`);
    let bytes;
    let source;
    if (typeof urlOrBytes === 'string') {
      if (!/^(https?:\/\/|\/)/.test(urlOrBytes)) throw new Error(`journal.media source for "${name}" must be an http(s) or app-relative url, got "${urlOrBytes}"`);
      const res = await fetch(urlOrBytes);
      if (!res.ok) throw new Error(`journal.media source for "${name}" responded ${res.status} — the media was NOT saved`);
      bytes = Buffer.from(await res.arrayBuffer());
      source = urlOrBytes;
    } else if (urlOrBytes instanceof Uint8Array) {
      bytes = Buffer.from(urlOrBytes);
      source = 'bytes';
    } else {
      throw new Error(`journal.media source for "${name}" must be a url string or bytes`);
    }
    await writeNew(file, bytes);
    await enqueue(() => record('media', () => ({ name, path: file, bytes: bytes.length, source })));
    return file;
  };

  const entries = (kind) => {
    if (kind !== undefined) checkKind(kind);
    return records.filter((r) => kind === undefined || r.kind === kind);
  };

  const close = () => enqueue(async () => {
    closed = true;
    for (const handle of Object.values(handles)) {
      await handle.sync();
      await handle.close();
    }
  });

  return { dir, paths, write, intent, result, finding, cost, media, entries, close };
};

const INTENT_PAYLOAD = {
  reason: ({ images, ...args }) => ({ ...args, images: Array.isArray(images) ? images.length : 0 }),
  generateImage: (args) => ({ ...args }),
  startVideo: (args) => ({ ...args }),
  pollVideo: (args) => ({ ...args }),
};

export const journaledClient = (journal, client) => {
  if (!journal || typeof journal.intent !== 'function' || typeof journal.result !== 'function') throw new Error('journaledClient needs an open journal');
  if (!client || typeof client !== 'object') throw new Error('journaledClient needs a client');
  const wrapped = { ...client };
  for (const [name, payload] of Object.entries(INTENT_PAYLOAD)) {
    if (typeof client[name] !== 'function') continue;
    wrapped[name] = async (args = {}) => {
      const intentId = await journal.intent(name, payload(args));
      const t0 = Date.now();
      let out;
      try {
        out = await client[name](args);
      } catch (err) {
        await journal.result(intentId, { error: { name: err.name, message: err.message }, ms: Date.now() - t0 });
        throw err;
      }
      await journal.result(intentId, { ...out, ms: Date.now() - t0 });
      return out;
    };
  }
  return wrapped;
};
