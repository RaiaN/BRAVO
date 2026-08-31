import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'learned.json');

export const foldLearnedCases = (raw) => {
  if (!Array.isArray(raw)) throw new Error('learned.json must be an array of cases');
  return raw.map((c, i) => {
    if (!c.name?.trim() || !c.input?.trim() || !c.why?.trim()) {
      throw new Error(`learned.json case ${i}: name, input and why are required`);
    }
    if (!c.expect || typeof c.expect !== 'object' || !Object.keys(c.expect).length) {
      throw new Error(`learned.json case ${i}: a structural "expect" is required — a regression that cannot run protects nothing`);
    }
    if (!c.provenance?.note) {
      throw new Error(`learned.json case ${i}: provenance.note is required — every learned case traces to a ground-truth note`);
    }
    return { ...c, name: `learned · ${c.name}`, learned: true };
  });
};

export const loadLearnedCases = () => foldLearnedCases(JSON.parse(fs.readFileSync(FILE, 'utf8')));
