// Reusable zoom/pan canvas host. Owns a <canvas> inside `hostEl`, handles wheel
// zoom, space/middle-drag pan, and forwards other pointer activity to `onPointer`.
// Used by the sheet view (Task 12) and, later, the frame editor and tile editor.

import { stepZoom, snapFitZoom } from '../core/zoom.js';

const CHECKER_SIZE = 8;
const CHECKER_A = '#3a3a3f', CHECKER_B = '#454549';
const FIT_MARGIN = 24;

export class CanvasView {
  constructor(hostEl) {
    this.host = hostEl;
    this.canvas = document.createElement('canvas');
    this.host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // public state
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.width = 0;   // logical content size, set via setContent()
    this.height = 0;

    // callbacks assigned by owner
    this.onPaint = () => {};
    this.onOverlay = () => {};
    this.onPointer = () => {};
    // optional: ({x,y,zoom}) => {} — x/y null when pointer is out of content bounds.
    // Not part of the strict brief contract; offered so owners (main.js) can drive
    // a status bar without CanvasView hardcoding DOM ids, per the task's decoupling note.
    this.onStatus = null;

    this._contentInitialized = false;
    this._raf = null;
    this._spaceHeld = false;
    this._panning = false;
    this._panStart = null;
    this.dpr = window.devicePixelRatio || 1;
    this.cssWidth = 0;
    this.cssHeight = 0;

    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.host);

