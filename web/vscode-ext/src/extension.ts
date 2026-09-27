import * as vscode from "vscode";
import { BridgeClient } from "./client";

let client: BridgeClient | undefined;

/**
 * agentbox connect: joins this editor to the agentbox bridge running beside
 * it in the sandbox, so "Open in editor" anywhere in the app — a file in
 * Files, a search result, a line an agent pointed at — opens here.
 */
export function activate(context: vscode.ExtensionContext): void {
  const url =
    process.env.AGENTBOX_BRIDGE_URL ||
    vscode.workspace.getConfiguration("agentbox").get<string>("bridgeUrl") ||
    "ws://127.0.0.1:7800/ws/editor";
  const version = String((context.extension.packageJSON as { version?: string }).version ?? "0.0.0");
  const log = vscode.window.createOutputChannel("agentbox");
  client = new BridgeClient({
    url,
    version,
    opener: { open: openInEditor },
    focused: () => vscode.window.state.focused,
    log: (m) => log.appendLine(m),
  });
  client.start();
  context.subscriptions.push(
    log,
    vscode.window.onDidChangeWindowState((s) => client?.focusChanged(s.focused)),
    { dispose: () => client?.stop() },
  );
}

export function deactivate(): void {
  client?.stop();
  client = undefined;
}

/** Open a file at a line (1-based), or reveal a folder in the explorer. */
async function openInEditor(path: string, line?: number, column?: number): Promise<void> {
  const uri = vscode.Uri.file(path);
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type & vscode.FileType.Directory) {
    await vscode.commands.executeCommand("revealInExplorer", uri);
    return;
  }
  const options: vscode.TextDocumentShowOptions = { preview: false };
  if (line !== undefined) {
    const at = new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1));
    options.selection = new vscode.Range(at, at);
  }
  // `vscode.open` picks the right editor for the file — text, image, notebook.
  await vscode.commands.executeCommand("vscode.open", uri, options);
}
