import { buildEntries, loadEntries, packProject, unpackProject } from '../core/bundle.js';
import { encodePng, decodePng } from './pngcodec.js';

export const PACKED_TYPE = {
  description: 'PixelArtist project',
  accept: { 'application/zip': ['.pixelproj'] },
};

export function supportsFS() { return 'showOpenFilePicker' in window; }

export async function savePacked(project, handle = null) {
  const bytes = await packProject(project, encodePng);
  if (supportsFS()) {
    if (!handle)
      handle = await window.showSaveFilePicker({
        suggestedName: `${project.name}.pixelproj`, types: [PACKED_TYPE] });
    const w = await handle.createWritable();
    await w.write(bytes); await w.close();
    return handle;
  }
  downloadBlob(new Blob([bytes]), `${project.name}.pixelproj`);
  return null;
}

export async function openPacked() {
  if (supportsFS()) {
    const [handle] = await window.showOpenFilePicker({ types: [PACKED_TYPE] });
    const file = await handle.getFile();
    const project = await unpackProject(new Uint8Array(await file.arrayBuffer()), decodePng);
    return { project, handle };
  }
  const file = await pickFileFallback('.pixelproj');
  const project = await unpackProject(new Uint8Array(await file.arrayBuffer()), decodePng);
  return { project, handle: null };
}

function pickFileFallback(accept) {
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement('input'),
      { type: 'file', accept });
    input.onchange = () => input.files[0] ? resolve(input.files[0]) : reject(new Error('cancelled'));
    input.click();
  });
}

export async function saveUnpacked(project, dirHandle = null) {
  if (!dirHandle) dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const entries = await buildEntries(project, encodePng);
  for (const { path, data } of entries) {
    const parts = path.split('/');
    let dir = dirHandle;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(parts.at(-1), { create: true });
    const w = await fh.createWritable();
    await w.write(data); await w.close();
  }
  return dirHandle;
}

export async function openUnpacked() {
  const dirHandle = await window.showDirectoryPicker();
  const entries = [];
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'file') {
        const f = await h.getFile();
        entries.push({ path: prefix + name, data: new Uint8Array(await f.arrayBuffer()) });
      } else await walk(h, `${prefix}${name}/`);
    }
  }
  await walk(dirHandle, '');
  const project = await loadEntries(entries, decodePng);
  return { project, dirHandle };
}

// ---- autosave (IndexedDB) ----
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pixelartist', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('autosave');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbOp(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('autosave', mode);
      const req = fn(tx.objectStore('autosave'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

export async function autosave(project) {
  const bytes = await packProject(project, encodePng);
  await idbOp('readwrite', store => store.put(bytes, 'latest'));
}
export async function loadAutosave() {
  const bytes = await idbOp('readonly', store => store.get('latest'));
  return bytes ? unpackProject(bytes, decodePng) : null;
}
export const clearAutosave = () => idbOp('readwrite', store => store.delete('latest'));

export async function exportPngBlob(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').putImageData(new ImageData(bitmap.data, bitmap.width, bitmap.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

export function downloadBlob(blob, filename) {
  const a = Object.assign(document.createElement('a'),
    { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}
