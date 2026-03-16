import * as vscode from 'vscode';
import * as pty from 'node-pty';
import * as os from 'os';

let panelInstance: vscode.WebviewPanel | undefined;
const terminals = new Map<string, pty.IPty>();
let idCounter = 0;

export function activate(context: vscode.ExtensionContext) {
  console.log('[CanvasTerminals] activate called');
  context.subscriptions.push(
    vscode.commands.registerCommand('canvasTerminals.open', () => {
      if (panelInstance) {
        panelInstance.reveal();
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        'canvasTerminals',
        'Canvas Terminals',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media')
          ]
        }
      );

      panelInstance = panel;
      vscode.commands.executeCommand('setContext', 'canvasTerminalsActive', true);

      panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);

      panel.webview.onDidReceiveMessage(
        (message) => handleMessage(message, panel.webview),
        undefined,
        context.subscriptions
      );

      panel.onDidDispose(() => {
        panelInstance = undefined;
        vscode.commands.executeCommand('setContext', 'canvasTerminalsActive', false);
        for (const [id, ptyProc] of terminals) {
          try { ptyProc.kill(); } catch (_) {}
          terminals.delete(id);
        }
      });
    })
  );
}

function handleMessage(message: any, webview: vscode.Webview) {
  console.log('[CanvasTerminals] received message:', message.type);
  vscode.window.showInformationMessage(`[DBG] received: ${message.type}`);
  switch (message.type) {
    case 'createTerminal': {
      const id = String(++idCounter);
      const title = message.title || 'Terminal';
      const isClaude = message.shell === 'claude';

      let shell: string;
      let args: string[];

      if (isClaude) {
        if (os.platform() === 'win32') {
          shell = process.env.COMSPEC || 'cmd.exe';
          args = ['/c', 'claude'];
        } else {
          shell = '/bin/sh';
          args = ['-c', 'claude'];
        }
      } else {
        if (os.platform() === 'win32') {
          shell = process.env.COMSPEC || 'cmd.exe';
          args = [];
        } else {
          shell = process.env.SHELL || '/bin/bash';
          args = [];
        }
      }

      console.log('[CanvasTerminals] spawning shell:', shell, args);
      try {
        vscode.window.showInformationMessage(`[DBG] spawning: ${shell}`);
        const ptyProcess = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: process.env.HOME || process.env.USERPROFILE || '/',
          env: process.env as { [key: string]: string },
          useConpty: false
        });
        vscode.window.showInformationMessage(`[DBG] spawned OK, sending terminalCreated`);

        ptyProcess.onData((data: string) => {
          webview.postMessage({ type: 'output', id, data });
        });

        ptyProcess.onExit(({ exitCode }) => {
          webview.postMessage({ type: 'terminalExited', id, exitCode });
          terminals.delete(id);
        });

        terminals.set(id, ptyProcess);
        console.log('[CanvasTerminals] terminal spawned, sending terminalCreated id:', id);
        webview.postMessage({ type: 'terminalCreated', id, title });
      } catch (err: any) {
        console.error('[CanvasTerminals] spawn error:', err);
        vscode.window.showErrorMessage(`[DBG] spawn FAILED: ${err.message}`);
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
        } catch (_) {}
      }
      break;
    }

    case 'closeTerminal': {
      const ptyProc = terminals.get(message.id);
      if (ptyProc) {
        try { ptyProc.kill(); } catch (_) {}
        terminals.delete(message.id);
      }
      break;
    }
  }
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
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

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function deactivate() {
  for (const [, ptyProc] of terminals) {
    try { ptyProc.kill(); } catch (_) {}
  }
  terminals.clear();
}
