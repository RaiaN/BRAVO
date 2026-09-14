import { CHECKS } from './gates.js';
const CLASSES = ['plan', 'measure', 'judgment', 'policy'];
const APPLIES = ['brief', 'screenplay', 'shotplan', 'perShot', 'joins', 'timeline', 'run'];
const STATUSES = ['active', 'calibrating', 'retired'];

const fail = (what) => { throw new Error(`Rulebook rejected: ${what}`); };

export const validateRule = (r, source) => {
  const where = `${source} ${r?.id || '(no id)'}`;
  if (!r || typeof r !== 'object') fail(`${where}: not an object`);
  if (!/^[A-Z]{3}-\d{3}$/.test(r.id || '')) fail(`${where}: id must look like XXX-000`);
  for (const k of ['title', 'statement']) {
    if (typeof r[k] !== 'string' || !r[k].trim()) fail(`${where}: missing ${k}`);
  }
  if (!CLASSES.includes(r.class)) fail(`${where}: class must be one of ${CLASSES.join(', ')}`);
  if (!APPLIES.includes(r.appliesTo)) fail(`${where}: appliesTo must be one of ${APPLIES.join(', ')}`);
  if (typeof r.blocking !== 'boolean') fail(`${where}: blocking must be boolean`);
  if (!STATUSES.includes(r.status)) fail(`${where}: status must be one of ${STATUSES.join(', ')}`);
  if (r.class !== 'judgment' && r.blocking && r.status === 'calibrating') {
    fail(`${where}: a calibrating rule cannot block — calibrate first, then promote`);
  }
  if (r.class === 'judgment' && r.blocking) fail(`${where}: judgment rules never block`);
  if ((r.class === 'policy') !== (r.appliesTo === 'run')) fail(`${where}: policy rules apply to the run, and only policy rules do`);
  if (r.class === 'policy' && !r.blocking) fail(`${where}: policy rules block — a policy nobody enforces is an escape hatch`);
  if (!r.provenance || !['seed', 'note'].includes(r.provenance.origin)) fail(`${where}: provenance.origin must be seed or note`);
  if (r.provenance.origin === 'note' && !(r.provenance.iteration && r.provenance.note)) {
    fail(`${where}: a learned rule names the iteration and note that created it`);
  }
  return r;
};

const fnv1a = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

export const loadRulebook = ({ cinematic, screenwriting, metrics, policy }, { checks, policyChecks } = {}) => {
  if (!cinematic || !screenwriting) fail('both cinematic and screenwriting books are required — a director with half a rulebook refuses to plan');
  if (policyChecks && !policy) fail('POLICY_CHECKS were given but no policy book — a pass without its policy book refuses to run');
  if (policy && !policyChecks) fail('a policy book was given without POLICY_CHECKS — policy rules nobody checks are an escape hatch');
  const books = [['cinematic', cinematic], ['screenwriting', screenwriting], ...(policy ? [['policy', policy]] : [])];
  const rules = [];
  const seen = new Set();
  for (const [name, book] of books) {
    if (!Array.isArray(book.rules) || !book.rules.length) fail(`${name}: no rules`);
    for (const r of book.rules) {
      validateRule(r, name);
      if (seen.has(r.id)) fail(`duplicate rule id ${r.id}`);
      if (name === 'policy' && r.class !== 'policy') fail(`${r.id}: the policy book holds policy rules only`);
      if (name !== 'policy' && r.class === 'policy') fail(`${r.id}: policy rules live in the policy book`);
      seen.add(r.id);
      rules.push({ ...r, book: name });
    }
  }
  if (checks) {
    for (const r of rules) {
      if (r.class !== 'judgment' && r.class !== 'policy' && r.status === 'active' && !checks[r.id]) {
        fail(`${r.id} is an active ${r.class}-class rule with no check implementation — a blocking rule nobody checks is an escape hatch`);
      }
    }
  }
  for (const r of rules) {
    if (r.class === 'policy' && r.status === 'active' && !policyChecks[r.id]) {
      fail(`${r.id} is an active policy rule with no check in POLICY_CHECKS — a policy rule nobody checks is an escape hatch`);
    }
  }
  const metricList = Array.isArray(metrics?.metrics) ? metrics.metrics : [];
  for (const m of metricList) {
    if (!/^M-[A-Z-]+$/.test(m.id || '')) fail(`metric ${m.id || '(no id)'}: bad id`);
    if (!['exact', 'scored', 'exact+scored'].includes(m.method)) fail(`metric ${m.id}: bad method`);
  }
  const version = fnv1a(JSON.stringify({ rules, metrics: metricList }));
  return {
    version,
    rules,
    metrics: metricList,
    rulesFor: (appliesTo, klass = null) => rules.filter((r) => r.status !== 'retired'
      && r.appliesTo === appliesTo && (klass === null || r.class === klass)),
    ruleById: (id) => rules.find((r) => r.id === id) || null,
    doctrine: () => rules.filter((r) => r.status !== 'retired')
      .map((r) => `- [${r.id}] ${r.title}: ${r.statement}`).join('\n'),
  };
};

let cached = null;

export const fetchRulebook = async (checks) => {
  if (cached) return cached;
  const res = await fetch('/api/rules');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `rules route failed (HTTP ${res.status})`);
  cached = loadRulebook(data, { checks });
  return cached;
};

export const resetRulebookCache = () => { cached = null; };

export const loadedRulebook = () => {
  if (!cached) throw new Error('no rulebook is loaded — requireRulebook() runs before any manifest is made, and a pass hands its own rulebook through');
  return cached;
};

export const requireRulebook = () => fetchRulebook(CHECKS);
