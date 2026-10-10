import test from 'node:test';
import assert from 'node:assert/strict';

// A small local fake element (attribute storage, removable listeners, a
// height read back from style.height) so this file needs nothing from the
// shared sprite-context DOM helper.
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.attributes = new Map();
    this.handlers = new Map();
    this.className = '';
    this.clientHeight = 0;
    this.parentElement = null;
    this.captured = null;
    this.classList = {
      contains: value => this.className.split(' ').includes(value),
      add: (...values) => { this.className = [...new Set([...this.className.split(' '), ...values])].join(' ').trim(); },
      remove: (...values) => { this.className = this.className.split(' ').filter(value => !values.includes(value)).join(' '); },
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(type, callback) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(callback);
  }
  removeEventListener(type, callback) {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter(cb => cb !== callback));
  }
  fire(type, detail = {}) {
    const event = { type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...detail };
    for (const callback of this.handlers.get(type) ?? []) callback(event);
    return event;
  }
  getBoundingClientRect() {
    const h = parseFloat(this.style.height);
    return { left: 0, top: 0, width: 300, height: Number.isFinite(h) ? h : this.clientHeight };
  }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture() { this.captured = null; }
}
globalThis.document = { createElement: tag => new FakeElement(tag) };
globalThis.window = new EventTarget();

const { createDockResizer, clampSize, keyStep, workspaceDockMax, migratePreference } = await import('../js/components/dock-resizer.js');

function fakePrefs(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    sets: [],
    get(key, fallback = null) { return map.has(key) ? map.get(key) : fallback; },
    set(key, value) { map.set(key, value); this.sets.push([key, value]); },
    remove(key) { map.delete(key); },
  };
}

function setup(options = {}) {
  const target = new FakeElement();
  target.clientHeight = 140;
  const prefs = options.prefs ?? fakePrefs();
  let max = options.max ?? 500;
  const resizes = [];
  const resizer = createDockResizer({
    target, edge: 'top', min: 100, max: () => max,
    measureContent: options.measureContent, prefs, prefKey: 'dock.test.height', label: 'Resize test dock',
    onResize: px => resizes.push(px),
  });
  return { target, prefs, resizer, handle: resizer.element, resizes, setMax: value => { max = value; } };
}

// ------------------------------------------------------------ pure helpers

test('clampSize keeps a size inside [min, max], rounded', () => {
  assert.equal(clampSize(200, 100, 400), 200);
  assert.equal(clampSize(50, 100, 400), 100);
  assert.equal(clampSize(900, 100, 400), 400);
  assert.equal(clampSize(150.6, 100, 400), 151);
});

test('clampSize prefers min when max is below it, and maps non-numbers to min', () => {
  assert.equal(clampSize(300, 100, 80), 100);
  assert.equal(clampSize(NaN, 100, 400), 100);
  assert.equal(clampSize(undefined, 100, 400), 100);
});

test('keyStep: arrows step by 16 (Shift 64), Home/End jump to the bounds, clamped', () => {
  const bounds = { min: 100, max: 400 };
  assert.equal(keyStep(200, 'ArrowUp', false, bounds), 216);
  assert.equal(keyStep(200, 'ArrowDown', false, bounds), 184);
  assert.equal(keyStep(200, 'ArrowUp', true, bounds), 264);
  assert.equal(keyStep(200, 'ArrowDown', true, bounds), 136);
  assert.equal(keyStep(200, 'Home', false, bounds), 100);
  assert.equal(keyStep(200, 'End', false, bounds), 400);
  assert.equal(keyStep(390, 'ArrowUp', true, bounds), 400);
  assert.equal(keyStep(110, 'ArrowDown', false, bounds), 100);
});

test('keyStep returns null for keys it does not handle', () => {
  assert.equal(keyStep(200, 'a', false, { min: 100, max: 400 }), null);
  assert.equal(keyStep(200, 'Enter', false, { min: 100, max: 400 }), null);
});

