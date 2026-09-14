import fs from 'node:fs';
import path from 'node:path';

export const RUBRIC_SETS = ['plate', 'take', 'join', 'film'];
const FORMS = ['binary', 'choice'];
export const SCOPES = ['artifact', 'identity', 'setup', 'force', 'change', 'look', 'motion', 'exposure', 'action', 'continuity', 'direction', 'beat', 'story'];
const EVIDENCE = ['frame', 'sequence'];
const ANCHORS = ['subject', 'force', 'change', 'setup', 'look', 'entity', 'role', 'beat', 'firstBeat', 'lastBeat'];
const MEASURES = ['frozen', 'black', 'cut', 'continuous'];
const LEVELS = ['shot', 'film'];
const JOIN_TYPES = ['cut', 'continuous'];
export const BINARY_ANSWERS = ['yes', 'no'];

const PARAM_SHAPES = {
  plate: {},
  take: {
    frames: ['maxWidth'],
    still: ['minLuma', 'maxLuma', 'minBlur', 'duplicateMaxBits'],
    frozen: ['maxBits', 'minSeconds'],
    black: ['maxLuma'],
    blown: ['minLuma'],
    scoring: ['deterministicWeight', 'rubricWeight'],
  },
  join: { window: ['secondsBefore', 'secondsAfter', 'fps', 'maxWidth'] },
  film: { frames: ['maxWidth'] },
};

const fail = (what) => { throw new Error(`Rubrics rejected: ${what}`); };

const fnv1a = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

export const rubricsDir = () => path.join(process.cwd(), 'rules', 'rubrics');

export const readRubricBooks = (dir = rubricsDir()) => Object.fromEntries(RUBRIC_SETS.map((set) => {
  const file = path.join(dir, `${set}.json`);
  if (!fs.existsSync(file)) fail(`${file} is missing — the ${set} rubric has no book`);
  return [set, JSON.parse(fs.readFileSync(file, 'utf8'))];
}));

const validateParams = (set, params) => {
  const where = `${set} params`;
  if (!params || typeof params !== 'object') fail(`${where}: missing`);
  if (!params.provenance || typeof params.provenance.origin !== 'string' || !params.provenance.note) fail(`${where}: provenance.origin and provenance.note are required`);
  for (const [group, keys] of Object.entries(PARAM_SHAPES[set])) {
    if (!params[group] || typeof params[group] !== 'object') fail(`${where}: missing group ${group}`);
    for (const k of keys) {
      if (typeof params[group][k] !== 'number' || !Number.isFinite(params[group][k])) fail(`${where}: ${group}.${k} must be a finite number`);
    }
  }
  return params;
};

