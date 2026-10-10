// Pointer-event drag-reorder shared by every reorderable list (layer tree,
// map layers, animations list, timeline strips). One indicator vocabulary
// (.dr-*), one set of index rules; hit-testing and index maths are pure
// functions exported for the call sites and tests.
//
// Items carry `data-drag-key`; onDrop receives keys plus the placement, and
// the call site turns that into its own command (slotToFinalIndex for flat
// lists, treeDropDestination for the layer tree).

const DEFAULT_IGNORE = 'button,input,select,textarea,[data-no-drag]';
const EDGE = 24;        // px from the scroller edge where auto-scroll starts
const MAX_SCROLL = 16;  // px per frame at the very edge
const TREE_INDENT = 14; // px per tree level (matches the layer rows)

// ------------------------------------------------------------------ pure

function span(rect, axis) {
  return axis === 'x' ? [rect.left, rect.left + rect.width] : [rect.top, rect.top + rect.height];
}

// Which item the point is over and where: 'before' / 'after' the item along
// `axis` (above/below, or left/right), or 'into' a tree group. `tree` is null
// or an array parallel to `rects` of { isGroup }. Points beyond the ends
// clamp to the first/last item; a point in a gap snaps to the nearer item,
// so the result never flickers between rows.
export function computePlacement(rects, point, axis = 'y', tree = null) {
  if (!rects.length) return null;
  const pos = axis === 'x' ? point.x : point.y;
  let index = rects.length - 1, frac = 1;
  for (let i = 0; i < rects.length; i++) {
    const [start, end] = span(rects[i], axis);
    if (pos < start) {
      if (i === 0) { index = 0; frac = 0; break; }
      const [, prevEnd] = span(rects[i - 1], axis);
      if (pos - prevEnd < start - pos) { index = i - 1; frac = 1; } else { index = i; frac = 0; }
      break;
    }
    if (pos < end) { index = i; frac = (pos - start) / Math.max(1, end - start); break; }
  }
  let place;
  if (tree?.[index]?.isGroup) place = frac < 1 / 3 ? 'before' : frac >= 2 / 3 ? 'after' : 'into';
  else place = frac < 0.5 ? 'before' : 'after';
  return { index, place };
}

// The insertion slot (0..n, counted before the source is removed) of a flat
// placement; null for 'into'.
export function placementSlot(placement) {
  if (!placement || placement.place === 'into') return null;
  return placement.index + (placement.place === 'after' ? 1 : 0);
}

// The index an item ends up at when moved from `from` to pre-removal `slot`.
export function slotToFinalIndex(from, slot) {
  return slot > from ? slot - 1 : slot;
}

// True when a flat-list placement leaves the source where it is.
export function isNoOpDrop(sourceIndex, placement) {
  if (!placement) return true;
  const { index, place } = placement;
  if (index === sourceIndex) return true;
  return (place === 'after' && index === sourceIndex - 1) || (place === 'before' && index === sourceIndex + 1);
}

function subtreeContains(node, target) {
  return (node.children ?? []).some(child => child === target || subtreeContains(child, target));
}

// Maps a visual placement over layer-tree rows (layer-tree.js layerTreeRows:
// the LAST child is shown first) to the `dragMoveNode` arguments:
// { destParentId (null = root), destIndex (pre-removal slot, as model.moveNode
// expects), noOp }. Below row B lands visually below B; below an expanded
// group with children goes to the top of that group. Returns null when the
// drop is impossible (unknown node/row, or a group into its own subtree).
export function treeDropDestination(root, rows, sourceId, placement) {
  const row = placement ? rows[placement.index] : null;
  if (!row) return null;
  const where = new Map();
  (function walk(group) {
    (group.children ?? []).forEach((child, index) => {
      where.set(child.id, { parent: group, index });
      if (child.children) walk(child);
    });
  })(root);
  const src = where.get(sourceId);
  const at = where.get(row.node.id);
  if (!src || !at) return null;
  const source = src.parent.children[src.index];
  const target = row.node;
  const intoTop = group => ({ parent: group, index: group.children.length });
  let dest;
  if (target === source) dest = { parent: src.parent, index: src.index };
  else if (placement.place === 'into' && target.type === 'group') dest = intoTop(target);
  else if (placement.place === 'after' && target.type === 'group' && target.open !== false && target.children.length) dest = intoTop(target);
  // Display order is reversed: above a row = one child index higher.
  else dest = { parent: at.parent, index: at.index + (placement.place === 'before' ? 1 : 0) };
  if (dest.parent === source || subtreeContains(source, dest.parent)) return null;
  const noOp = dest.parent === src.parent && (dest.index === src.index || dest.index === src.index + 1);
  return { destParentId: dest.parent === root ? null : dest.parent.id, destIndex: dest.index, noOp };
}

