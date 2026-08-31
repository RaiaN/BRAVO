import { validatePartition } from './partition.js';

const canon = (x) => String(x || '').trim().toUpperCase();

const v = (ruleId, subject, pass, value, threshold, detail) => ({ ruleId, subject, pass, value, threshold, detail: detail || null });

export const CHECKS = {
  'SCR-008': ({ brief }, params) => {
    const missing = [];
    if (!String(brief?.logline || '').trim()) missing.push('logline');
    if (!Number.isInteger(brief?.targetSeconds)) missing.push('targetSeconds');
    if (!Array.isArray(brief?.cast)) missing.push('cast');
    if (!Array.isArray(brief?.locations)) missing.push('locations');
    if (brief?.format?.fps !== params.fps) missing.push(`format.fps=${params.fps}`);
    return [v('SCR-008', 'brief', missing.length === 0, missing.join(','), 'all present', missing.length ? `missing or wrong: ${missing.join(', ')}` : null)];
  },

  'SCR-001': ({ screenplay }) => {
    const scenes = screenplay?.scenes;
    if (!Array.isArray(scenes) || !scenes.length) return [v('SCR-001', 'screenplay', false, 0, '>=1 scene', 'no scenes')];
    return scenes.map((s, i) => {
      const slugOk = s.slug && ['INT', 'EXT'].includes(s.slug.intExt) && String(s.slug.location || '').trim() && String(s.slug.time || '').trim();
      const actionOk = Array.isArray(s.action) && s.action.some((a) => String(a).trim());
      return v('SCR-001', `scene ${i + 1}`, !!(slugOk && actionOk), null, 'slugline + action', !slugOk ? 'bad slugline' : (!actionOk ? 'no action line' : null));
    });
  },

  'SCR-002': ({ brief, screenplay }) => {
    const d = brief?.dramatis || {};
    const declared = ['protagonist', 'want', 'opposition'].filter((k) => String(d[k] || '').trim());
    if (declared.length !== 3) {
      return [v('SCR-002', 'brief', false, declared.join(','), 'protagonist+want+opposition', `undeclared: ${['protagonist', 'want', 'opposition'].filter((k) => !declared.includes(k)).join(', ')}`)];
    }
    const castNames = (brief?.cast || []).map((c) => canon(c.name));
    if (!castNames.includes(canon(d.protagonist))) {
      return [v('SCR-002', 'brief', false, d.protagonist, 'a cast member by name', `dramatis.protagonist ${JSON.stringify(d.protagonist)} is not the name of anyone in the cast`)];
    }
    const text = canon(JSON.stringify(screenplay || {}));
    const protagonistAppears = text.includes(canon(d.protagonist));
    const oppositionAppears = text.includes(canon(d.opposition))
      || (screenplay?.scenes || []).some((sc) => sc.antagonism === true);
    const missing = [!protagonistAppears && 'protagonist', !oppositionAppears && 'opposition'].filter(Boolean);
    return [v('SCR-002', 'screenplay', missing.length === 0, null, 'both staged', missing.length ? `never appear in the screenplay: ${missing.join(', ')}` : null)];
  },

  'SCR-003': ({ brief, screenplay }) => {
    const opp = String(brief?.dramatis?.opposition || '').trim();
    if (!opp) return [v('SCR-003', 'screenplay', false, null, 'opposition staged', 'no opposition declared (SCR-002)')];
    const staged = (screenplay?.scenes || []).some((s) => s.antagonism === true
      || (Array.isArray(s.action) && s.action.some((a) => canon(a).includes(canon(opp)))));
    return [v('SCR-003', 'screenplay', staged, staged, 'opposition acts inside a scene', staged ? null : 'the opposition is described but never acts on screen')];
  },

  'SCR-004': ({ screenplay }) => (screenplay?.scenes || []).map((s, i) => {
    const t = s.turn;
    const ok = t && String(t.from || '').trim() && String(t.to || '').trim() && t.from !== t.to;
    return v('SCR-004', `scene ${i + 1}`, !!ok, t ? `${t.from} -> ${t.to}` : null, 'declared value change', ok ? null : 'no turn, or it opens and closes in the same state');
  }),

  'SCR-005': ({ beats, shots }) => {
    const out = [];
    const beatIds = new Set((beats || []).map((b) => b.id));
    for (const b of beats || []) {
      const covered = (shots || []).some((s) => s.beatId === b.id);
      out.push(v('SCR-005', `beat ${b.id}`, covered, covered, 'covered by >=1 shot', covered ? null : 'orphan beat'));
    }
    for (const s of shots || []) {
      const serves = beatIds.has(s.beatId);
      out.push(v('SCR-005', `shot ${s.id}`, serves, s.beatId || null, 'serves a declared beat', serves ? null : 'decorative shot — serves no beat'));
    }
    return out;
  },

  'SCR-006': ({ screenplay, shots }) => {
    const lines = (screenplay?.scenes || []).flatMap((s) => (s.dialogue || []).map((dl) => dl.line));
    return lines.map((line) => {
      const holders = (shots || []).filter((s) => String(s.prompt || '').includes(`{${line}}`));
      return v('SCR-006', `line "${line.slice(0, 40)}"`, holders.length === 1, holders.length, 'verbatim in exactly one prompt', holders.length === 0 ? 'line lost' : (holders.length > 1 ? 'line duplicated across shots' : null));
    });
  },

  'SCR-007': ({ brief, screenplay, plates }) => {
    const known = new Map();
    for (const c of brief?.cast || []) known.set(canon(c.name), c.bibleEntryId);
    for (const l of brief?.locations || []) known.set(canon(l.name), l.bibleEntryId);
    const text = canon(JSON.stringify(screenplay || {}));
    const named = new Set();
    for (const s of screenplay?.scenes || []) {
      for (const dl of s.dialogue || []) named.add(canon(dl.character));
      if (s.slug?.location) named.add(canon(s.slug.location));
    }
    for (const name of known.keys()) {
      if (text.includes(name)) named.add(name);
    }
    return [...named].map((name) => {
      const res = known.get(name);
      const isNew = res === 'new';
      const hasPlate = isNew && (plates || []).some((p) => canon(p.entity) === name);
      const ok = (res && res !== 'new') || (isNew && hasPlate);
      return v('SCR-007', `entity "${name}"`, !!ok, res || 'dangling', 'bible id, or new with a plate line item', ok ? null : (res ? 'declared new but no plate in the manifest' : 'never declared in the brief'));
    });
  },

  'CIN-001': ({ shots }, params) => (shots || []).map((s) => {
    const ok = params.vocabulary.includes(s.setup);
    return v('CIN-001', `shot ${s.id}`, ok, s.setup || null, 'a setup from the camera library', ok ? null : 'unknown or missing setup');
  }),

  'CIN-002': ({ screenplay, shots }, params) => {
    const sceneSide = new Map((screenplay?.scenes || []).map((s, i) => [s.id ?? String(i + 1), s.side]));
    const out = [];
    for (const [sceneId, side] of sceneSide) {
      out.push(v('CIN-002', `scene ${sceneId}`, params.sides.includes(side), side || null, 'declares a side', params.sides.includes(side) ? null : 'no line-of-action side declared'));
    }
    for (const s of shots || []) {
      const want = sceneSide.get(s.sceneId);
      const ok = want && s.side === want;
      out.push(v('CIN-002', `shot ${s.id}`, !!ok, s.side || null, `scene side ${want || '?'}`, ok ? null : 'crosses the line'));
    }
    return out;
  },

  'CIN-005': ({ brief, shots, slot }, params, ctx) => {
    const durations = (shots || []).map((s) => s.seconds);
    const r = validatePartition(brief?.targetSeconds, durations, { kMin: params.kMin, kMax: params.kMax, dMin: params.dMin, dMax: ctx.maxSeconds(slot) });
    return [v('CIN-005', 'shotplan', r.ok, durations.join('+'), `sum ${brief?.targetSeconds}, each in [${params.dMin}, ${ctx.maxSeconds(slot)}]`, r.ok ? null : r.reason)];
  },

  'CIN-006': ({ shots }, params) => {
    const seen = new Set();
    const out = [];
    for (const s of shots || []) {
      const loc = canon(s.location);
      if (!loc) continue;
      if (!seen.has(loc)) {
        seen.add(loc);
        const isEstablishing = params.establishing.includes(s.setup);
        const overridden = Array.isArray(s.flags) && s.flags.includes(params.overrideFlag);
        if (params.close.includes(s.setup) && !overridden) {
          out.push(v('CIN-006', `shot ${s.id}`, false, s.setup, 'wide or full first at a new location', `first look at "${loc}" is a close setup with no declared override`));
        } else {
          out.push(v('CIN-006', `shot ${s.id}`, true, s.setup, 'establishes or declares override', overridden ? 'override declared and recorded' : null));
        }
        void isEstablishing;
      }
    }
    return out;
  },

  'CIN-004': ({ perShot }, params) => (perShot || []).map((m) => {
    const ok = m.fps === params.fps;
    return v('CIN-004', `take ${m.shotId}`, ok, m.fps, params.fps, ok ? null : 'wrong frame rate — a model property, not a retryable failure');
  }),

  'CIN-007': ({ perShot }, params) => (perShot || []).map((m) => {
    const budget = params.toleranceTotal / (perShot.length || 1);
    const overshoot = m.measured - m.requested;
    const ok = m.measured >= m.requested && overshoot <= budget;
    return v('CIN-007', `take ${m.shotId}`, ok, `${m.measured}s for ${m.requested}s`, `>= plan, overshoot <= ${budget.toFixed(3)}s`, ok ? null : (m.measured < m.requested ? 'short take' : 'overshoot exceeds its share of the tolerance'));
  }),

  'CIN-008': ({ timeline, brief }, params) => {
    const delta = Math.abs(timeline.totalMeasured - brief.targetSeconds);
    return [v('CIN-008', 'timeline', delta <= params.tolerance, `${timeline.totalMeasured}s`, `${brief.targetSeconds}s +/- ${params.tolerance}`, delta <= params.tolerance ? null : `off by ${delta.toFixed(3)}s`)];
  },

  'CIN-003': ({ joins }, params) => (joins || []).map((j) => {
    const recorded = v('CIN-003', `join ${j.from}->${j.to}`, params.theta === null ? true : j.distance <= params.theta, j.distance, params.theta === null ? 'recording (uncalibrated)' : `<= ${params.theta}`, null);
    return recorded;
  }),

  'CIN-009': ({ perShot }, params) => (perShot || []).map((m) => v('CIN-009', `take ${m.shotId}`, true, `black ${m.blackFraction ?? '?'} frozen ${m.frozenFraction ?? '?'}`, params.maxBlackFraction === null ? 'recording (uncalibrated)' : `<= ${params.maxBlackFraction}`, null)),
};

