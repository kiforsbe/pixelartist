import { serializeProject, deserializeProject, validateProjectJson } from './model.js';
import { zipWrite, zipRead } from './zip.js';

export async function buildEntries(project, encodePng) {
  const { json, images } = serializeProject(project);
  const entries = [{
    path: 'project.json',
    data: new TextEncoder().encode(JSON.stringify(json, null, 2)),
  }];
  for (const img of images)
    entries.push({ path: img.path, data: await encodePng(img.bitmap) });
  return entries;
}

export async function loadEntries(entries, decodePng) {
  const meta = entries.find(e => e.path === 'project.json');
  if (!meta) throw new Error('bundle has no project.json');
  let json;
  try { json = JSON.parse(new TextDecoder().decode(meta.data)); }
  catch { throw new Error('project.json is not valid JSON'); }
  const v = validateProjectJson(json);
  if (!v.ok) throw new Error(`invalid project: ${v.error}`);
  const imagesByPath = new Map();
  for (const e of entries)
    if (e.path !== 'project.json') imagesByPath.set(e.path, await decodePng(e.data));
  return deserializeProject(json, imagesByPath);
}

export const packProject = async (project, encodePng) =>
  zipWrite(await buildEntries(project, encodePng));

export const unpackProject = async (bytes, decodePng) =>
  loadEntries(await zipRead(bytes), decodePng);
