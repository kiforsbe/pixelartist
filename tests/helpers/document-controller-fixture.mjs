import { EditorHost } from '../../js/host/editor-host.js';
import { setEditorHost } from '../../js/host/runtime.js';
import { createProject, createSheet, createMap } from '../../js/core/model.js';
import { spriteMode } from '../../js/modes/sprites/index.js';
import { tileMode } from '../../js/modes/tiles/index.js';
import { mapMode } from '../../js/modes/maps/index.js';
import { runAction } from '../../js/features/shell/actions.js';

export class Element {
  constructor(tagName = 'DIV') {
    // `type` mirrors the real DOM: an <input> with no type attribute reports
    // 'text', which is what tells a text field apart from a slider/checkbox.
    Object.assign(this, { tagName, children: [], handlers: {}, value: '', dataset: {}, open: false, modal: false });
    if (tagName === 'INPUT') this.type = 'text';
    this.classList = { add() {}, toggle() {} };
  }
  addEventListener(type, callback) { (this.handlers[type] ??= []).push(callback); }
  emit(type, event = {}) { for (const callback of this.handlers[type] ?? []) callback(event); }
  appendChild(element) { this.children.push(element); return element; }
  set innerHTML(value) { this.children = []; }
  querySelector() { return new Element(); }
  closest() { return this.dialog ?? null; }
  // show() vs showModal() is a real behavioral difference here, not a detail:
  // the filter dialogs are non-modal on purpose and must not freeze shortcuts.
  show() { this.open = true; this.modal = false; }
  showModal() { this.open = true; this.modal = true; }
  close() { this.open = false; this.modal = false; this.emit('close'); }
}

export async function mountDocumentFixture() {
  const elements = new Map(), events = new Map();
  globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement: tag => new Element(tag.toUpperCase()),
    querySelector: (selector = '') => [...elements.values()]
      .find(element => element.open && (!selector.includes(':modal') || element.modal)) ?? null,
    activeElement: null,
  };
  globalThis.window = { addEventListener(type, callback) { (events.get(type) ?? events.set(type, []).get(type)).push(callback); } };
  globalThis.location = { search: '?autotest' };
  globalThis.alert = message => { throw new Error(message); };
  const host = new EditorHost();
  setEditorHost(host);
  for (const mode of [spriteMode, tileMode, mapMode]) host.registerMode(mode);
  host.start('sprites');
  const workbench = { focusMap() {}, fitSheet() {} };
  const { mountDocumentController } = await import('../../js/features/project/document-controller.js');
  mountDocumentController({ editorHost: host, workbench });
  function reset() {
    document.activeElement = null;
    host.history.clear();
    for (const element of elements.values()) element.open = false;
    const project = createProject('Documents');
    for (const kind of ['sprite', 'tile']) {
      for (const name of ['First', 'Second']) createSheet(project, { name, kind, width: 4, height: 4 });
    }
    createMap(project, { name: 'First map' }); createMap(project, { name: 'Second map' });
    host.setProject(project);
    host.activateMode('sprites');
    return project;
  }
  function keydown(patch = {}) {
    const event = { key: 'z', ctrlKey: true, metaKey: false, shiftKey: false,
      target: new Element(), defaultPrevented: false, ...patch,
      preventDefault() { this.defaultPrevented = true; } };
    for (const listener of events.get('keydown') ?? []) listener(event);
    return event;
  }
  return { host, reset, keydown, elements, runAction };
}
