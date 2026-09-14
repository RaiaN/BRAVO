const FROM = 'ideate';
const ATTEMPTS = 2;

const refuse = (code, what) => { throw new Error(`${code}: ${what}`); };

const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const stringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

const requireInputs = ({ idea, style, seconds, policy, client, journal }) => {
  if (!nonEmptyString(idea)) refuse('E-IDEATE-NO-IDEA', 'ideate needs a non-empty "idea"');
  if (!Number.isInteger(seconds) || seconds <= 0) refuse('E-IDEATE-NO-SECONDS', `ideate needs "seconds" as a positive integer — got ${JSON.stringify(seconds)}`);
  if (!style || typeof style !== 'object') refuse('E-IDEATE-NO-STYLE', 'ideate needs a "style" object');
  if (!nonEmptyString(style.id)) refuse('E-IDEATE-STYLE-ID', 'style.id must be a non-empty string');
  if (!style.look || !nonEmptyString(style.look.style) || !nonEmptyString(style.look.grade)) refuse('E-IDEATE-STYLE-LOOK', 'style.look needs "style" and "grade" as non-empty strings');
  if (typeof style.world !== 'string') refuse('E-IDEATE-STYLE-WORLD', 'style.world must be a string');
  if (typeof style.audio !== 'boolean') refuse('E-IDEATE-STYLE-AUDIO', 'style.audio must be true or false');
  if (!style.format || typeof style.format !== 'object' || !nonEmptyString(style.format.resolution) || !nonEmptyString(style.format.ratio)) refuse('E-IDEATE-STYLE-FORMAT', 'style.format needs "resolution" and "ratio" as non-empty strings');
  if (!stringList(style.doctrine)) refuse('E-IDEATE-STYLE-DOCTRINE', 'style.doctrine must be an array of strings');
  if (!stringList(style.constraints)) refuse('E-IDEATE-STYLE-CONSTRAINTS', 'style.constraints must be an array of strings');
  if (!Array.isArray(style.references)) refuse('E-IDEATE-STYLE-REFERENCES', 'style.references must be an array');
  const badRef = style.references.find((r) => !r || !nonEmptyString(r.name) || !['character', 'location', 'look'].includes(r.role));
  if (badRef) refuse('E-IDEATE-STYLE-REFERENCE', `style.references: every entry names a "name" and a role of character, location or look — got ${JSON.stringify(badRef)}`);
  if (!policy || typeof policy !== 'object') refuse('E-IDEATE-NO-POLICY', 'ideate needs the "policy" values');
  if (!policy.plates || !('max' in policy.plates)) refuse('E-IDEATE-POLICY-PLATES', 'policy.plates.max is missing — a ceiling is a number or a declared null, never absent');
  const cap = policy.plates.max;
  if (cap !== null && !(Number.isInteger(cap) && cap >= 1)) refuse('E-IDEATE-POLICY-PLATES', `policy.plates.max must be a positive integer or null — got ${JSON.stringify(cap)}`);
  if (!client || typeof client.reason !== 'function') refuse('E-IDEATE-NO-CLIENT', 'ideate needs a client with reason()');
  if (!journal || typeof journal.write !== 'function') refuse('E-IDEATE-NO-JOURNAL', 'ideate needs a journal with write()');
};

const parseStrictJson = (content) => {
  const body = String(content || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'not a JSON object' };
    return { parsed };
  } catch (e) {
    return { error: `not valid JSON (${e.message})` };
  }
};

const PROPOSAL_SHAPE = '{ "logline": { "value", "reason" }, "world": { "value", "reason" }, "cast": [{ "name", "role", "reason" }], "locations": [{ "name", "reason" }], "dramatis": { "protagonist", "want", "opposition", "reason" } }';

