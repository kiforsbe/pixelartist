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
  return { Element };
}
