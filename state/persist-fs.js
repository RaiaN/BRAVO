import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { hydrateProject } from './project.js';

const FILE = 'project.json';

let tmpCounter = 0;

export const saveProjectFs = async (dir, project) => {
  if (typeof dir !== 'string' || !dir) throw new Error('saveProjectFs needs a "dir"');
  const file = path.join(dir, FILE);
  hydrateProject(project, file);
  fs.mkdirSync(dir, { recursive: true });
  tmpCounter += 1;
  const tmp = path.join(dir, `.${FILE}.${process.pid}.${tmpCounter.toString(36)}.tmp`);
  const handle = await fsp.open(tmp, 'wx');
  try {
    await handle.writeFile(JSON.stringify(project, null, 1));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
  const dirHandle = await fsp.open(dir, 'r');
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
  return file;
};

export const loadProjectFs = async (dir) => {
  if (typeof dir !== 'string' || !dir) throw new Error('loadProjectFs needs a "dir"');
  const file = path.join(dir, FILE);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`No project at "${file}" (${err.code}) — nothing was loaded`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`The saved film at "${file}" could not be read (${err.message}). It has NOT been overwritten.`);
  }
  return hydrateProject(parsed, file);
};
