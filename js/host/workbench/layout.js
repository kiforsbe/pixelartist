export function findWorkbenchRegions(root = document) {
  return {
    left: root.querySelector('[data-workbench-region="left"]') ?? root.getElementById?.('tool-palette') ?? null,
    center: root.querySelector('[data-workbench-region="center"]') ?? root.getElementById?.('canvas-host') ?? null,
    right: root.querySelector('[data-workbench-region="right"]') ?? root.getElementById?.('side-panels') ?? null,
    bottom: root.querySelector('[data-workbench-region="bottom"]') ?? root.getElementById?.('timeline-dock') ?? null,
  };
}
