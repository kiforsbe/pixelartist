import { state, activeSheet, markDirty, emit } from '../../app/state.js';
import { acceptAnimation } from '../../core/model.js';

export function commitBreakApartStrip(animation) {
  const beforeBreaks = (animation.breaks ?? []).slice();
  state.commands.push({
    label: 'break apart strip',
    do() { animation.strip = false; animation.breaks = []; },
    undo() { animation.strip = true; animation.breaks = beforeBreaks.slice(); },
  });
  markDirty();
}

export function commitAcceptAnimation(sheet, animation) {
  if (animation.layerGroupId) return;
  const beforeActiveLayerId = state.activeLayerId;
  const group = acceptAnimation(sheet, animation);
  const animationLayerId = group.children[0].id;
  const groupIndex = sheet.layerTree.children.indexOf(group);

  state.commands.push({
    label: 'accept animation',
    do() {
      animation.layerGroupId = group.id;
      if (!sheet.layerTree.children.includes(group)) {
        sheet.layerTree.children.splice(Math.min(groupIndex, sheet.layerTree.children.length), 0, group);
      }
      if (sheet === activeSheet()) state.activeLayerId = animationLayerId;
    },
    undo() {
      animation.layerGroupId = null;
      sheet.layerTree.children = sheet.layerTree.children.filter(child => child !== group);
      if (state.activeLayerId === animationLayerId) state.activeLayerId = beforeActiveLayerId;
    },
  });
  markDirty();
  emit('selection');
}
