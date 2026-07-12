export function sliceGrid({ sheetWidth, sheetHeight, cellW, cellH,
  marginX = 0, marginY = 0, spacingX = 0, spacingY = 0, namePrefix = 'frame' }) {
  if (cellW < 1 || cellH < 1) throw new Error('cell size must be >= 1');
  const out = [];
  let i = 0;
  for (let y = marginY; y + cellH <= sheetHeight; y += cellH + spacingY)
    for (let x = marginX; x + cellW <= sheetWidth; x += cellW + spacingX)
      out.push({ name: `${namePrefix}_${i++}`, x, y, w: cellW, h: cellH });
  return out;
}
