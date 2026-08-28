import { EditorHost } from '../../js/host/editor-host.js';
import { setEditorHost } from '../../js/host/runtime.js';
import { createProject, createSheet, createMap } from '../../js/core/model.js';
import { spriteMode } from '../../js/modes/sprites/index.js';
import { tileMode } from '../../js/modes/tiles/index.js';
import { mapMode } from '../../js/modes/maps/index.js';
import { runAction } from '../../js/features/shell/actions.js';

export class Element {
  constructor(tagName = 'DIV') {
    Object.assign(this, { tagName, children: [], handlers: {}, value: '', dataset: {}, open: false });
    this.classList = { add() {}, toggle() {} };
  }
  addEventListener(type, callback) { (this.handlers[type] ??= []).push(callback); }
  emit(type, event = {}) { for (const callback of this.handlers[type] ?? []) callback(event); }
  appendChild(element) { this.children.push(element); return element; }
  set innerHTML(value) { this.children = []; }
  querySelector() { return new Element(); }
  closest() { return this.dialog ?? null; }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
}

export async function mountDocumentFixture() {
  const elements = new Map(), events = new Map();
  globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement: tag => new Element(tag.toUpperCase()),
    querySelector: () => [...elements.values()].find(element => element.open) ?? null,
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
