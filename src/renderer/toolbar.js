// src/renderer/toolbar.js
export function buildToolbar(container, actions) {
  const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; return b; };
  container.append(
    btn('Open Left', () => actions.openLeft()),
    btn('Open Right', () => actions.openRight()),
    btn('Save', () => actions.save()),
    btn('◀ Diff', () => actions.prevDiff()),
    btn('Diff ▶', () => actions.nextDiff()),
    btn('Whitespace', () => actions.toggleWs()),
    btn('Vim', () => actions.toggleVim()),
    btn('Theme', () => actions.toggleTheme()),
  );
  const status = document.createElement('span');
  status.id = 'toolbar-status';
  status.style.marginLeft = 'auto';
  container.append(status);
}

export function setStatus(msg) { const s = document.getElementById('toolbar-status'); if (s) s.textContent = msg; }
