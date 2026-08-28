// One descriptor supplies both downloaded names and companion image references.
export function sheetExportFiles(sheet) {
  const name = sheet.name;
  return { png: `${name}.png`, frames: `${name}.frames.json`, tiles: `${name}.tiles.json`, tsx: `${name}.tsx` };
}

export function animationExportFiles(sheet, animation) {
  const name = `${sheet.name}-${animation.name}`;
  return { png: `${name}.png`, json: `${name}.json` };
}