// ------------------------------------------------------------- component

function findScroller(el, axis) {
  if (typeof getComputedStyle !== 'function') return null;
  for (let node = el; node; node = node.parentElement) {
    const overflow = getComputedStyle(node)[axis === 'x' ? 'overflowX' : 'overflowY'];
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
}

// Makes the items of `container` (matched by itemSelector, each with
// data-drag-key) reorderable by pointer drag. Returns dispose().
//
//   onDrop({ sourceKey, targetKey, sourceIndex, index, place, slot, modifiers })
//   canDrop(sourceKey, { targetKey, index, place, slot, modifiers }) -> boolean
//   tree: { depth(el) -> number, isGroup(el) -> boolean, indent? = 14 }
//   allowInPlace(modifiers) -> boolean: true lets a drop land where the
//     source already is (a copy or linked use beside itself), re-asked as
//     the modifier keys change during the drag
//
// Indexes are positions among the items at drag start (top/left first);
// `slot` is placementSlot (null for 'into').
export function attachDragReorder(container, {
  axis = 'y',
  itemSelector,
  handleSelector = null,
  ignoreSelector = DEFAULT_IGNORE,
  threshold = 4,
  tree = null,
  canDrop = () => true,
  modifiers = () => ({}),
  allowInPlace = () => false,
  onDrop,
  scroller = undefined,
} = {}) {
  let pending = null;       // pressed, not yet past the threshold
  let drag = null;          // an active drag
  let swallowClick = false; // the click that follows a drag/cancel
  let swallowPointer = null;// cancelled with the button still down
  let listening = false;

  const keyOf = (el, index) => el.dataset?.dragKey ?? String(index);
  const scrollPos = sc => (sc ? `${sc.scrollLeft},${sc.scrollTop}` : '');
  const samePointer = e => e.pointerId === undefined || e.pointerId === (drag ?? pending)?.pointerId;

  function listen(on) {
    if (on === listening) return;
    listening = on;
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('pointermove', onMove, true);
    window[method]('pointerup', onUp, true);
    window[method]('pointercancel', onCancel, true);
    window[method]('keydown', onKey, true);
    window[method]('keyup', onKey, true);
  }

  function onPointerDown(e) {
    if (drag || pending || (e.button ?? 0) !== 0) return;
    const hit = e.target;
    const item = hit?.closest?.(itemSelector);
    if (!item || item === container || !container.contains(item)) return;
    if (ignoreSelector) {
      const ignored = hit.closest(ignoreSelector);
      if (ignored && ignored !== item && item.contains(ignored)) return;
    }
    if (handleSelector) {
      const handle = hit.closest(handleSelector);
      if (!handle || !item.contains(handle)) return;
    }
    swallowPointer = null;
    pending = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, item };
    listen(true);
  }

  function measure() {
    drag.rects = drag.items.map(el => el.getBoundingClientRect());
    drag.scrollPos = scrollPos(drag.scroller);
  }

  function start(e) {
    const items = [...container.querySelectorAll(itemSelector)];
    const sourceIndex = items.indexOf(pending.item);
    const { pointerId } = pending;
    pending = null;
    if (sourceIndex < 0) { listen(false); return; }
    const info = tree ? items.map(el => ({ depth: Number(tree.depth?.(el) ?? 0), isGroup: !!tree.isGroup?.(el) })) : null;
    // A tree source's visible descendants follow it, one level deeper or more.
    let subtreeEnd = sourceIndex;
    if (info) while (subtreeEnd + 1 < items.length && info[subtreeEnd + 1].depth > info[sourceIndex].depth) subtreeEnd++;
    const line = document.createElement('div');
    line.className = `dr-line dr-${axis}`;
    line.hidden = true;
    drag = {
      items, info, sourceIndex, subtreeEnd, pointerId, line,
      source: items[sourceIndex], sourceKey: keyOf(items[sourceIndex], sourceIndex),
      scroller: scroller === undefined ? findScroller(container, axis) : scroller,
      point: null, mods: {}, placement: null, valid: false, noOp: true, intoEl: null, frame: null,
    };
    measure();
    (document.body ?? container).appendChild(line);
    drag.source.classList.add('dr-lifted');
    container.classList.add('dr-active');
    drag.scroller?.addEventListener('scroll', onScroll);
    try { container.setPointerCapture?.(pointerId); } catch { /* pointer already gone */ }
    globalThis.getSelection?.()?.removeAllRanges?.();
    update(e);
  }

  function isNoOp(placement) {
    const { sourceIndex, subtreeEnd, info } = drag;
    const { index, place } = placement;
    if (index === sourceIndex) return true;
    if (!info) return isNoOpDrop(sourceIndex, placement);
    const depth = info[sourceIndex].depth;
    if (place === 'after' && index === sourceIndex - 1 && info[index].depth === depth) return true;
    if (place === 'before' && index === subtreeEnd + 1 && info[index].depth === depth) return true;
    // 'into' the parent the source already tops.
    return place === 'into' && index === sourceIndex - 1 && info[index].depth === depth - 1;
  }

  function update(e) {
    if (drag.source.isConnected === false) { cancel(); return; }
    if (e) {
      if (e.clientX !== undefined) drag.point = { x: e.clientX, y: e.clientY };
      drag.mods = modifiers(e) ?? {};
    }
    if (!drag.point) return;
    if (scrollPos(drag.scroller) !== drag.scrollPos) measure();
    const placement = computePlacement(drag.rects, drag.point, axis, drag.info);
    const { index, place } = placement;
    const inSubtree = !!drag.info && index > drag.sourceIndex && index <= drag.subtreeEnd;
    const noOp = !inSubtree && !allowInPlace(drag.mods) && isNoOp(placement);
    const target = { targetKey: keyOf(drag.items[index], index), index, place, slot: placementSlot(placement), modifiers: drag.mods };
    drag.placement = placement;
    drag.target = target;
    drag.noOp = noOp;
    drag.valid = !noOp && !inSubtree && canDrop(drag.sourceKey, target) !== false;
    render();
    autoScroll();
  }

  function setInto(el) {
    if (drag.intoEl && drag.intoEl !== el) drag.intoEl.classList.remove('dr-into', 'dr-invalid');
    drag.intoEl = el;
  }

  function render() {
    const { line, placement, valid, noOp, mods, rects, info } = drag;
    container.classList.toggle('dr-no-drop', !noOp && !valid);
    line.classList.toggle('dr-invalid', !valid);
    line.classList.toggle('dr-copy', !!mods.copy);
    line.classList.toggle('dr-link', !!mods.link);
    const { index, place } = placement;
    if (noOp) { setInto(null); line.hidden = true; return; }
    if (place === 'into') {
      const el = drag.items[index];
      setInto(el);
      el.classList.add('dr-into');
      el.classList.toggle('dr-invalid', !valid);
      line.hidden = true;
      return;
    }
    setInto(null);
    // The line sits in the middle of the gap between neighbours, so
    // "after i" and "before i + 1" draw in the same place.
    const rect = rects[index];
    const [start, end] = span(rect, axis);
    let edge;
    if (place === 'before') edge = index > 0 ? (span(rects[index - 1], axis)[1] + start) / 2 : start;
    else edge = index < rects.length - 1 ? (end + span(rects[index + 1], axis)[0]) / 2 : end;
    line.hidden = false;
    if (axis === 'x') {
      line.style.left = `${edge}px`;
      line.style.top = `${rect.top}px`;
      line.style.height = `${rect.height}px`;
      return;
    }
    let depth = info ? info[index].depth : 0;
    // Below a row whose children follow: the line goes in one level.
    if (info && place === 'after' && index + 1 < info.length && info[index + 1].depth > depth) depth++;
    const indent = depth * (tree?.indent ?? TREE_INDENT);
    line.style.left = `${rect.left + indent}px`;
    line.style.top = `${edge}px`;
    line.style.width = `${Math.max(0, rect.width - indent)}px`;
  }

  function scrollSpeed() {
    const sc = drag?.scroller;
    if (!sc || !drag.point) return 0;
    const [start, end] = span(sc.getBoundingClientRect(), axis);
    const pos = axis === 'x' ? drag.point.x : drag.point.y;
    const ramp = dist => Math.ceil(((EDGE - Math.max(0, dist)) / EDGE) * MAX_SCROLL);
    if (pos - start < EDGE) return -ramp(pos - start);
    if (end - pos < EDGE) return ramp(end - pos);
    return 0;
  }

  function autoScroll() {
    if (!drag || drag.frame || !scrollSpeed()) return;
    drag.frame = requestAnimationFrame(() => {
      if (!drag) return;
      drag.frame = null;
      const speed = scrollSpeed();
      if (!speed) return;
      if (axis === 'x') drag.scroller.scrollLeft += speed; else drag.scroller.scrollTop += speed;
      update(null);
    });
  }

  function onScroll() { if (drag) update(null); }

  function onMove(e) {
    if (!samePointer(e)) return;
    if (pending) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < threshold) return;
      start(e);
      return;
    }
    if (drag) update(e);
  }

  // Ends the drag's visuals and listeners; returns what was there.
  function finish() {
    const ended = drag;
    drag = null;
    if (!ended) return null;
    if (ended.frame) cancelAnimationFrame(ended.frame);
    ended.line.remove();
    ended.source.classList.remove('dr-lifted');
    ended.intoEl?.classList.remove('dr-into', 'dr-invalid');
    container.classList.remove('dr-active', 'dr-no-drop');
    ended.scroller?.removeEventListener('scroll', onScroll);
    try { container.releasePointerCapture?.(ended.pointerId); } catch { /* already released */ }
    return ended;
  }

  function armClickSwallow() {
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
  }

  function onUp(e) {
    if (swallowPointer !== null) { swallowPointer = null; listen(false); armClickSwallow(); return; }
    if (!samePointer(e)) return;
    if (pending) { pending = null; listen(false); return; }
    if (!drag) return;
    update(e);
    const ended = finish();
    listen(false);
    if (!ended) return;
    armClickSwallow();
    if (!ended.valid || ended.noOp) return;
    const { index, place } = ended.placement;
    onDrop?.({
      sourceKey: ended.sourceKey, targetKey: ended.target.targetKey, sourceIndex: ended.sourceIndex,
      index, place, slot: ended.target.slot, modifiers: ended.mods,
    });
  }

  // Abandons a drag; the pointer may still be down, so its release (and
  // click) is swallowed when it comes.
  function cancel() {
    const ended = finish();
    pending = null;
    if (ended) swallowPointer = ended.pointerId; else listen(false);
  }

  function onCancel(e) {
    if (!samePointer(e)) return;
    finish();
    pending = null;
    swallowPointer = null;
    listen(false);
  }

  function onKey(e) {
    if (!drag && !pending) return;
    if (e.key === 'Escape' && e.type === 'keydown') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (!drag) return;
    if (e.key === 'Alt' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Meta') e.preventDefault();
    drag.mods = modifiers(e) ?? {};
    update(null);
  }

  function onLostCapture(e) {
    if (drag && (e.pointerId === undefined || e.pointerId === drag.pointerId)) cancel();
  }

  function onClick(e) {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopImmediatePropagation?.();
    e.stopPropagation();
  }

  // Native HTML5 drags (images, selected text) would steal the pointer.
  function onNativeDragStart(e) {
    const item = e.target?.closest?.(itemSelector);
    if (item && container.contains(item)) e.preventDefault();
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('lostpointercapture', onLostCapture);
  container.addEventListener('click', onClick, true);
  container.addEventListener('dragstart', onNativeDragStart);

  return function dispose() {
    finish();
    pending = null;
    swallowPointer = null;
    listen(false);
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('lostpointercapture', onLostCapture);
    container.removeEventListener('click', onClick, true);
    container.removeEventListener('dragstart', onNativeDragStart);
  };
}