const systemPrompt = ({ style, seconds, cap }) => {
  const doctrine = style.doctrine.map((line, i) => `- [style:${style.id} doctrine #${i + 1}] ${line}`);
  const constraints = style.constraints.map((line, i) => `- [style:${style.id} constraint #${i + 1}] ${line}`);
  const fixed = style.references.filter((r) => r.role !== 'look').map((r) => `- [style:${style.id} reference] ${r.role}: ${r.name}`);
  const looks = style.references.filter((r) => r.role === 'look').map((r) => `- [style:${style.id} reference] look: ${r.name}`);
  return [
    `You derive the complete brief for a ${seconds}-second film slice from an idea. Return ONLY a JSON object, no prose, no fences:`,
    PROPOSAL_SHAPE,
    '',
    'EVERY FIELD CARRIES ITS REASON: each "reason" states, in one sentence, why that value follows from the idea and the style. A value with an empty reason is rejected.',
    'THE DRAMATIS IS REQUIRED: "protagonist" is the NAME of one cast member, spelled exactly as in "cast"; "want" is what that character pursues within the slice; "opposition" is a force that ACTS ON SCREEN against the want — visible in the frame, never an abstraction, never a mood.',
    'THE CAST is every character who appears on screen, each with a "role" (character, or a named function within the story). THE LOCATIONS are every place the slice is shot in. Names are unique, uppercase, and reused verbatim downstream.',
    cap === null
      ? 'PLATES: cast and locations each become one identity plate; the policy declares no ceiling on their count.'
      : `PLATES: cast and locations each become one identity plate; the policy caps cast + locations at ${cap} in total. A proposal over the cap is refused, never trimmed.`,
    'THE STORY must fit the seconds: one want, one opposition, a change from the first frame to the last.',
    '',
    `THE LOOK [style:${style.id} look]: ${style.look.style} · ${style.look.grade}`,
    `THE WORLD [style:${style.id} world]: ${style.world.trim() || '(the style declares no world; derive one from the idea and say so in its reason)'}`,
    ...(fixed.length ? ['FIXED NAMES (these references exist and must appear in cast or locations under exactly these names):', ...fixed] : []),
    ...(looks.length ? ['LOOK REFERENCES:', ...looks] : []),
    ...(constraints.length ? ['CONSTRAINTS (carried into the brief verbatim):', ...constraints] : []),
    ...(doctrine.length ? ['HOUSE DOCTRINE (judgment-class; each line carries its provenance):', ...doctrine] : []),
  ].join('\n');
};

const reasoned = (field, node) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { error: `"${field}" must be an object { value, reason }` };
  if (!nonEmptyString(node.value)) return { error: `"${field}.value" must be a non-empty string` };
  if (!nonEmptyString(node.reason)) return { error: `"${field}.reason" is empty — every derived field states why` };
  return { value: node.value.trim(), reason: node.reason.trim() };
};

const named = (field, list, withRole) => {
  if (!Array.isArray(list) || !list.length) return { error: `"${field}" must be a non-empty array` };
  const items = [];
  const seen = new Set();
  for (const [i, entry] of list.entries()) {
    const where = `"${field}[${i}]"`;
    if (!entry || typeof entry !== 'object') return { error: `${where} must be an object` };
    if (!nonEmptyString(entry.name)) return { error: `${where}.name must be a non-empty string` };
    if (withRole && !nonEmptyString(entry.role)) return { error: `${where}.role must be a non-empty string` };
    if (!nonEmptyString(entry.reason)) return { error: `${where}.reason is empty — every derived entry states why` };
    const name = entry.name.trim().toUpperCase();
    if (seen.has(name)) return { error: `${where}: the name ${name} is used twice — names are unique` };
    seen.add(name);
    items.push({ name, ...(withRole ? { role: entry.role.trim() } : {}), reason: entry.reason.trim() });
  }
  return { items };
};