test('workspaceDockMax is the parent height minus 120px of canvas, or Infinity unmeasured', () => {
  const ws = new FakeElement(); ws.clientHeight = 700;
  const dock = new FakeElement(); dock.parentElement = ws;
  assert.equal(workspaceDockMax(dock), 580);
  assert.equal(workspaceDockMax(new FakeElement()), Infinity);
  ws.clientHeight = 0;
  assert.equal(workspaceDockMax(dock), Infinity);
});

test('migratePreference copies the old value once and drops the old key', () => {
  const prefs = fakePrefs({ timelineDockHeight: 260 });
  migratePreference(prefs, 'timelineDockHeight', 'dock.sprites.timeline.height');
  assert.equal(prefs.get('dock.sprites.timeline.height'), 260);
  assert.equal(prefs.get('timelineDockHeight'), null);
  const kept = fakePrefs({ timelineDockHeight: 260, 'dock.sprites.timeline.height': 300 });
  migratePreference(kept, 'timelineDockHeight', 'dock.sprites.timeline.height');
  assert.equal(kept.get('dock.sprites.timeline.height'), 300, 'an existing new value wins');
  assert.doesNotThrow(() => migratePreference(null, 'a', 'b'));
});

// ------------------------------------------------------------- component

test('the handle is an accessible horizontal separator', () => {
  const { handle } = setup();
  assert.equal(handle.classList.contains('dock-resizer'), true);
  assert.equal(handle.getAttribute('role'), 'separator');
  assert.equal(handle.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(handle.getAttribute('aria-label'), 'Resize test dock');
  assert.equal(handle.getAttribute('aria-valuemin'), '100');
  assert.equal(handle.getAttribute('aria-valuemax'), '500');
  assert.equal(handle.getAttribute('aria-valuenow'), '140');
  assert.equal(handle.tabIndex, 0);
});

test('a saved size is restored (clamped) without persisting or notifying', () => {
  const prefs = fakePrefs({ 'dock.test.height': 900 });
  const { target, resizer, resizes } = setup({ prefs });
  assert.equal(target.style.height, '500px');
  assert.equal(resizer.size(), 500);
  assert.deepEqual(prefs.sets, []);
  assert.deepEqual(resizes, []);
});

test('dragging the top edge up grows the dock live and persists on release', () => {
  const { target, prefs, handle, resizes } = setup();
  const down = handle.fire('pointerdown', { clientY: 500, pointerId: 7, button: 0 });
  assert.equal(down.defaultPrevented, true);
  assert.equal(handle.captured, 7);
  assert.equal(handle.classList.contains('dragging'), true);
  handle.fire('pointermove', { clientY: 440, pointerId: 7 });
  assert.equal(target.style.height, '200px');
  assert.deepEqual(resizes, [200]);
  assert.deepEqual(prefs.sets, [], 'not saved mid-drag');
  handle.fire('pointermove', { clientY: 400, pointerId: 7 });
  handle.fire('pointerup', { clientY: 400, pointerId: 7 });
  assert.equal(target.style.height, '240px');
  assert.deepEqual(prefs.sets, [['dock.test.height', 240]]);
  assert.equal(handle.classList.contains('dragging'), false);
  assert.equal(handle.getAttribute('aria-valuenow'), '240');
});

test('a drag clamps to min and max', () => {
  const { target, handle } = setup();
  handle.fire('pointerdown', { clientY: 500, pointerId: 1, button: 0 });
  handle.fire('pointermove', { clientY: -1000, pointerId: 1 });
  assert.equal(target.style.height, '500px');
  handle.fire('pointermove', { clientY: 2000, pointerId: 1 });
  assert.equal(target.style.height, '100px');
  handle.fire('pointercancel', { pointerId: 1 });
  handle.fire('pointermove', { clientY: 0, pointerId: 1 });
  assert.equal(target.style.height, '100px', 'moves after the drag ended do nothing');
});

test('a non-primary button does not start a drag', () => {
  const { target, handle } = setup();
  handle.fire('pointerdown', { clientY: 500, pointerId: 1, button: 2 });
  handle.fire('pointermove', { clientY: 400, pointerId: 1 });
  assert.equal(target.style.height, undefined);
});

test('arrow keys, Home and End resize and persist', () => {
  const { target, prefs, handle } = setup();
  const up = handle.fire('keydown', { key: 'ArrowUp' });
  assert.equal(up.defaultPrevented, true);
  assert.equal(target.style.height, '156px');
  handle.fire('keydown', { key: 'ArrowDown', shiftKey: true });
  assert.equal(target.style.height, '100px', '156 - 64 clamps to min');
  handle.fire('keydown', { key: 'End' });
  assert.equal(target.style.height, '500px');
  handle.fire('keydown', { key: 'Home' });
  assert.equal(target.style.height, '100px');
  assert.deepEqual(prefs.sets.map(([, v]) => v), [156, 100, 500, 100]);
  assert.equal(handle.getAttribute('aria-valuenow'), '100');
  const other = handle.fire('keydown', { key: 'x' });
  assert.equal(other.defaultPrevented, false);
});

test('double-click fits the content; a second fit restores the previous size', () => {
  const { target, prefs, handle } = setup({ measureContent: () => 320 });
  handle.fire('dblclick');
  assert.equal(target.style.height, '320px');
  assert.deepEqual(prefs.sets.at(-1), ['dock.test.height', 320]);
  handle.fire('dblclick');
  assert.equal(target.style.height, '140px');
  assert.deepEqual(prefs.sets.at(-1), ['dock.test.height', 140]);
});

test('Enter fits too, and the fit is clamped to max', () => {
  const { target, handle } = setup({ measureContent: () => 2000 });
  const enter = handle.fire('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(target.style.height, '500px');
});

test('resizing after a fit makes the next fit fit again instead of restoring', () => {
  const { target, handle } = setup({ measureContent: () => 320 });
  handle.fire('dblclick');
  handle.fire('keydown', { key: 'ArrowDown' });
  assert.equal(target.style.height, '304px');
  handle.fire('dblclick');
  assert.equal(target.style.height, '320px');
});

test('without measureContent a fit does nothing', () => {
  const { target, prefs, handle } = setup();
  handle.fire('dblclick');
  assert.equal(target.style.height, undefined);
  assert.deepEqual(prefs.sets, []);
});

test('setSize clamps, applies and persists; size() reports it', () => {
  const { target, prefs, resizer } = setup();
  resizer.setSize(50);
  assert.equal(target.style.height, '100px');
  assert.equal(resizer.size(), 100);
  assert.deepEqual(prefs.sets, [['dock.test.height', 100]]);
});

test('a window resize re-clamps to the new max without persisting', () => {
  const { target, prefs, resizer, handle, setMax } = setup();
  resizer.setSize(450);
  prefs.sets.length = 0;
  setMax(300);
  window.dispatchEvent(new Event('resize'));
  assert.equal(target.style.height, '300px');
  assert.equal(handle.getAttribute('aria-valuemax'), '300');
  assert.deepEqual(prefs.sets, []);
});

test('dispose stops listening to window resizes', () => {
  const { target, resizer, setMax } = setup();
  resizer.setSize(450);
  resizer.dispose();
  setMax(300);
  window.dispatchEvent(new Event('resize'));
  assert.equal(target.style.height, '450px');
});

test('works without a preferences store', () => {
  const target = new FakeElement(); target.clientHeight = 140;
  const resizer = createDockResizer({ target, max: () => 400, prefs: null, prefKey: 'x', label: 'Resize' });
  resizer.element.fire('keydown', { key: 'ArrowUp' });
  assert.equal(target.style.height, '156px');
});
