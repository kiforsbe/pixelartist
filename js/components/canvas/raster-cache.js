// Two-tier flatten cache shared by every mode that draws a flattened sheet:
// a bitmap tier (rebuilt only when explicitly invalidated or the sheet
// reference changes) and a canvas tier (rebuilt only when the bitmap
// reference changes). Callers supply their own flatten function so each
// mode's differing flatten signature (layers vs. floating vs. neither)
// stays local to the call site instead of baked into the cache.
export function createRasterCache() {
  let sheetRef = null;
  let bitmap = null;
  let dirty = true;
  let canvas = null;
  let canvasSrc = null;

  function invalidate() { dirty = true; }

  function getBitmap(sheet, flatten) {
    if (dirty || sheetRef !== sheet || !bitmap) {
      bitmap = flatten(sheet);
      sheetRef = sheet;
      dirty = false;
    }
    return bitmap;
  }

  function getCanvas(sheet, flatten) {
    const bmp = getBitmap(sheet, flatten);
    if (canvasSrc !== bmp) {
      if (!canvas || canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
      canvasSrc = bmp;
    }
    return canvas;
  }

  return { getBitmap, getCanvas, invalidate };
}
