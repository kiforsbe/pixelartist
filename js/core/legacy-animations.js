// v2/v3 -> v4 animation conversion, run once by deserializeProject on files
// saved before auto layout. Strips, breaks, accepted/floating animations and
// animation-owned layer groups are gone in v4; this decides which old
// animations become `auto` and makes sure nothing that rendered differently
// in v3 renders differently now. Deliberately imports nothing from
// model.js (model.js imports this). See the animations workbench design §1.
import { createBitmap } from './pixels.js';
import { newId } from './palettes.js';

export const COVERED_FOLDER_NAME = 'Covered by strips (converted)';

function layersUnder(node, out = []) {
  for (const c of node.children ?? []) {
    if (c.type === 'layer') out.push(c);
    else layersUnder(c, out);
  }
  return out;
}

function groupsUnder(node, out = []) {
  if (node.type !== 'group') return out;
  out.push(node);
  for (const c of node.children ?? []) groupsUnder(c, out);
  return out;
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// An accepted strip with no breaks whose frames are equal-sized, share a
// pivot, sit edge to edge in one row in timeline order, appear once each,
// overlap no other accepted strip's frames (laying one out would carry
// pixels the other still shows), and are not already claimed by an earlier
// auto animation.
function qualifiesForAuto(anim, frames, claimed, othersRects) {
  if ((anim.breaks ?? []).length) return false;
  const list = (anim.frames ?? []).map(e => frames.get(e.frameId));
  if (!list.length || list.some(f => !f)) return false;
  if (new Set(list.map(f => f.id)).size !== list.length) return false;
  if (list.some(f => othersRects.some(r => r.id !== f.id && overlaps(f, r)))) return false;
  const [first] = list;
  return list.every((f, i) => !claimed.has(f.id) &&
    f.w === first.w && f.h === first.h && f.y === first.y && f.x === first.x + i * first.w &&
    f.pivotX === first.pivotX && f.pivotY === first.pivotY);
}

// v3 showed, at each pixel, the composite of the LAST accepted strip whose
// frames cover it -- or, outside every accepted strip's frames, the
// composite of all non-strip layers. Any non-empty pixel a layer could not
// show is moved (never deleted) into a hidden copy of that layer under one
// hidden folder, so the converted sheet renders identically.
function moveCoveredPixels(sheet, accepted, groups, frames) {
  if (!accepted.length) return;
  const W = sheet.width, H = sheet.height;
  const owner = new Int32Array(W * H).fill(-1);
  accepted.forEach((anim, s) => {
    for (const e of anim.frames) {
      const f = frames.get(e.frameId);
      if (!f) continue;
      const x0 = Math.max(0, f.x), x1 = Math.min(W, f.x + f.w);
      if (x1 <= x0) continue;
      for (let y = Math.max(0, f.y); y < Math.min(H, f.y + f.h); y++) owner.fill(s, y * W + x0, y * W + x1);
    }
  });
  const layerOwner = new Map();
  accepted.forEach((anim, s) => { for (const l of layersUnder(groups.get(anim.layerGroupId))) layerOwner.set(l, s); });
  let folder = null;
  for (const layer of layersUnder(sheet.layerTree)) {
    const own = layerOwner.get(layer) ?? -1;
    const d = layer.bitmap.data;
    let target = null;
    for (let p = 0; p < W * H; p++) {
      if (d[p * 4 + 3] === 0 || owner[p] === own) continue;
      if (!target) {
        folder ??= { id: newId('gp'), type: 'group', name: COVERED_FOLDER_NAME, open: false, children: [] };
        target = { id: newId('ly'), type: 'layer', name: layer.name, visible: false, opacity: layer.opacity, locked: false, bitmap: createBitmap(W, H) };
        folder.children.push(target);
      }
      target.bitmap.data.set(d.subarray(p * 4, p * 4 + 4), p * 4);
      d.fill(0, p * 4, p * 4 + 4);
    }
  }
  if (folder) sheet.layerTree.children.unshift(folder); // children[0] composites first: the bottom
}

export function convertLegacySheet(sheet) {
  const frames = new Map(sheet.frames.map(f => [f.id, f]));
  const groups = new Map(groupsUnder(sheet.layerTree).map(g => [g.id, g]));
  const accepted = sheet.animations.filter(a => a.strip && a.layerGroupId && groups.has(a.layerGroupId));
  moveCoveredPixels(sheet, accepted, groups, frames);
  const claimed = new Set();
  for (const anim of sheet.animations) {
    const othersRects = accepted.filter(a => a !== anim)
      .flatMap(a => a.frames.map(e => frames.get(e.frameId)).filter(Boolean));
    const auto = accepted.includes(anim) && qualifiesForAuto(anim, frames, claimed, othersRects);
    anim.layout = auto ? 'auto' : 'manual';
    anim.cell = null;
    if (!auto) continue;
    const first = frames.get(anim.frames[0].frameId);
    anim.cell = { w: first.w, h: first.h };
    for (const e of anim.frames) claimed.add(e.frameId);
  }
}
