// Free-space finder for auto-placing animation strips. Candidate positions are
// the sheet origin plus every existing frame's right/bottom edge — the only
// places a first-fit rectangle can start.
export function findFreeRect(sheet, w, h) {
  if (w > sheet.width || h > sheet.height) return null;
  const frames = sheet.frames;
  const xs = [...new Set([0, ...frames.map(f => f.x + f.w)])]
    .filter(x => x >= 0 && x + w <= sheet.width).sort((a, b) => a - b);
  const ys = [...new Set([0, ...frames.map(f => f.y + f.h)])]
    .filter(y => y >= 0 && y + h <= sheet.height).sort((a, b) => a - b);
  for (const y of ys)
    for (const x of xs)
      if (!frames.some(f => x < f.x + f.w && f.x < x + w && y < f.y + f.h && f.y < y + h))
        return { x, y };
  return null;
}

export function buildStripFrames(name, x, y, frameW, frameH, count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `${name}_${i}`, x: x + i * frameW, y, w: frameW, h: frameH,
    pivotX: 0, pivotY: 0,
  }));
}

// ---------------------------------------------------------------- segments
// A strip animation may carry `breaks`: sorted indices into anim.frames where
// a new spatial SEGMENT starts. Segments move independently on the sheet;
// playback always uses the full frames order. All helpers below are pure —
// they take/return plain arrays and never touch the sheet.

export function normalizeBreaks(breaks, len) {
  return [...new Set(breaks ?? [])]
    .filter(b => Number.isInteger(b) && b >= 1 && b <= len - 1)
    .sort((a, b) => a - b);
}

export function segmentsOf(anim) {
  const len = anim.frames.length;
  if (len === 0) return [];
  const starts = [0, ...normalizeBreaks(anim.breaks, len)];
  return starts.map((s, i) => ({ start: s, end: starts[i + 1] ?? len, index: i }));
}

export function segmentOfFrame(anim, frameId) {
  const i = anim.frames.findIndex(e => e.frameId === frameId);
  if (i < 0) return null;
  return segmentsOf(anim).find(r => i >= r.start && i < r.end) ?? null;
}

// Movable content under a point, for the move tool: the strip SEGMENT whose
// members contain (x, y) — a sub-strip wins over its parent strip by
// construction — else the topmost plain frame. Returns the bounding rect plus
// the member frame ids (so a float commit can move the frames with the
// pixels), or null when the point hits no frame.
export function segmentAt(sheet, x, y) {
  const within = (f) => x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h;
  for (const a of sheet.animations) {
    if (!a.strip) continue;
    for (const run of segmentsOf(a)) {
      const members = a.frames.slice(run.start, run.end)
        .map(e => sheet.frames.find(f => f.id === e.frameId))
        .filter(Boolean);
      if (!members.length || !members.some(within)) continue;
      const x0 = Math.min(...members.map(f => f.x));
      const y0 = Math.min(...members.map(f => f.y));
      const x1 = Math.max(...members.map(f => f.x + f.w));
      const y1 = Math.max(...members.map(f => f.y + f.h));
      return { rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, frameIds: members.map(f => f.id) };
    }
  }
  for (let i = sheet.frames.length - 1; i >= 0; i--) {
    const f = sheet.frames[i];
    if (within(f)) return { rect: { x: f.x, y: f.y, w: f.w, h: f.h }, frameIds: [f.id] };
  }
  return null;
}

// When `index` lands exactly on a break, the new entry could join the segment
// ending there (attachLeft: break shifts right) or the one starting there
// (break stays). Interior/end-of-array indexes are unaffected by the flag.
export function insertEntry(entries, breaks, index, entry, attachLeft) {
  const out = entries.slice();
  out.splice(index, 0, entry);
  const bs = (breaks ?? []).map(b => (b > index || (b === index && attachLeft)) ? b + 1 : b);
  return { entries: out, breaks: normalizeBreaks(bs, out.length) };
}

export function removeEntry(entries, breaks, index) {
  const out = entries.slice();
  out.splice(index, 1);
  const bs = (breaks ?? []).map(b => (b > index ? b - 1 : b));
  return { entries: out, breaks: normalizeBreaks(bs, out.length) };
}

function runsOf(o) {
  return segmentsOf(o).map(r => o.frames.slice(r.start, r.end));
}

function pack(runs) {
  const frames = runs.flat();
  const breaks = [];
  let acc = 0;
  for (let i = 0; i < runs.length - 1; i++) { acc += runs[i].length; breaks.push(acc); }
  return { frames, breaks };
}

// side 'before' = dragged frames precede the target run in the fused segment
// (the "drop C's right end at A's left end" case); 'after' = they follow it.
export function mergeSegments(anim, dragIdx, targetIdx, side) {
  const runs = runsOf(anim);
  const [dragged] = runs.splice(dragIdx, 1);
  const t = targetIdx > dragIdx ? targetIdx - 1 : targetIdx;
  runs[t] = side === 'before' ? [...dragged, ...runs[t]] : [...runs[t], ...dragged];
  return pack(runs);
}

export function transferSegment(src, dst, dragIdx, targetIdx, side) {
  const sRuns = runsOf(src);
  const [dragged] = sRuns.splice(dragIdx, 1);
  const dRuns = runsOf(dst);
  dRuns[targetIdx] = side === 'before'
    ? [...dragged, ...dRuns[targetIdx]] : [...dRuns[targetIdx], ...dragged];
  return { src: pack(sRuns), dst: pack(dRuns) };
}
