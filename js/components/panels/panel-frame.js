export function createPanelFrame({ id, title, collapsed = false, onCollapsedChange = null }) {
  const section = document.createElement('section');
  section.className = 'panel workbench-panel';
  section.dataset.panelId = id;

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'workbench-panel-header';
  header.setAttribute('aria-expanded', String(!collapsed));

  const marker = document.createElement('span');
  marker.className = 'workbench-panel-marker';
  const label = document.createElement('span');
  label.textContent = title;
  header.append(marker, label);

  const body = document.createElement('div');
  body.className = 'workbench-panel-body';

  function setCollapsed(value) {
    collapsed = !!value;
    section.classList.toggle('collapsed', collapsed);
    body.hidden = collapsed;
    marker.textContent = collapsed ? '▶' : '▼';
    header.setAttribute('aria-expanded', String(!collapsed));
  }

  header.addEventListener('click', () => {
    setCollapsed(!collapsed);
    onCollapsedChange?.(collapsed);
  });
  setCollapsed(collapsed);
  section.append(header, body);
  return { element: section, body, setCollapsed };
}