    this._bindEvents();
  }

  // ---- public API ----

  setContent({ width, height }) {
    this.width = width;
    this.height = height;
    if (!this._contentInitialized) {
      this.centerFit();
      this._contentInitialized = true;
    }
    this.requestRender();
  }

  screenToImage(sx, sy) {
    return {
      x: Math.floor((sx - this.panX) / this.zoom),
      y: Math.floor((sy - this.panY) / this.zoom),
    };
  }

  imageToScreen(x, y) {
    return { x: x * this.zoom + this.panX, y: y * this.zoom + this.panY };
  }

  centerFit() {
    const availW = Math.max(1, this.cssWidth - FIT_MARGIN * 2);
    const availH = Math.max(1, this.cssHeight - FIT_MARGIN * 2);
    const w = Math.max(1, this.width), h = Math.max(1, this.height);
    this.zoom = snapFitZoom(Math.min(availW / w, availH / h));
    this.panX = (this.cssWidth - w * this.zoom) / 2;
    this.panY = (this.cssHeight - h * this.zoom) / 2;
  }

  requestRender() {
    if (this._raf != null) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }

  // ---- sizing ----

  _resize() {
    const w = Math.max(1, Math.round(this.host.clientWidth));
    const h = Math.max(1, Math.round(this.host.clientHeight));
    this.cssWidth = w;
    this.cssHeight = h;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.requestRender();
  }

  // ---- render pass ----

  _render() {
    const ctx = this.ctx, dpr = this.dpr;
    const cw = this.cssWidth, ch = this.cssHeight;

    // screen space (CSS px, dpr-scaled backing store)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cw, ch);

    if (this.width > 0 && this.height > 0) this._drawCheckerboard(ctx, cw, ch);

    // image space: zoom/pan composed with the dpr base transform
    ctx.setTransform(dpr * this.zoom, 0, 0, dpr * this.zoom, dpr * this.panX, dpr * this.panY);
    ctx.imageSmoothingEnabled = false;
    this.onPaint(ctx);

    // back to screen space (identity from the owner's perspective)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (this.zoom >= 8 && this.width > 0 && this.height > 0) this._drawPixelGrid(ctx);

    this.onOverlay(ctx);
  }

  _contentScreenRect(cw, ch) {
    const x0 = Math.max(0, this.panX);
    const y0 = Math.max(0, this.panY);
    const x1 = Math.min(cw, this.panX + this.width * this.zoom);
    const y1 = Math.min(ch, this.panY + this.height * this.zoom);
    return { x0, y0, x1, y1 };
  }

  _drawCheckerboard(ctx, cw, ch) {
    const { x0, y0, x1, y1 } = this._contentScreenRect(cw, ch);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    const startCol = Math.floor((x0 - this.panX) / CHECKER_SIZE), endCol = Math.ceil((x1 - this.panX) / CHECKER_SIZE);
    const startRow = Math.floor((y0 - this.panY) / CHECKER_SIZE), endRow = Math.ceil((y1 - this.panY) / CHECKER_SIZE);
    for (let row = startRow; row < endRow; row++) {
      for (let col = startCol; col < endCol; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? CHECKER_A : CHECKER_B;
        ctx.fillRect(this.panX + col * CHECKER_SIZE, this.panY + row * CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
      }
    }
    ctx.restore();
  }

  _drawPixelGrid(ctx) {
    const { x0, y0, x1, y1 } = this._contentScreenRect(this.cssWidth, this.cssHeight);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.strokeStyle = 'rgba(128,128,128,.25)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let ix = 0; ix <= this.width; ix++) {
      const sx = Math.round(this.panX + ix * this.zoom) + 0.5;
      if (sx < x0 - 1 || sx > x1 + 1) continue;
      ctx.moveTo(sx, y0);
      ctx.lineTo(sx, y1);
    }
    for (let iy = 0; iy <= this.height; iy++) {
      const sy = Math.round(this.panY + iy * this.zoom) + 0.5;
      if (sy < y0 - 1 || sy > y1 + 1) continue;
      ctx.moveTo(x0, sy);
      ctx.lineTo(x1, sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---- interaction ----

  _bindEvents() {
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => this._onKeyUp(e));
  }

  _isTextInput(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  _onKeyDown(e) {
    if (e.code === 'Space' && !this._isTextInput(e.target)) {
      this._spaceHeld = true;
      e.preventDefault();
    }
  }

  _onKeyUp(e) {
    if (e.code === 'Space') this._spaceHeld = false;
  }

  _localPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  }

  _reportStatus(sx, sy) {
    if (!this.onStatus) return;
    const img = this.screenToImage(sx, sy);
    const inBounds = img.x >= 0 && img.y >= 0 && img.x < this.width && img.y < this.height;
    this.onStatus({ x: inBounds ? img.x : null, y: inBounds ? img.y : null, zoom: this.zoom });
  }

  _onWheel(e) {
    e.preventDefault();
    const { sx, sy } = this._localPos(e);
    const imgX = (sx - this.panX) / this.zoom;
    const imgY = (sy - this.panY) / this.zoom;
    const newZoom = stepZoom(this.zoom, e.deltaY < 0 ? 1 : -1);
    this.zoom = newZoom;
    this.panX = sx - imgX * newZoom;
    this.panY = sy - imgY * newZoom;
    this._reportStatus(sx, sy);
    this.requestRender();
  }

  _onPointerDown(e) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* no active pointer to capture */ }
    const { sx, sy } = this._localPos(e);
    if (this._spaceHeld || e.button === 1) {
      this._panning = true;
      this._panStart = { sx, sy, panX: this.panX, panY: this.panY };
      return;
    }
    const img = this.screenToImage(sx, sy);
    this.onPointer({ type: 'down', x: img.x, y: img.y, sx, sy, buttons: e.buttons, shiftKey: e.shiftKey });
  }

  _onPointerMove(e) {
    const { sx, sy } = this._localPos(e);
    if (this._panning) {
      this.panX = this._panStart.panX + (sx - this._panStart.sx);
      this.panY = this._panStart.panY + (sy - this._panStart.sy);
      this._reportStatus(sx, sy);
      this.requestRender();
      return;
    }
    const img = this.screenToImage(sx, sy);
    this._reportStatus(sx, sy);
    this.onPointer({ type: 'move', x: img.x, y: img.y, sx, sy, buttons: e.buttons, shiftKey: e.shiftKey });
  }

  _onPointerUp(e) {
    const { sx, sy } = this._localPos(e);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (this._panning) {
      this._panning = false;
      return;
    }
    const img = this.screenToImage(sx, sy);
    this.onPointer({ type: 'up', x: img.x, y: img.y, sx, sy, buttons: e.buttons, shiftKey: e.shiftKey });
  }
}