const validateQuestion = (q, set, rulebook, seen) => {
  const where = `${set} question ${q?.id || '(no id)'}`;
  if (!q || typeof q !== 'object') fail(`${where}: not an object`);
  if (!new RegExp(`^${set}\\.[a-z0-9-]+$`).test(q.id || '')) fail(`${where}: id must look like ${set}.kebab-name`);
  if (seen.has(q.id)) fail(`${where}: duplicate id`);
  seen.add(q.id);
  if (typeof q.ruleRef !== 'string' || !rulebook.ruleById(q.ruleRef)) fail(`${where}: ruleRef ${JSON.stringify(q.ruleRef)} is not a rule in the rulebook`);
  if (!FORMS.includes(q.form)) fail(`${where}: form must be one of ${FORMS.join(', ')}`);
  if (q.form === 'choice') {
    if (!Array.isArray(q.options) || q.options.length < 2 || new Set(q.options).size !== q.options.length || q.options.some((o) => typeof o !== 'string' || !o.trim())) fail(`${where}: a choice question lists at least two distinct string options`);
  } else if ('options' in q) fail(`${where}: a binary question carries no options`);
  const allowed = q.form === 'choice' ? q.options : BINARY_ANSWERS;
  if (!Array.isArray(q.passes) || !q.passes.length || q.passes.some((p) => !allowed.includes(p))) fail(`${where}: passes must name answers from ${allowed.join(', ')}`);
  if (q.passes.length >= allowed.length) fail(`${where}: a question every answer passes decides nothing`);
  if (!SCOPES.includes(q.scope)) fail(`${where}: scope must be one of ${SCOPES.join(', ')}`);
  if (!EVIDENCE.includes(q.evidence)) fail(`${where}: evidence must be one of ${EVIDENCE.join(', ')}`);
  if (q.evidenceRequired !== true) fail(`${where}: evidenceRequired must be true — a judge that cannot point at a frame has not judged`);
  if (typeof q.text !== 'string' || !q.text.trim()) fail(`${where}: missing text`);
  if (!Array.isArray(q.anchors) || q.anchors.some((a) => !ANCHORS.includes(a))) fail(`${where}: anchors must be from ${ANCHORS.join(', ')}`);
  for (const a of q.anchors) if (!q.text.includes(`{${a}}`)) fail(`${where}: anchor ${a} is declared but {${a}} is absent from the text`);
  const used = [...q.text.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
  for (const u of used) if (!q.anchors.includes(u)) fail(`${where}: {${u}} appears in the text but is not a declared anchor`);
  if ('measure' in q && !MEASURES.includes(q.measure)) fail(`${where}: measure must be one of ${MEASURES.join(', ')}`);
  if (set === 'film' && !LEVELS.includes(q.level)) fail(`${where}: a film question declares level shot or film`);
  if (set === 'join' && (!Array.isArray(q.joinTypes) || !q.joinTypes.length || q.joinTypes.some((t) => !JOIN_TYPES.includes(t)))) fail(`${where}: a join question declares its joinTypes from ${JOIN_TYPES.join(', ')}`);
  return { ...q, set };
};

export const loadRubrics = (rulebook, books = readRubricBooks()) => {
  if (!rulebook || typeof rulebook.ruleById !== 'function') fail('a loaded rulebook is required — rubric questions cite rules by id');
  const sets = {};
  const params = {};
  const questions = [];
  const seen = new Set();
  for (const set of RUBRIC_SETS) {
    const book = books?.[set];
    if (!book || typeof book !== 'object') fail(`${set}: no book`);
    if (book.set !== set) fail(`${set}: the book declares set ${JSON.stringify(book.set)}`);
    if (!Array.isArray(book.questions) || !book.questions.length) fail(`${set}: no questions`);
    params[set] = validateParams(set, book.params);
    sets[set] = book.questions.map((q) => validateQuestion(q, set, rulebook, seen));
    questions.push(...sets[set]);
  }
  const cited = new Set(questions.map((q) => q.ruleRef));
  const doctrineOnly = rulebook.rules
    .filter((r) => r.class === 'judgment' && r.status !== 'retired' && !cited.has(r.id))
    .map((r) => r.id);
  const version = fnv1a(JSON.stringify({ sets, params }));
  return {
    version,
    rulebook,
    sets,
    params,
    questions,
    doctrineOnly,
    byId: (id) => questions.find((q) => q.id === id) || null,
    forSet: (set, filter = () => true) => {
      if (!sets[set]) fail(`no rubric set named ${JSON.stringify(set)}`);
      return sets[set].filter(filter);
    },
  };
};

export const fillQuestion = (q, anchors) => {
  const text = q.text.replace(/\{([a-zA-Z]+)\}/g, (_, name) => {
    const value = anchors?.[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`rubric ${q.id} needs anchor "${name}" and none was given`);
    return value.trim();
  });
  return { ...q, text, anchors: Object.fromEntries(q.anchors.map((a) => [a, anchors[a].trim()])) };
};

export const authorityOf = (q, policy) => {
  const spending = policy?.judge?.spendingRubrics;
  if (!Array.isArray(spending)) throw new Error('policy.judge.spendingRubrics is required to decide rubric authority');
  if (typeof q?.id !== 'string' || !q.id) throw new Error('authorityOf: a rubric question with an id is required — authority is keyed by rubric id');
  return spending.includes(q.id) ? 'spending' : 'witness';
};

export const passesOf = (q, answer) => q.passes.includes(answer);
