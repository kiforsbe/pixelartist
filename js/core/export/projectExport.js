// Runs a caller-supplied per-sheet export builder (the same builder the
// Document-menu "Export Sheet" dialog uses -- see main.js) across a chosen
// set of sheets, and collects every output as a flat { path, data } entry
// list ready for js/core/zip.js:zipWrite or a directory-handle walk. Kept
// as a thin, pure dispatcher: encodePng and friends are async/DOM-touching,
// so `buildSheetExport` is injected rather than imported here.
export async function collectProjectExportEntries(project, selections, buildSheetExport) {
  const entries = [];
  for (const { sheetId, format } of selections) {
    const sheet = project.sheets.find(s => s.id === sheetId);
    if (!sheet) continue;
    const sheetEntries = await buildSheetExport(sheet, format);
    for (const e of sheetEntries) entries.push({ path: `${sheet.name}/${e.path}`, data: e.data });
  }
  return entries;
}
