import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBreaks, segmentsOf, segmentOfFrame,
  insertEntry, removeEntry, mergeSegments, transferSegment,
} from '../js/core/strips.js';

const entries = (...ids) => ids.map(id => ({ frameId: id, duration: 100 }));
const ids = (list) => list.map(e => e.frameId);

test('normalizeBreaks sorts, dedupes, clamps to 1..len-1', () => {
  assert.deepEqual(normalizeBreaks([3, 1, 3, 0, 9, -2, 2.5], 4), [1, 3]);
  assert.deepEqual(normalizeBreaks(undefined, 4), []);
});

test('segmentsOf: no breaks = one run; breaks split into runs with index', () => {
  const anim = { frames: entries('a', 'b', 'c', 'd') };
  assert.deepEqual(segmentsOf(anim), [{ start: 0, end: 4, index: 0 }]);
  anim.breaks = [3];
  assert.deepEqual(segmentsOf(anim), [
    { start: 0, end: 3, index: 0 }, { start: 3, end: 4, index: 1 }]);
  assert.deepEqual(segmentsOf({ frames: [], breaks: [] }), []);
});

test('segmentOfFrame finds the containing run', () => {
  const anim = { frames: entries('a', 'b', 'c', 'd'), breaks: [2] };
  assert.deepEqual(segmentOfFrame(anim, 'c'), { start: 2, end: 4, index: 1 });
  assert.equal(segmentOfFrame(anim, 'zz'), null);
});

test('insertEntry interior: breaks above shift', () => {
  const r = insertEntry(entries('a', 'b', 'c', 'd'), [3], 1, { frameId: 'X', duration: 50 }, false);
  assert.deepEqual(ids(r.entries), ['a', 'X', 'b', 'c', 'd']);
  assert.deepEqual(r.breaks, [4]);
});

test('insertEntry at a break: attachLeft decides which segment grows', () => {
  const e = entries('a', 'b', 'c', 'd');
  // segment end (attachLeft=true): break shifts, X belongs to first segment
  const left = insertEntry(e, [2], 2, { frameId: 'X', duration: 50 }, true);
  assert.deepEqual(ids(left.entries), ['a', 'b', 'X', 'c', 'd']);
  assert.deepEqual(left.breaks, [3]);
  // segment start (attachLeft=false): break stays, X belongs to second segment
  const right = insertEntry(e, [2], 2, { frameId: 'X', duration: 50 }, false);
  assert.deepEqual(right.breaks, [2]);
});

test('removeEntry shifts breaks and drops degenerate ones', () => {
  const r = removeEntry(entries('a', 'b', 'c', 'd'), [2], 3);
  assert.deepEqual(ids(r.entries), ['a', 'b', 'c']);
  assert.deepEqual(r.breaks, [2]);
  // removing the only frame of the trailing segment drops its break
  const r2 = removeEntry(r.entries, r.breaks, 2);
  assert.deepEqual(ids(r2.entries), ['a', 'b']);
  assert.deepEqual(r2.breaks, []);
});

test("mergeSegments 'before': dragged segment's frames come first (C-before-A)", () => {
  // segments: [a,b] and [c,d]; drag idx1 before idx0 → c,d,a,b as ONE segment
  const anim = { frames: entries('a', 'b', 'c', 'd'), breaks: [2] };
  const r = mergeSegments(anim, 1, 0, 'before');
  assert.deepEqual(ids(r.frames), ['c', 'd', 'a', 'b']);
  assert.deepEqual(r.breaks, []);
});

test("mergeSegments 'after' keeps other segments' order and breaks", () => {
  // segments: [a] [b] [c,d]; drag idx0 after idx2 → [b] [c,d,a]
  const anim = { frames: entries('a', 'b', 'c', 'd'), breaks: [1, 2] };
  const r = mergeSegments(anim, 0, 2, 'after');
  assert.deepEqual(ids(r.frames), ['b', 'c', 'd', 'a']);
  assert.deepEqual(r.breaks, [1]);
});

test('transferSegment moves a run across animations; source may empty', () => {
  const src = { frames: entries('c0', 'c1'), breaks: [] };
  const dst = { frames: entries('a0', 'a1'), breaks: [] };
  const r = transferSegment(src, dst, 0, 0, 'before');
  assert.deepEqual(ids(r.src.frames), []);
  assert.deepEqual(ids(r.dst.frames), ['c0', 'c1', 'a0', 'a1']);
  assert.deepEqual(r.dst.breaks, []);
});

test('transferSegment with multi-segment source keeps the rest', () => {
  const src = { frames: entries('s0', 's1', 's2'), breaks: [1] }; // [s0] [s1,s2]
  const dst = { frames: entries('d0'), breaks: [] };
  const r = transferSegment(src, dst, 1, 0, 'after');
  assert.deepEqual(ids(r.src.frames), ['s0']);
  assert.deepEqual(r.src.breaks, []);
  assert.deepEqual(ids(r.dst.frames), ['d0', 's1', 's2']);
});
