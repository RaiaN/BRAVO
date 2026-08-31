import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLearnedCases, loadLearnedCases } from '../../tests/agents/director/learned.js';
import { cases } from '../../tests/agents/director/cases.js';

test('an empty learned book loads and folds into the director suite', () => {
  const learned = loadLearnedCases();
  assert.ok(Array.isArray(learned));
  assert.ok(cases.length >= 7, 'seed cases stay present');
  for (const c of cases) {
    assert.ok(c.name && c.input && c.expect, `case "${c.name}" is runnable`);
  }
});

test('a learned case missing its running parts refuses to load', () => {
  const good = { name: 'n', input: 'i', why: 'w', expect: { planLands: true }, provenance: { note: 'note_1' } };
  assert.deepEqual(foldLearnedCases([good])[0].learned, true);
  assert.match(foldLearnedCases([good])[0].name, /^learned · /);
  assert.throws(() => foldLearnedCases([{ ...good, expect: {} }]), /structural "expect"/);
  assert.throws(() => foldLearnedCases([{ ...good, provenance: {} }]), /provenance\.note/);
  assert.throws(() => foldLearnedCases([{ ...good, input: ' ' }]), /name, input and why/);
  assert.throws(() => foldLearnedCases({}), /array/);
});
