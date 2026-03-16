(function() {
  'use strict';

  console.log('[CanvasTerminals] main.js loaded, Terminal available:', typeof Terminal !== 'undefined');
  console.log('[CanvasTerminals] FitAddon:', typeof FitAddon !== 'undefined', 'WebLinksAddon:', typeof WebLinksAddon !== 'undefined');

  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('canvas');
  const taskbar = document.getElementById('taskbar');
  const btnNewTerminal = document.getElementById('btn-new-terminal');
  const btnNewClaude = document.getElementById('btn-new-claude');

  // State
  const windows = new Map(); // id -> { terminal, fitAddon, windowEl, titleEl, minimized, maximized, savedGeom, resizeObserver }
  let zCounter = 100;
  let pendingShell = null; // 'claude' or null, used when terminalCreated arrives

  // Toolbar buttons
  btnNewTerminal.addEventListener('click', () => {
    console.log('[CanvasTerminals] + Terminal clicked');
    pendingShell = null;
    vscode.postMessage({ type: 'createTerminal', title: 'Terminal' });
  });

  btnNewClaude.addEventListener('click', () => {
    pendingShell = 'claude';
    vscode.postMessage({ type: 'createTerminal', shell: 'claude', title: 'Claude' });
  });

  // Ctrl+Shift+T opens new terminal
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      pendingShell = null;
      vscode.postMessage({ type: 'createTerminal', title: 'Terminal' });
    }
  });

  // Messages from extension host
  window.addEventListener('message', (event) => {
    const msg = event.data;
    console.log('[CanvasTerminals] webview received message:', msg.type);
    switch (msg.type) {
      case 'terminalCreated':
        createWindow(msg.id, msg.title);
        break;
      case 'output': {
        const win = windows.get(msg.id);
        if (win) win.terminal.write(msg.data);
        break;
      }
      case 'terminalExited': {
        const win = windows.get(msg.id);
        if (win) {
          win.terminal.write('\r\n\x1b[31m[Process exited with code ' + msg.exitCode + ']\x1b[0m\r\n');
        }
        break;
      }
    }
  });

  // ── Window creation ──────────────────────────────────────────

  function createWindow(id, title) {
    const canvasRect = canvas.getBoundingClientRect();
    const w = Math.min(700, Math.max(400, canvasRect.width * 0.5));
    const h = Math.min(500, Math.max(250, canvasRect.height * 0.6));
    const x = 40 + (windows.size % 5) * 30;
    const y = 40 + (windows.size % 5) * 30;

    const el = document.createElement('div');
    el.className = 'window';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.dataset.id = id;

    // Titlebar
    const titlebar = document.createElement('div');
    titlebar.className = 'window-titlebar';

    const titleEl = document.createElement('span');
    titleEl.className = 'window-title';
    titleEl.textContent = title;

    // Double-click to rename
    titleEl.addEventListener('dblclick', () => {
      const newName = prompt('Rename terminal:', titleEl.textContent);
      if (newName !== null && newName.trim()) {
        titleEl.textContent = newName.trim();
        updateTaskbar();
      }
    });

    const controls = document.createElement('div');
    controls.className = 'window-controls';

    const btnMin = document.createElement('button');
    btnMin.className = 'wc-btn wc-minimize';
    btnMin.title = 'Minimize';
    btnMin.addEventListener('click', (e) => { e.stopPropagation(); minimizeWindow(id); });

    const btnMax = document.createElement('button');
    btnMax.className = 'wc-btn wc-maximize';
    btnMax.title = 'Maximize';
    btnMax.addEventListener('click', (e) => { e.stopPropagation(); maximizeWindow(id); });

    const btnClose = document.createElement('button');
    btnClose.className = 'wc-btn wc-close';
    btnClose.title = 'Close';
    btnClose.addEventListener('click', (e) => { e.stopPropagation(); closeWindow(id); });

    controls.append(btnMin, btnMax, btnClose);
    titlebar.append(titleEl, controls);

    // Terminal body
    const body = document.createElement('div');
    body.className = 'terminal-body';

    // Resize handles
    const directions = ['n','s','e','w','nw','ne','sw','se'];
    const handles = [];
    for (const dir of directions) {
      const h = document.createElement('div');
      h.className = 'resize-handle resize-' + dir;
      h.dataset.dir = dir;
      handles.push(h);
      el.appendChild(h);
    }

    el.append(titlebar, body);
    canvas.appendChild(el);

    // Window state
    const winState = {
      terminal: null,
      fitAddon: null,
      windowEl: el,
      titleEl,
      minimized: false,
      maximized: false,
      savedGeom: null,
      resizeObserver: null
    };
    windows.set(id, winState);

    setupDrag(el, titlebar, id);
    setupResize(el, handles, id);
    setupTerminal(id, body);
    bringToFront(id);
  }

  // ── Drag ─────────────────────────────────────────────────────

  function setupDrag(winEl, titlebar, id) {
    let dragging = false;
    let startX, startY, startLeft, startTop;

    titlebar.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const win = windows.get(id);
      if (!win || win.maximized) return;
      bringToFront(id);
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(winEl.style.left) || 0;
      startTop = parseInt(winEl.style.top) || 0;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      winEl.style.left = (startLeft + dx) + 'px';
      winEl.style.top = (startTop + dy) + 'px';
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ── Resize ───────────────────────────────────────────────────

  function setupResize(winEl, handles, id) {
    for (const handle of handles) {
      let resizing = false;
      let dir, startX, startY, startLeft, startTop, startW, startH;

      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const win = windows.get(id);
        if (!win || win.maximized) return;
        bringToFront(id);
        resizing = true;
        dir = handle.dataset.dir;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = parseInt(winEl.style.left) || 0;
        startTop = parseInt(winEl.style.top) || 0;
        startW = winEl.offsetWidth;
        startH = winEl.offsetHeight;
        e.preventDefault();
        e.stopPropagation();
      });

      document.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const minW = 200, minH = 100;

        let newLeft = startLeft, newTop = startTop, newW = startW, newH = startH;

        if (dir.includes('e')) newW = Math.max(minW, startW + dx);
        if (dir.includes('s')) newH = Math.max(minH, startH + dy);
        if (dir.includes('w')) {
          newW = Math.max(minW, startW - dx);
          newLeft = startLeft + (startW - newW);
        }
        if (dir.includes('n')) {
          newH = Math.max(minH, startH - dy);
          newTop = startTop + (startH - newH);
        }

        winEl.style.left = newLeft + 'px';
        winEl.style.top = newTop + 'px';
        winEl.style.width = newW + 'px';
        winEl.style.height = newH + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (resizing) {
          resizing = false;
          const win = windows.get(id);
          if (win && win.fitAddon) {
            requestAnimationFrame(() => {
              win.fitAddon.fit();
              sendResize(id, win.terminal);
            });
          }
        }
      });
    }
  }

  // ── Terminal setup ────────────────────────────────────────────

  function setupTerminal(id, container) {
    const term = new Terminal({
      theme: {
        background: '#141414',
        foreground: '#cccccc',
        cursor: '#4a9eff',
        selectionBackground: 'rgba(74,158,255,0.3)'
      },
      fontFamily: "'Cascadia Code', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true
    });

    const fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(container);
    fitAddon.fit();

    term.onData((data) => {
      vscode.postMessage({ type: 'input', id, data });
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
        sendResize(id, term);
      });
    });
    resizeObserver.observe(container);

    const win = windows.get(id);
    if (win) {
      win.terminal = term;
      win.fitAddon = fitAddon;
      win.resizeObserver = resizeObserver;
    }
  }

  function sendResize(id, term) {
    if (!term) return;
    vscode.postMessage({
      type: 'resize',
      id,
      cols: term.cols,
      rows: term.rows
    });
  }

  // ── Window operations ─────────────────────────────────────────

  function bringToFront(id) {
    for (const [wid, win] of windows) {
      win.windowEl.classList.toggle('window-active', wid === id);
    }
    const win = windows.get(id);
    if (win) {
      zCounter++;
      win.windowEl.style.zIndex = zCounter;
    }
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
      // Restore
      win.maximized = false;
      const g = win.savedGeom;
      if (g) {
        win.windowEl.style.left = g.left;
        win.windowEl.style.top = g.top;
        win.windowEl.style.width = g.width;
        win.windowEl.style.height = g.height;
      }
      win.savedGeom = null;
      requestAnimationFrame(() => {
        win.fitAddon && win.fitAddon.fit();
        sendResize(id, win.terminal);
      });
    } else {
      // Maximize
      win.maximized = true;
      win.savedGeom = {
        left: win.windowEl.style.left,
        top: win.windowEl.style.top,
        width: win.windowEl.style.width,
        height: win.windowEl.style.height
      };
      win.windowEl.style.left = '0px';
      win.windowEl.style.top = '0px';
      win.windowEl.style.width = canvas.clientWidth + 'px';
      win.windowEl.style.height = canvas.clientHeight + 'px';
      bringToFront(id);
      requestAnimationFrame(() => {
        win.fitAddon && win.fitAddon.fit();
        sendResize(id, win.terminal);
      });
    }
  }

  function closeWindow(id) {
    const win = windows.get(id);
    if (!win) return;

    vscode.postMessage({ type: 'closeTerminal', id });

    if (win.resizeObserver) win.resizeObserver.disconnect();
    if (win.terminal) win.terminal.dispose();
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
    requestAnimationFrame(() => {
      win.fitAddon && win.fitAddon.fit();
      sendResize(id, win.terminal);
    });
    updateTaskbar();
  }

  // ── Taskbar ───────────────────────────────────────────────────

  function updateTaskbar() {
    taskbar.innerHTML = '';
    for (const [id, win] of windows) {
      if (!win.minimized) continue;
      const btn = document.createElement('button');
      btn.className = 'taskbar-btn';
      btn.textContent = win.titleEl.textContent;
      btn.title = win.titleEl.textContent;
      btn.addEventListener('click', () => restoreWindow(id));
      taskbar.appendChild(btn);
    }
  }

})();
