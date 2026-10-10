// External browser boundary only: presenters, canvas view, raster/float logic,
// command dispatch, host state and history remain the real production modules.
export function installSpriteContextDom() {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.style = {};
      this.dataset = {};
      this.handlers = new Map();
      this.className = '';
      this.clientWidth = 240;
      this.clientHeight = 160;
      this.classList = {
        contains: value => this.className.split(' ').includes(value),
        add: (...values) => { this.className = [...new Set([...this.className.split(' '), ...values])].join(' ').trim(); },
        remove: (...values) => { this.className = this.className.split(' ').filter(value => !values.includes(value)).join(' '); },
        toggle: (value, force) => {
          const add = force ?? !this.classList.contains(value);
          if (add) this.classList.add(value); else this.classList.remove(value);
          return add;
        },
      };
    }
    set innerHTML(value) { this.children = []; }
    focus() { globalThis.document.activeElement = this; }
    contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); return item; }
    addEventListener(type, callback) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type).push(callback);
    }
    fire(type, detail = {}) {
      const event = { type, target: this, currentTarget: this, stopPropagation() {}, preventDefault() {}, ...detail };
      for (const callback of this.handlers.get(type) ?? []) callback(event);
    }
    querySelectorAll(selector) {
      const matches = node => selector.startsWith('.')
        ? node.classList?.contains(selector.slice(1))
        : node.tagName?.toLowerCase() === selector;
      return this.children.flatMap(child => [ ...(matches(child) ? [child] : []), ...(child.querySelectorAll?.(selector) ?? []) ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    getContext() {
      if (!this.context) {
        this.context = {
          drawImages: [], imageData: null,
          putImageData(imageData) { this.imageData = { data: imageData.data.slice(), width: imageData.width, height: imageData.height }; },
          drawImage(...args) { this.drawImages.push(args); },
          clearRect() {}, fillRect() {}, fillText() {}, save() {}, restore() {},
          beginPath() {}, rect() {}, clip() {}, translate() {}, setTransform() {},
          moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {}, setLineDash() {},
        };
      }
      return this.context;
    }
    setAttribute() {}
    setPointerCapture() {}
    releasePointerCapture() {}
  }
  globalThis.document = {
    createElement: tag => new Element(tag),
    createTextNode: textContent => ({ textContent }),
    querySelector: () => null,
    activeElement: null,
  };
  globalThis.window = new EventTarget();
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  let nextFrame = 0;
  globalThis.requestAnimationFrame = () => ++nextFrame;
  globalThis.cancelAnimationFrame = () => {};

  // ---- drag-reorder (T2) additions: additive only. Nothing above changes
  // behaviour; elements gain a parent link, selector matching, per-element
  // rects, bubbling dispatch, and a frame queue that runs only when stepped.
  const proto = Element.prototype;
  const baseAppend = proto.append, baseAppendChild = proto.appendChild;
  const baseRect = proto.getBoundingClientRect;
  const adopt = (parent, item) => { if (item instanceof Element) item.parentElement = parent; };
  proto.parentElement = null;
  proto.scrollTop = 0;
  proto.scrollLeft = 0;
  proto.append = function (...items) { items.forEach(item => adopt(this, item)); return baseAppend.apply(this, items); };
  proto.appendChild = function (item) { adopt(this, item); return baseAppendChild.call(this, item); };
  Object.defineProperty(proto, 'innerHTML', {
    configurable: true,
    set() {
      for (const child of this.children) if (child.parentElement === this) child.parentElement = null;
      this.children = [];
    },
  });
  proto.remove = function () {
    const parent = this.parentElement;
    if (parent) parent.children = parent.children.filter(child => child !== this);
    this.parentElement = null;
  };
  Object.defineProperty(proto, 'isConnected', {
    configurable: true,
    get() { let node = this; while (node.parentElement) node = node.parentElement; return node === globalThis.document.body; },
  });
  proto.removeEventListener = function (type, callback) {
    const list = this.handlers.get(type);
    if (list) this.handlers.set(type, list.filter(cb => cb !== callback));
  };
  // `el.rect = { left, top, width, height }` overrides the constant rect.
  proto.getBoundingClientRect = function () {
    if (!this.rect) return baseRect.call(this);
    const { left = 0, top = 0, width = 0, height = 0 } = this.rect;
    return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height };
  };
  // Simple selectors only, comma lists allowed: tag, .class, #id, [attr],
  // [attr=value]; data-* attributes read the dataset.
  const camel = name => name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
  const attrValue = (el, name) => {
    if (name.startsWith('data-')) return el.dataset[camel(name)] ?? null;
    const stored = el.getAttribute?.(name);
    if (stored != null) return stored;
    const prop = el[name];
    return prop === true ? '' : (typeof prop === 'string' && prop ? prop : null);
  };
  const matchesOne = (el, selector) => {
    const parts = selector.trim().match(/^[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) ?? [];
    if (!parts.length || parts.join('') !== selector.trim()) return false;
    return parts.every(part => {
      if (part[0] === '.') return el.classList.contains(part.slice(1));
      if (part[0] === '#') return el.id === part.slice(1);
      if (part[0] === '[') {
        const [name, raw] = part.slice(1, -1).split('=');
        const value = attrValue(el, name.trim());
        return raw === undefined ? value != null : value === raw.trim().replace(/^["']|["']$/g, '');
      }
      return el.tagName.toLowerCase() === part.toLowerCase();
    });
  };
  proto.matches = function (selector) { return selector.split(',').some(one => matchesOne(this, one)); };
  proto.closest = function (selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches?.(selector)) return node;
    return null;
  };
  // Bubbling counterpart of fire(): walks parentElement, honours
  // stopPropagation, and returns the event.
  proto.dispatch = function (type, detail = {}) {
    let stopped = false;
    const event = {
      type, target: this, currentTarget: this, bubbles: true, defaultPrevented: false,
      stopPropagation() { stopped = true; }, stopImmediatePropagation() { stopped = true; },
      preventDefault() { event.defaultPrevented = true; },
      ...detail,
    };
    for (let node = this; node && !stopped; node = node.parentElement) {
      event.currentTarget = node;
      for (const callback of node.handlers.get(type) ?? []) callback(event);
    }
    return event;
  };
  const documentEvents = new EventTarget();
  globalThis.document.body = new Element('body');
  globalThis.document.addEventListener = documentEvents.addEventListener.bind(documentEvents);
  globalThis.document.removeEventListener = documentEvents.removeEventListener.bind(documentEvents);
  globalThis.document.dispatchEvent = documentEvents.dispatchEvent.bind(documentEvents);
  // Frames are queued and run only by stepAnimationFrames().
  const frames = new Map();
  globalThis.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  function stepAnimationFrames(time = 0) {
    const due = [...frames.entries()];
    frames.clear();
    for (const [, callback] of due) callback(time);
    return due.length;
  }
  return { Element, stepAnimationFrames };
}
