(function() {
  'use strict';

  const vscode = acquireVsCodeApi();
  const canvasEl = document.getElementById('canvas');
  const taskbar  = document.getElementById('taskbar');
  const toolbar  = document.getElementById('toolbar');

  // ── Context menu ──────────────────────────────────────────────
  const ctxMenu = document.createElement('div');
  ctxMenu.id = 'ctx-menu';
  document.body.appendChild(ctxMenu);

  function showContextMenu(x, y, items) {
    ctxMenu.innerHTML = '';
    for (const item of items) {
      if (item === '-') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        ctxMenu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'ctx-item' + (item.danger ? ' ctx-danger' : '');
      if (item.disabled) btn.disabled = true;
      const lbl = document.createElement('span');
      lbl.textContent = item.label;
      btn.appendChild(lbl);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'ctx-hint';
        hint.textContent = item.hint;
        btn.appendChild(hint);
      }
      btn.addEventListener('click', () => { hideContextMenu(); item.action(); });
      ctxMenu.appendChild(btn);
    }
    ctxMenu.style.display = 'block';
    const menuW = ctxMenu.offsetWidth;
    const menuH = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth  - menuW - 4)) + 'px';
    ctxMenu.style.top  = Math.max(4, Math.min(y, window.innerHeight - menuH - 4)) + 'px';
  }

  function hideContextMenu() { ctxMenu.style.display = 'none'; }

  document.addEventListener('mousedown', (e) => { if (!ctxMenu.contains(e.target)) hideContextMenu(); });
  document.addEventListener('keydown',   (e) => { if (e.key === 'Escape') hideContextMenu(); }, true);

  // ── World container (all windows live here) ───────────────────
  const world = document.createElement('div');
  world.id = 'world';
  canvasEl.appendChild(world);

  // ── Viewport state ────────────────────────────────────────────
  let panX = 0, panY = 0, zoom = 1;
  const MIN_ZOOM = 0.05, MAX_ZOOM = 5;
  const BASE_FONT_SIZE = 13;

  // ── Zoom settle: update font sizes + refit after zoom stops ───
  // We scale font proportionally with zoom so cols/rows stay roughly
  // constant and — crucially — the world transform never includes
  // scale(), so xterm canvases render at native DPR with no GPU blur.
  let zoomInProgress = false;
  let zoomSettleTimer = null;

  function scheduleZoomSettle() {
    zoomInProgress = true;
    clearTimeout(zoomSettleTimer);
    zoomSettleTimer = setTimeout(() => {
      zoomInProgress = false;
      const newFontSize = Math.max(6, Math.round(BASE_FONT_SIZE * zoom));
      for (const [id, win] of windows) {
        if (!win.terminal || !win.fitAddon) continue;
        win.terminal.options.fontSize = newFontSize;
        win.fitAddon.fit();
        sendResize(id, win.terminal);
      }
    }, 150);
  }

  // ── Zoom indicator ────────────────────────────────────────────
  const zoomLabel = document.createElement('span');
  zoomLabel.id = 'zoom-indicator';
  zoomLabel.textContent = '100%';
  toolbar.appendChild(zoomLabel);

  // World transform: translate only — NO scale.
  // Windows are positioned at (wx*zoom, wy*zoom) in CSS, which together
  // with the pan translate puts them at the right screen position.
  // Removing scale means the browser never GPU-upscales the canvas layers.
  function applyTransform() {
    world.style.transform = `translate(${panX}px,${panY}px)`;
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    const g = 32 * zoom;
    canvasEl.style.backgroundSize = `${g}px ${g}px`;
    canvasEl.style.backgroundPosition = `${panX % g}px ${panY % g}px`;
    positionAllWindows();
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
    scheduleZoomSettle();
    applyTransform();
  }

  // ── Window state ──────────────────────────────────────────────
  // Each window stores world-space coords (wx,wy,ww,wh). CSS position
  // is derived as wx*zoom etc., so windows appear at the right size on
  // screen without any CSS transform scale on the parent.
  const windows = new Map();
  let zCounter = 100;

  function positionWindow(id) {
    const win = windows.get(id);
    if (!win || win.minimized || win.maximized) return;
    const el = win.windowEl;
    el.style.left   = win.wx * zoom + 'px';
    el.style.top    = win.wy * zoom + 'px';
    el.style.width  = win.ww * zoom + 'px';
    el.style.height = win.wh * zoom + 'px';
  }

  function positionAllWindows() {
    for (const [id] of windows) positionWindow(id);
  }

  // ── Pan state ─────────────────────────────────────────────────
  let isPanning  = false;
  let spaceDown  = false;
  let panStart   = null;

  // ── Keyboard shortcuts ────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
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
          zoomTo(1, ...viewportCenter());
          e.preventDefault(); break;
        case '9':
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
      if (win.minimized) continue;
      minX = Math.min(minX, win.wx);           minY = Math.min(minY, win.wy);
      maxX = Math.max(maxX, win.wx + win.ww);  maxY = Math.max(maxY, win.wy + win.wh);
    }
    const pad = 60;
    const r   = canvasRect();
    const scaleX = r.width  / (maxX - minX + pad * 2);
    const scaleY = r.height / (maxY - minY + pad * 2);
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));
    panX = -minX * zoom + pad * zoom + (r.width  - (maxX - minX) * zoom) / 2;
    panY = -minY * zoom + pad * zoom + (r.height - (maxY - minY) * zoom) / 2;
    scheduleZoomSettle();
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

  // ── Canvas right-click ────────────────────────────────────────
  canvasEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest?.('.window')) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'New Terminal',        hint: 'Ctrl+Shift+T', action: () => vscode.postMessage({ type: 'createTerminal', title: 'Terminal', shellPath: shellSelect ? shellSelect.value : null }) },
      { label: 'New Claude Terminal',                       action: () => vscode.postMessage({ type: 'createTerminal', shell: 'claude', title: 'Claude' }) },
      '-',
      { label: 'Zoom to Fit All',     hint: 'Ctrl+9',  action: () => fitAll() },
      { label: 'Reset Zoom (100%)',   hint: 'Ctrl+0',  action: () => zoomTo(1, ...viewportCenter()) },
      { label: 'Zoom In',             hint: 'Ctrl++',  action: () => zoomTo(zoom * 1.25, ...viewportCenter()) },
      { label: 'Zoom Out',            hint: 'Ctrl+-',  action: () => zoomTo(zoom / 1.25, ...viewportCenter()) },
      '-',
      { label: 'Close All', danger: true, disabled: windows.size === 0, action: () => { for (const id of [...windows.keys()]) closeWindow(id); } },
    ]);
  });

  // ── Shell selector ────────────────────────────────────────────
  let shellSelect = null;

  function buildShellSelector(shells) {
    if (!shells.length) return;
    const existing = toolbar.querySelector('.shell-select-wrap');
    if (existing) existing.remove();

    const wrap = document.createElement('div');
    wrap.className = 'shell-select-wrap';

    const display = document.createElement('div');
    display.className = 'shell-select-display';

    const label = document.createElement('span');
    label.className = 'shell-select-label';
    label.textContent = shells[0]?.name ?? '';

    const chevron = document.createElement('span');
    chevron.className = 'shell-chevron';
    chevron.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

    display.append(label, chevron);

    shellSelect = document.createElement('select');
    shellSelect.id = 'shell-select';
    shellSelect.title = 'Default shell';
    for (const s of shells) {
      const opt = document.createElement('option');
      opt.value = s.path;
      opt.textContent = s.name;
      shellSelect.appendChild(opt);
    }

    shellSelect.addEventListener('change', () => {
      label.textContent = shellSelect.options[shellSelect.selectedIndex].text;
    });

    wrap.append(display, shellSelect);
    toolbar.insertBefore(wrap, zoomLabel);
  }

  // ── Toolbar buttons ───────────────────────────────────────────
  document.getElementById('btn-new-terminal').addEventListener('click', () => {
    vscode.postMessage({
      type: 'createTerminal',
      title: 'Terminal',
      shellPath: shellSelect ? shellSelect.value : null
    });
  });
  document.getElementById('btn-new-claude').addEventListener('click', () => {
    vscode.postMessage({ type: 'createTerminal', shell: 'claude', title: 'Claude' });
  });

  vscode.postMessage({ type: 'ready' });

  // ── Messages from extension host ──────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'shellsAvailable': buildShellSelector(msg.shells); break;
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

  function shortenPath(p) {
    if (!p) return '';
    const sep = p.includes('\\') ? '\\' : '/';
    const parts = p.split(sep).filter(Boolean);
    if (parts.length <= 2) return p;
    return '…' + sep + parts.slice(-2).join(sep);
  }

  // ── Window creation ───────────────────────────────────────────
  function createWindow(id, title, cwd) {
    const W = 420, H = 580;
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
    el.dataset.id = id;

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

    const titleEl = document.createElement('span');
    titleEl.style.display = 'none';
    titleEl.textContent = title;

    el.append(titlebar, titleEl);

    const body = document.createElement('div');
    body.className = 'terminal-body';

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
                      resizeObserver: null, terminalBody: null,
                      wx: x, wy: y, ww: W, wh: H });
    positionWindow(id);

    el.addEventListener('mousedown', () => bringToFront(id), true);

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      bringToFront(id);
      const win = windows.get(id);
      const inTerminal = !!e.target.closest?.('.terminal-body');
      const items = [];
      if (inTerminal) {
        items.push(
          { label: 'Copy',  action: () => { const s = win?.terminal?.getSelection(); if (s) navigator.clipboard.writeText(s); } },
          { label: 'Paste', action: () => navigator.clipboard.readText().then(t => { if (t) vscode.postMessage({ type: 'input', id, data: t }); }) },
          { label: 'Clear', action: () => win?.terminal?.clear() },
          '-',
        );
      }
      items.push(
        { label: win?.maximized ? 'Restore' : 'Maximize', action: () => maximizeWindow(id) },
        { label: 'Minimize',                               action: () => minimizeWindow(id) },
        '-',
        { label: 'Zoom to Window',                         action: () => zoomToWindow(id) },
        '-',
        { label: 'Close', danger: true,                    action: () => closeWindow(id) },
      );
      showContextMenu(e.clientX, e.clientY, items);
    }, true);

    setupDrag(el, titlebar, id);
    setupResize(el, handles, id);
    setupTerminal(id, body);
    bringToFront(id);
  }

  // ── Collision helpers ─────────────────────────────────────────
  function overlaps(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // All coordinates are in world units (independent of zoom).
  function collides(skipId, x, y, w, h) {
    for (const [wid, win] of windows) {
      if (wid === skipId || win.minimized || win.maximized) continue;
      if (overlaps(x, y, w, h, win.wx, win.wy, win.ww, win.wh)) return true;
    }
    return false;
  }

  // ── Drag ──────────────────────────────────────────────────────
  function setupDrag(winEl, titlebar, id) {
    let active = false, startX, startY, startWX, startWY, curWX, curWY;

    titlebar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || spaceDown) return;
      const win = windows.get(id);
      if (!win || win.maximized) return;
      bringToFront(id);
      active = true;
      startX = e.clientX; startY = e.clientY;
      startWX = curWX = win.wx;
      startWY = curWY = win.wy;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!active) return;
      const win = windows.get(id);
      if (!win) return;
      // Screen delta / zoom = world delta (world has no CSS scale, so screen px = CSS px)
      curWX = startWX + (e.clientX - startX) / zoom;
      curWY = startWY + (e.clientY - startY) / zoom;
      win.wx = curWX; win.wy = curWY;
      winEl.style.left = curWX * zoom + 'px';
      winEl.style.top  = curWY * zoom + 'px';
    });

    document.addEventListener('mouseup', () => { active = false; });
  }

  // ── Resize ────────────────────────────────────────────────────
  function setupResize(winEl, handles, id) {
    for (const handle of handles) {
      let active = false, dir, sx, sy, startWX, startWY, startWW, startWH;

      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || spaceDown) return;
        const win = windows.get(id);
        if (!win || win.maximized) return;
        bringToFront(id);
        active = true; dir = handle.dataset.dir;
        sx = e.clientX; sy = e.clientY;
        startWX = win.wx; startWY = win.wy;
        startWW = win.ww; startWH = win.wh;
        e.preventDefault(); e.stopPropagation();
      });

      document.addEventListener('mousemove', (e) => {
        if (!active) return;
        const win = windows.get(id);
        if (!win) return;
        const dx = (e.clientX - sx) / zoom;
        const dy = (e.clientY - sy) / zoom;
        const minW = 200, minH = 100;
        let nwx = startWX, nwy = startWY, nww = startWW, nwh = startWH;
        if (dir.includes('e')) nww = Math.max(minW, startWW + dx);
        if (dir.includes('s')) nwh = Math.max(minH, startWH + dy);
        if (dir.includes('w')) { nww = Math.max(minW, startWW - dx); nwx = startWX + (startWW - nww); }
        if (dir.includes('n')) { nwh = Math.max(minH, startWH - dy); nwy = startWY + (startWH - nwh); }
        win.wx = nwx; win.wy = nwy; win.ww = nww; win.wh = nwh;
        Object.assign(winEl.style, {
          left:   win.wx * zoom + 'px', top:    win.wy * zoom + 'px',
          width:  win.ww * zoom + 'px', height: win.wh * zoom + 'px'
        });
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
      theme: {
        background:          '#0a0a0a',
        foreground:          '#cccccc',
        cursor:              '#ffffff',
        selectionBackground: 'rgba(255,255,255,0.15)',
        yellow:              '#DA785B',
        brightYellow:        '#DA785B',
      },
      fontFamily: "'Cascadia Code','Consolas',monospace",
      fontSize: Math.max(6, Math.round(BASE_FONT_SIZE * zoom)),
      lineHeight: 1.2, cursorBlink: true, allowProposedApi: true
    });
    const fitAddon  = new FitAddon.FitAddon();
    const linkAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(linkAddon);
    term.open(container);
    fitAddon.fit();

    term.onData((data) => vscode.postMessage({ type: 'input', id, data }));
    term.focus();

    const ro = new ResizeObserver(() => {
      if (zoomInProgress) return; // zoom-settle callback handles refit
      requestAnimationFrame(() => { fitAddon.fit(); sendResize(id, term); });
    });
    ro.observe(container);

    const win = windows.get(id);
    if (win) {
      win.terminal = term;
      win.fitAddon = fitAddon;
      win.resizeObserver = ro;
      win.terminalBody = container;
    }
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
      if (g) { win.wx = g.wx; win.wy = g.wy; win.ww = g.ww; win.wh = g.wh; }
      win.savedGeom = null;
      positionWindow(id);
    } else {
      win.maximized = true;
      win.savedGeom = { wx: win.wx, wy: win.wy, ww: win.ww, wh: win.wh };
      // Fill current viewport: CSS inside #world (which only translates)
      // so left=-panX puts the window at screen x=0.
      const r = canvasRect();
      Object.assign(win.windowEl.style, {
        left:   -panX + 'px',
        top:    -panY + 'px',
        width:  r.width  + 'px',
        height: r.height + 'px'
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

  function zoomToWindow(id) {
    const win = windows.get(id);
    if (!win || win.minimized) return;
    const r   = canvasRect();
    const pad = 40;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
      Math.min((r.width - pad * 2) / win.ww, (r.height - pad * 2) / win.wh)
    ));
    panX = r.width  / 2 - (win.wx + win.ww / 2) * zoom;
    panY = r.height / 2 - (win.wy + win.wh / 2) * zoom;
    scheduleZoomSettle();
    applyTransform();
  }

  function updateTaskbar() {
    taskbar.innerHTML = '';
    let hasMinimized = false;
    for (const [id, win] of windows) {
      if (!win.minimized) continue;
      hasMinimized = true;
      const btn = document.createElement('button');
      btn.className = 'taskbar-btn';
      btn.textContent = btn.title = win.titleEl.textContent;
      btn.addEventListener('click', () => restoreWindow(id));
      taskbar.appendChild(btn);
    }
    taskbar.style.display = hasMinimized ? 'flex' : 'none';
  }

  applyTransform();

})();
