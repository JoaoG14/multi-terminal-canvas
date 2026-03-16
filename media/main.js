(function() {
  'use strict';

  const vscode = acquireVsCodeApi();
  const canvasEl = document.getElementById('canvas');
  const taskbar  = document.getElementById('taskbar');
  const toolbar  = document.getElementById('toolbar');

  // ── World container (all windows live here) ───────────────────
  const world = document.createElement('div');
  world.id = 'world';
  canvasEl.appendChild(world);

  // ── Viewport state ────────────────────────────────────────────
  let panX = 0, panY = 0, zoom = 1;
  const MIN_ZOOM = 0.05, MAX_ZOOM = 5;

  // Zoom indicator
  const zoomLabel = document.createElement('span');
  zoomLabel.id = 'zoom-indicator';
  zoomLabel.textContent = '100%';
  toolbar.appendChild(zoomLabel);

  function applyTransform() {
    world.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    // Scroll the grid background so it feels infinite
    const g = 32 * zoom;
    canvasEl.style.backgroundSize = `${g}px ${g}px`;
    canvasEl.style.backgroundPosition = `${panX % g}px ${panY % g}px`;
  }

  function canvasRect() { return canvasEl.getBoundingClientRect(); }

  // Zoom towards a screen-space pivot point
  function zoomTo(newZoom, pivotSX, pivotSY) {
    const r = canvasRect();
    const px = pivotSX - r.left;
    const py = pivotSY - r.top;
    const wx = (px - panX) / zoom;
    const wy = (py - panY) / zoom;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    panX = px - wx * zoom;
    panY = py - wy * zoom;
    applyTransform();
  }

  // ── Window state ──────────────────────────────────────────────
  const windows = new Map();
  let zCounter = 100;

  // ── Pan state ─────────────────────────────────────────────────
  let isPanning  = false;
  let spaceDown  = false;
  let panStart   = null; // { x, y, px, py }

  // ── Keyboard shortcuts ────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Ignore when typing inside a focused xterm instance
    const tag = document.activeElement?.tagName;

    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      spaceDown = true;
      canvasEl.style.cursor = 'grab';
      e.preventDefault();
      return;
    }

    if (e.ctrlKey) {
      switch (e.key) {
        case '=': case '+':
          zoomTo(zoom * 1.25, ...viewportCenter());
          e.preventDefault(); break;
        case '-':
          zoomTo(zoom / 1.25, ...viewportCenter());
          e.preventDefault(); break;
        case '0':
          // Reset to 100 % centred on viewport
          zoomTo(1, ...viewportCenter());
          e.preventDefault(); break;
        case '9':
          // Zoom to fit all windows
          fitAll();
          e.preventDefault(); break;
      }
      if (e.shiftKey && e.key === 'T') {
        e.preventDefault();
        vscode.postMessage({ type: 'createTerminal', title: 'Terminal' });
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      if (!isPanning) canvasEl.style.cursor = '';
    }
  });

  function viewportCenter() {
    const r = canvasRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  // Zoom-to-fit all open windows
  function fitAll() {
    if (windows.size === 0) { panX = 0; panY = 0; zoom = 1; applyTransform(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [, win] of windows) {
      const el = win.windowEl;
      const x = parseFloat(el.style.left) || 0;
      const y = parseFloat(el.style.top)  || 0;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      minX = Math.min(minX, x);       minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);   maxY = Math.max(maxY, y + h);
    }
    const pad = 60;
    const r   = canvasRect();
    const scaleX = r.width  / (maxX - minX + pad * 2);
    const scaleY = r.height / (maxY - minY + pad * 2);
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));
    panX = -minX * zoom + pad * zoom + (r.width  - (maxX - minX) * zoom) / 2;
    panY = -minY * zoom + pad * zoom + (r.height - (maxY - minY) * zoom) / 2;
    applyTransform();
  }

  // ── Pan: space+drag / middle-mouse drag ───────────────────────
  canvasEl.addEventListener('mousedown', (e) => {
    if ((spaceDown && e.button === 0) || e.button === 1) {
      isPanning  = true;
      panStart   = { x: e.clientX, y: e.clientY, px: panX, py: panY };
      canvasEl.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    panX = panStart.px + (e.clientX - panStart.x);
    panY = panStart.py + (e.clientY - panStart.y);
    applyTransform();
  });

  document.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      canvasEl.style.cursor = spaceDown ? 'grab' : '';
    }
  });

  // ── Scroll: Ctrl+scroll → zoom, else → pan ───────────────────
  canvasEl.addEventListener('wheel', (e) => {
    const inTerminal = !!e.target.closest?.('.terminal-body');
    if (e.ctrlKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomTo(zoom * factor, e.clientX, e.clientY);
    } else if (!inTerminal) {
      e.preventDefault();
      if (e.shiftKey) {
        panX -= e.deltaY;
      } else {
        panX -= e.deltaX;
        panY -= e.deltaY;
      }
      applyTransform();
    }
  }, { passive: false });

  // ── Toolbar buttons ───────────────────────────────────────────
  document.getElementById('btn-new-terminal').addEventListener('click', () => {
    vscode.postMessage({ type: 'createTerminal', title: 'Terminal' });
  });
  document.getElementById('btn-new-claude').addEventListener('click', () => {
    vscode.postMessage({ type: 'createTerminal', shell: 'claude', title: 'Claude' });
  });

  // ── Messages from extension host ──────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'terminalCreated': createWindow(msg.id, msg.title, msg.cwd || ''); break;
      case 'output': {
        const win = windows.get(msg.id);
        if (win) win.terminal.write(msg.data);
        break;
      }
      case 'cwdChanged': {
        const win = windows.get(msg.id);
        if (win?.pathEl) win.pathEl.textContent = shortenPath(msg.cwd);
        break;
      }
      case 'terminalExited': {
        const win = windows.get(msg.id);
        if (win) win.terminal.write('\r\n\x1b[31m[exited ' + msg.exitCode + ']\x1b[0m\r\n');
        break;
      }
    }
  });

  // Shorten a path to last 2 segments, prefixed with …
  function shortenPath(p) {
    if (!p) return '';
    const sep = p.includes('\\') ? '\\' : '/';
    const parts = p.split(sep).filter(Boolean);
    if (parts.length <= 2) return p;
    return '…' + sep + parts.slice(-2).join(sep);
  }

  // ── Window creation ───────────────────────────────────────────
  function createWindow(id, title, cwd) {
    const W = 420, H = 580;   // portrait
    const r = canvasRect();
    const baseX = (r.width  / 2 - panX) / zoom - W / 2;
    const baseY = (r.height / 2 - panY) / zoom - H / 2;
    let x = baseX, y = baseY;
    for (let i = 0; i < 20; i++) {
      if (!collides(id, x, y, W, H)) break;
      x = baseX + (i + 1) * 30;
      y = baseY + (i + 1) * 30;
    }

    const el = document.createElement('div');
    el.className = 'window';
    Object.assign(el.style, { left: x+'px', top: y+'px', width: W+'px', height: H+'px' });
    el.dataset.id = id;

    // Top bar: path on left, × on right
    const titlebar = document.createElement('div');
    titlebar.className = 'window-titlebar';

    const pathEl = document.createElement('span');
    pathEl.className = 'window-path';
    pathEl.textContent = shortenPath(cwd);

    const btnClose = document.createElement('button');
    btnClose.className = 'wc-close';
    btnClose.title = 'Close';
    btnClose.textContent = '×';
    btnClose.addEventListener('click', (e) => { e.stopPropagation(); closeWindow(id); });

    titlebar.append(pathEl, btnClose);

    // titleEl kept for taskbar label (not visible in window)
    const titleEl = document.createElement('span');
    titleEl.style.display = 'none';
    titleEl.textContent = title;

    el.append(titlebar, titleEl);

    const body = document.createElement('div');
    body.className = 'terminal-body';

    // Resize handles
    const handles = [];
    for (const dir of ['n','s','e','w','nw','ne','sw','se']) {
      const h = document.createElement('div');
      h.className = `resize-handle resize-${dir}`;
      h.dataset.dir = dir;
      handles.push(h);
      el.appendChild(h);
    }

    el.append(body);
    world.appendChild(el);

    windows.set(id, { terminal: null, fitAddon: null, windowEl: el, titleEl, pathEl,
                      minimized: false, maximized: false, savedGeom: null,
                      resizeObserver: null });

    setupDrag(el, titlebar, id);
    setupResize(el, handles, id);
    setupTerminal(id, body);
    bringToFront(id);
  }

  // ── Collision helpers ─────────────────────────────────────────
  function getRect(el) {
    return { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0,
             w: el.offsetWidth, h: el.offsetHeight };
  }

  function overlaps(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // Returns true if a rect (x,y,w,h) in world-space collides with any other window
  function collides(skipId, x, y, w, h) {
    for (const [wid, win] of windows) {
      if (wid === skipId || win.minimized || win.maximized) continue;
      const r = getRect(win.windowEl);
      if (overlaps(x, y, w, h, r.x, r.y, r.w, r.h)) return true;
    }
    return false;
  }

  // ── Drag ──────────────────────────────────────────────────────
  function setupDrag(winEl, titlebar, id) {
    let active = false, startX, startY, startL, startT, curL, curT;

    titlebar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || spaceDown) return;
      const win = windows.get(id);
      if (!win || win.maximized) return;
      bringToFront(id);
      active = true;
      startX = e.clientX; startY = e.clientY;
      startL = curL = parseFloat(winEl.style.left) || 0;
      startT = curT = parseFloat(winEl.style.top)  || 0;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!active) return;
      const newX = startL + (e.clientX - startX) / zoom;
      const newY = startT + (e.clientY - startY) / zoom;
      const w = winEl.offsetWidth, h = winEl.offsetHeight;

      if (!collides(id, newX, newY, w, h)) {
        curL = newX; curT = newY;
      } else if (!collides(id, newX, curT, w, h)) {
        curL = newX;          // slide horizontally only
      } else if (!collides(id, curL, newY, w, h)) {
        curT = newY;          // slide vertically only
      }
      winEl.style.left = curL + 'px';
      winEl.style.top  = curT + 'px';
    });

    document.addEventListener('mouseup', () => { active = false; });
  }

  // ── Resize ────────────────────────────────────────────────────
  function setupResize(winEl, handles, id) {
    for (const handle of handles) {
      let active = false, dir, sx, sy, sl, st, sw, sh;

      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || spaceDown) return;
        const win = windows.get(id);
        if (!win || win.maximized) return;
        bringToFront(id);
        active = true; dir = handle.dataset.dir;
        sx = e.clientX; sy = e.clientY;
        sl = parseFloat(winEl.style.left) || 0;
        st = parseFloat(winEl.style.top)  || 0;
        sw = winEl.offsetWidth; sh = winEl.offsetHeight;
        e.preventDefault(); e.stopPropagation();
      });

      document.addEventListener('mousemove', (e) => {
        if (!active) return;
        const dx = (e.clientX - sx) / zoom;
        const dy = (e.clientY - sy) / zoom;
        const minW = 200, minH = 100;
        let nl = sl, nt = st, nw = sw, nh = sh;
        if (dir.includes('e')) nw = Math.max(minW, sw + dx);
        if (dir.includes('s')) nh = Math.max(minH, sh + dy);
        if (dir.includes('w')) { nw = Math.max(minW, sw - dx); nl = sl + (sw - nw); }
        if (dir.includes('n')) { nh = Math.max(minH, sh - dy); nt = st + (sh - nh); }
        // Only apply if it won't overlap another window
        if (!collides(id, nl, nt, nw, nh)) {
          Object.assign(winEl.style, { left: nl+'px', top: nt+'px', width: nw+'px', height: nh+'px' });
        }
      });

      document.addEventListener('mouseup', () => {
        if (active) {
          active = false;
          const win = windows.get(id);
          if (win?.fitAddon) requestAnimationFrame(() => {
            win.fitAddon.fit(); sendResize(id, win.terminal);
          });
        }
      });
    }
  }

  // ── Terminal ──────────────────────────────────────────────────
  function setupTerminal(id, container) {
    const term = new Terminal({
      theme: { background: '#141414', foreground: '#cccccc',
               cursor: '#ffffff', selectionBackground: 'rgba(255,255,255,0.2)' },
      fontFamily: "'Cascadia Code','Consolas',monospace",
      fontSize: 13, lineHeight: 1.2, cursorBlink: true, allowProposedApi: true
    });
    const fitAddon  = new FitAddon.FitAddon();
    const linkAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(linkAddon);
    term.open(container);
    fitAddon.fit();

    term.onData((data) => vscode.postMessage({ type: 'input', id, data }));

    const ro = new ResizeObserver(() => requestAnimationFrame(() => {
      fitAddon.fit(); sendResize(id, term);
    }));
    ro.observe(container);

    const win = windows.get(id);
    if (win) { win.terminal = term; win.fitAddon = fitAddon; win.resizeObserver = ro; }
  }

  function sendResize(id, term) {
    if (!term) return;
    vscode.postMessage({ type: 'resize', id, cols: term.cols, rows: term.rows });
  }

  // ── Window ops ────────────────────────────────────────────────
  function bringToFront(id) {
    for (const [wid, win] of windows)
      win.windowEl.classList.toggle('window-active', wid === id);
    const win = windows.get(id);
    if (win) win.windowEl.style.zIndex = ++zCounter;
  }

  function minimizeWindow(id) {
    const win = windows.get(id);
    if (!win || win.minimized) return;
    win.minimized = true;
    win.windowEl.style.display = 'none';
    updateTaskbar();
  }

  function maximizeWindow(id) {
    const win = windows.get(id);
    if (!win) return;
    if (win.maximized) {
      win.maximized = false;
      const g = win.savedGeom;
      if (g) Object.assign(win.windowEl.style, g);
      win.savedGeom = null;
    } else {
      win.maximized = true;
      win.savedGeom = { left: win.windowEl.style.left, top: win.windowEl.style.top,
                        width: win.windowEl.style.width, height: win.windowEl.style.height };
      // Fill current viewport in world-space coords
      const r = canvasRect();
      Object.assign(win.windowEl.style, {
        left:   (-panX / zoom) + 'px',
        top:    (-panY / zoom) + 'px',
        width:  (r.width  / zoom) + 'px',
        height: (r.height / zoom) + 'px'
      });
      bringToFront(id);
    }
    requestAnimationFrame(() => {
      win.fitAddon?.fit(); sendResize(id, win.terminal);
    });
  }

  function closeWindow(id) {
    const win = windows.get(id);
    if (!win) return;
    vscode.postMessage({ type: 'closeTerminal', id });
    win.resizeObserver?.disconnect();
    win.terminal?.dispose();
    win.windowEl.remove();
    windows.delete(id);
    updateTaskbar();
  }

  function restoreWindow(id) {
    const win = windows.get(id);
    if (!win) return;
    win.minimized = false;
    win.windowEl.style.display = 'flex';
    bringToFront(id);
    requestAnimationFrame(() => { win.fitAddon?.fit(); sendResize(id, win.terminal); });
    updateTaskbar();
  }

  function updateTaskbar() {
    taskbar.innerHTML = '';
    for (const [id, win] of windows) {
      if (!win.minimized) continue;
      const btn = document.createElement('button');
      btn.className = 'taskbar-btn';
      btn.textContent = btn.title = win.titleEl.textContent;
      btn.addEventListener('click', () => restoreWindow(id));
      taskbar.appendChild(btn);
    }
  }

  applyTransform();

})();
