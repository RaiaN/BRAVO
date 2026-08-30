import fs from 'node:fs';
import * as acorn from 'acorn';

// Keep only comments that are TOOLING DIRECTIVES, not commentary.
const KEEP = /^\s*(eslint|@ts-|prettier-|c8 |istanbul |global |@type\b|@jsx)/;

const jsx = (src) => src
  .replace(/<[A-Za-z][^]*?\/>/g, (m) => ' '.repeat(m.length))
  .replace(/<\/?[A-Za-z][^>]*>/g, (m) => ' '.repeat(m.length));

export const strip = (src) => {
  const comments = [];
  const parse = (text, opts) => acorn.parse(text, {
    ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true,
    onComment: comments, ...opts,
  });
  try { parse(src); } catch { return null; }

  const drop = comments.filter((c) => !KEEP.test(c.value));
  let out = src;
  for (const c of [...drop].sort((a, b) => b.start - a.start)) {
    const before = out.slice(0, c.start);
    const after = out.slice(c.end);
    const lineStart = before.lastIndexOf('\n') + 1;
    const onlyThing = before.slice(lineStart).trim() === '';
    if (onlyThing && after.startsWith('\n')) out = before.slice(0, lineStart) + after.slice(1);
    else if (onlyThing) out = before.slice(0, lineStart) + after;
    else out = before.replace(/[ \t]+$/, '') + after;
  }
  return out
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\{\n\n+/g, '{\n')
    .replace(/\n\n+(\s*\})/g, '\n$1')
    .replace(/^\n+/, '');
};

const files = process.argv.slice(2);
let ok = 0, skipped = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const out = strip(src);
  if (out === null) { skipped.push(f); continue; }
  if (out !== src) fs.writeFileSync(f, out);
  ok++;
}
console.log(`stripped ${ok} files`);
if (skipped.length) console.log('needs JSX-aware handling:', skipped.join(' '));