const derive = (parsed, { style, seconds, cap }) => {
  const logline = reasoned('logline', parsed.logline);
  if (logline.error) return { fault: logline.error };
  const world = reasoned('world', parsed.world);
  if (world.error) return { fault: world.error };
  const cast = named('cast', parsed.cast, true);
  if (cast.error) return { fault: cast.error };
  const locations = named('locations', parsed.locations, false);
  if (locations.error) return { fault: locations.error };

  const d = parsed.dramatis;
  if (!d || typeof d !== 'object') return { fault: '"dramatis" must be an object { protagonist, want, opposition, reason }' };
  for (const k of ['protagonist', 'want', 'opposition', 'reason']) {
    if (!nonEmptyString(d[k])) return { fault: `"dramatis.${k}" must be a non-empty string` };
  }
  const protagonist = d.protagonist.trim().toUpperCase();
  const castNames = cast.items.map((c) => c.name);
  if (!castNames.includes(protagonist)) return { fault: `"dramatis.protagonist" must be the NAME of a cast member — got ${JSON.stringify(d.protagonist)}, cast is ${castNames.join(', ')}` };

  const fixedNames = style.references.filter((r) => r.role !== 'look').map((r) => r.name.trim().toUpperCase());
  const present = new Set([...castNames, ...locations.items.map((l) => l.name)]);
  const missingRef = fixedNames.find((n) => !present.has(n));
  if (missingRef) return { fault: `the style reference ${missingRef} must appear in cast or locations under exactly that name` };

  const plates = cast.items.length + locations.items.length;
  if (cap !== null && plates > cap) {
    return { fault: `${cast.items.length} cast + ${locations.items.length} locations = ${plates} plates, over policy.plates.max ${cap}`, capped: { cast: cast.items.length, locations: locations.items.length, plates, cap } };
  }

  const mark = (value, reason, extra = {}) => ({ value, derived: true, from: FROM, reason, ...extra });
  const brief = {
    logline: logline.value,
    targetSeconds: seconds,
    world: world.value,
    cast: cast.items.map((c) => ({ name: c.name, role: c.role, bibleEntryId: 'new' })),
    locations: locations.items.map((l) => ({ name: l.name, bibleEntryId: 'new' })),
    dramatis: { protagonist, want: d.want.trim(), opposition: d.opposition.trim() },
    constraints: [...style.constraints],
    format: { resolution: style.format.resolution, ratio: style.format.ratio, audio: style.audio },
  };
  const provenance = {
    logline: mark(brief.logline, logline.reason),
    targetSeconds: mark(seconds, 'the pass target: the seconds argument, carried unchanged'),
    world: mark(brief.world, world.reason),
    cast: mark(brief.cast, cast.items.map((c) => `${c.name}: ${c.reason}`).join('; '), { items: cast.items.map((c) => ({ name: c.name, reason: c.reason })) }),
    locations: mark(brief.locations, locations.items.map((l) => `${l.name}: ${l.reason}`).join('; '), { items: locations.items.map((l) => ({ name: l.name, reason: l.reason })) }),
    dramatis: mark(brief.dramatis, d.reason.trim()),
    constraints: mark(brief.constraints, `carried verbatim from style ${style.id} constraints`),
    format: mark(brief.format, `carried verbatim from style ${style.id} format and audio; fps is the rulebook's (SCR-008)`),
  };
  return { brief, provenance };
};

export const ideate = async ({ idea, style, seconds, policy, client, journal }) => {
  requireInputs({ idea, style, seconds, policy, client, journal });
  const cap = policy.plates.max;
  const system = systemPrompt({ style, seconds, cap });
  await journal.write('ideate.start', { idea, styleId: style.id, seconds, platesMax: cap, attempts: ATTEMPTS, systemPrompt: system });

  const attempt = async (n, failure) => {
    const prompt = n === 1
      ? `THE IDEA:\n${idea.trim()}`
      : `THE IDEA:\n${idea.trim()}\n\nYOUR LAST ATTEMPT WAS REJECTED:\n${failure}\n\nReturn the corrected JSON only.`;
    const { content } = await client.reason({ prompt, systemPrompt: system });
    const { parsed, error } = parseStrictJson(content);
    const outcome = error ? { fault: error } : derive(parsed, { style, seconds, cap });
    await journal.write('ideate.attempt', { attempt: n, of: ATTEMPTS, prompt, systemPrompt: system, content, fault: outcome.fault || null, capped: outcome.capped || null });
    if (!outcome.fault) return { ...outcome, calls: n };
    if (n < ATTEMPTS) return attempt(n + 1, outcome.fault);
    await journal.write('ideate.refused', { attempts: n, fault: outcome.fault, capped: outcome.capped || null });
    return refuse(outcome.capped ? 'E-IDEATE-PLATES-CAP' : 'E-IDEATE-FAULT', `ideation refused after ${n} attempts: ${outcome.fault}`);
  };

  const result = await attempt(1, null);
  await journal.write('ideate.result', { brief: result.brief, provenance: result.provenance, calls: result.calls });
  return result;
};
