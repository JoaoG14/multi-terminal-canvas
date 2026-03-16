"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const pty = require("node-pty");
const os = require("os");
const fs = require("fs");
const path = require("path");
let panelInstance;
const terminals = new Map();
let idCounter = 0;
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('canvasTerminals.open', () => {
        if (panelInstance) {
            panelInstance.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel('canvasTerminals', 'Canvas Terminals', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media')
            ]
        });
        panelInstance = panel;
        vscode.commands.executeCommand('setContext', 'canvasTerminalsActive', true);
        panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);
        panel.webview.onDidReceiveMessage((message) => handleMessage(message, panel.webview), undefined, context.subscriptions);
        panel.onDidDispose(() => {
            panelInstance = undefined;
            vscode.commands.executeCommand('setContext', 'canvasTerminalsActive', false);
            for (const [id, ptyProc] of terminals) {
                try {
                    ptyProc.kill();
                }
                catch (_) { }
                terminals.delete(id);
            }
        });
    }));
}
function handleMessage(message, webview) {
    switch (message.type) {
        case 'ready': {
            webview.postMessage({ type: 'shellsAvailable', shells: getAvailableShells() });
            break;
        }
        case 'createTerminal': {
            const id = String(++idCounter);
            const title = message.title || 'Terminal';
            const isClaude = message.shell === 'claude';
            let shell;
            let args;
            if (isClaude) {
                if (os.platform() === 'win32') {
                    shell = process.env.COMSPEC || 'cmd.exe';
                    args = ['/c', 'claude'];
                }
                else {
                    shell = '/bin/sh';
                    args = ['-c', 'claude'];
                }
            }
            else if (message.shellPath) {
                shell = message.shellPath;
                args = getDefaultArgs(shell);
            }
            else {
                if (os.platform() === 'win32') {
                    shell = process.env.COMSPEC || 'cmd.exe';
                    args = [];
                }
                else {
                    shell = process.env.SHELL || '/bin/bash';
                    args = [];
                }
            }
            const initialCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
                || process.env.HOME || process.env.USERPROFILE || '/';
            try {
                const ptyProcess = pty.spawn(shell, args, {
                    name: 'xterm-256color',
                    cols: 80,
                    rows: 24,
                    cwd: initialCwd,
                    env: process.env,
                    useConpty: false
                });
                // OSC 7 reports cwd changes: ESC ] 7 ; file://host/path BEL|ST
                const osc7Re = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)/;
                ptyProcess.onData((data) => {
                    webview.postMessage({ type: 'output', id, data });
                    const m = data.match(osc7Re);
                    if (m) {
                        let cwd = decodeURIComponent(m[1]);
                        // Windows: /C:/path → C:\path
                        cwd = cwd.replace(/^\/([A-Za-z]):/, '$1:').replace(/\//g, '\\');
                        webview.postMessage({ type: 'cwdChanged', id, cwd });
                    }
                });
                ptyProcess.onExit(({ exitCode }) => {
                    webview.postMessage({ type: 'terminalExited', id, exitCode });
                    terminals.delete(id);
                });
                terminals.set(id, ptyProcess);
                webview.postMessage({ type: 'terminalCreated', id, title, cwd: initialCwd });
            }
            catch (err) {
                vscode.window.showErrorMessage(`Canvas Terminals: failed to spawn shell — ${err.message}`);
            }
            break;
        }
        case 'input': {
            const ptyProc = terminals.get(message.id);
            if (ptyProc) {
                ptyProc.write(message.data);
            }
            break;
        }
        case 'resize': {
            const ptyProc = terminals.get(message.id);
            if (ptyProc) {
                try {
                    ptyProc.resize(message.cols, message.rows);
                }
                catch (_) { }
            }
            break;
        }
        case 'closeTerminal': {
            const ptyProc = terminals.get(message.id);
            if (ptyProc) {
                try {
                    ptyProc.kill();
                }
                catch (_) { }
                terminals.delete(message.id);
            }
            break;
        }
    }
}
function getAvailableShells() {
    const shells = [];
    if (os.platform() === 'win32') {
        // cmd.exe — always present
        shells.push({ name: 'cmd', path: process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe' });
        // Windows PowerShell 5
        const ps5 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        if (fs.existsSync(ps5))
            shells.push({ name: 'PowerShell 5', path: ps5 });
        // PowerShell 7+ (pwsh) — several common install locations
        for (const p of [
            'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
            'C:\\Program Files\\PowerShell\\7.4\\pwsh.exe',
            'C:\\Program Files\\PowerShell\\7.3\\pwsh.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
        ]) {
            if (fs.existsSync(p)) {
                shells.push({ name: 'PowerShell 7', path: p });
                break;
            }
        }
        // Git Bash
        for (const p of [
            'C:\\Program Files\\Git\\bin\\bash.exe',
            'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
        ]) {
            if (fs.existsSync(p)) {
                shells.push({ name: 'Git Bash', path: p });
                break;
            }
        }
        // WSL
        const wsl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
        if (fs.existsSync(wsl))
            shells.push({ name: 'WSL', path: wsl });
    }
    else {
        // Unix: parse /etc/shells, fall back to known paths
        let candidates = [];
        try {
            candidates = fs.readFileSync('/etc/shells', 'utf8')
                .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        }
        catch {
            candidates = ['/bin/bash', '/bin/zsh', '/bin/fish', '/bin/sh', '/usr/bin/bash',
                '/usr/bin/zsh', '/usr/local/bin/fish'];
        }
        const seen = new Set();
        for (const p of candidates) {
            const name = path.basename(p);
            if (!seen.has(name) && fs.existsSync(p)) {
                seen.add(name);
                shells.push({ name, path: p });
            }
        }
    }
    return shells;
}
function getDefaultArgs(shellPath) {
    const name = path.basename(shellPath).toLowerCase();
    if (name === 'powershell.exe' || name === 'pwsh.exe')
        return ['-NoLogo'];
    return [];
}
function getWebviewContent(webview, extensionUri) {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} https://cdn.jsdelivr.net 'unsafe-inline'; script-src ${webview.cspSource} https://cdn.jsdelivr.net 'nonce-${nonce}'; font-src https://cdn.jsdelivr.net;">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5/css/xterm.css">
  <link rel="stylesheet" href="${cssUri}">
  <title>Canvas Terminals</title>
</head>
<body>
  <div id="desktop">
    <div id="toolbar">
      <button id="btn-new-terminal">+ Terminal</button>
      <button id="btn-new-claude">+ Claude</button>
    </div>
    <div id="canvas"></div>
    <div id="taskbar"></div>
  </div>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/xterm@5/lib/xterm.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8/lib/xterm-addon-fit.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9/lib/xterm-addon-web-links.js"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
function deactivate() {
    for (const [, ptyProc] of terminals) {
        try {
            ptyProc.kill();
        }
        catch (_) { }
    }
    terminals.clear();
}
//# sourceMappingURL=extension.js.map