const run = (rules, payload, ctx) => {
  const results = [];
  for (const rule of rules) {
    const check = CHECKS[rule.id];
    const found = check(payload, rule.params || {}, ctx);
    for (const r of found) {
      results.push({ ...r, class: rule.class, blocking: rule.blocking && rule.status === 'active', failureKind: rule.failureKind || 'deterministic' });
    }
  }
  return results;
};

const failed = (results) => results.filter((r) => r.blocking && !r.pass);

export const runPlanGates = (rulebook, payload, ctx) => {
  const stages = [
    ['brief', rulebook.rulesFor('brief', 'plan')],
    ['screenplay', rulebook.rulesFor('screenplay', 'plan')],
    ['shotplan', rulebook.rulesFor('shotplan', 'plan')],
  ];
  const all = [];
  for (const [stage, rules] of stages) {
    const results = run(rules, payload, ctx);
    all.push(...results);
    const blockers = failed(results);
    if (blockers.length) return { pass: false, haltedAt: stage, results: all, blockers };
  }
  return { pass: true, haltedAt: null, results: all, blockers: [] };
};

export const runMeasureGates = (rulebook, payload, ctx) => {
  const rules = ['perShot', 'joins', 'timeline'].flatMap((a) => rulebook.rulesFor(a, 'measure'));
  const results = run(rules, payload, ctx);
  const blockers = failed(results);
  return { pass: blockers.length === 0, results, blockers };
};
