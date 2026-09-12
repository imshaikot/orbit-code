import { ClaudeCliBackend } from '@orbit-code/agent/claudeCli';
import { ConversationHistory } from '@orbit-code/agent/history';
import { SessionService } from '@orbit-code/agent/sessionService';
import { GraphService } from '@orbit-code/core/graphService';
import { applySettings } from '@orbit-code/core/settings';
import type { FileReply, FileRequest } from '@orbit-code/protocol';
import * as vscode from 'vscode';
import { ActivityBarLauncher } from './activityBar';
import { onSettingsChanged, readSettings } from './config';
import { PanelController, firstFolder } from './controller';
import { listWorkspaceFiles } from './graph/files';
import { WorkspaceWatcher } from './graph/watcher';
import { SessionStatusBar } from './statusBar';

/** What `activate` returns: what test/smoke-suite.cjs drives without a webview. */
export interface OrbitApi {
  /** A file menu request, as the webview sends it. */
  fileRequest(path: string, request: FileRequest): Promise<FileReply | undefined>;
}

/** Composition root: builds the services, connects them and registers the commands. */
export function activate(context: vscode.ExtensionContext): OrbitApi {
  const log = vscode.window.createOutputChannel('Orbit', { log: true });
  let settings = readSettings();

  const graphs = new GraphService({
    storageDir: (context.storageUri ?? context.globalStorageUri).fsPath,
    indexerPath: vscode.Uri.joinPath(context.extensionUri, 'dist', 'indexer.mjs').fsPath,
    log,
    maxFiles: () => settings.maxFiles,
    folder: firstFolder,
    listFiles: listWorkspaceFiles,
  });
  const session = new SessionService(
    new ClaudeCliBackend(() => settings.claude),
    log,
    { model: settings.claude.model, effort: settings.claude.effort, permissionMode: settings.claude.permissionMode },
    () => ({ cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, trusted: vscode.workspace.isTrusted }),
  );
  const controller = new PanelController(context.extensionUri, log, graphs, session, new ConversationHistory());
  // Keeps the loaded graph current, with or without the panel; a finished turn flushes at once.
  const watcher = new WorkspaceWatcher((changes) => graphs.refresh(changes));

  context.subscriptions.push(
    log,
    watcher,
    graphs,
    session,
    controller,
    session.onEvent(({ event }) => {
      if (event.type === 'turnEnd') watcher.flush();
    }),
    new SessionStatusBar(session),
    new ActivityBarLauncher(() => controller.show(true)),
    onSettingsChanged((next) => applySettings(settings, (settings = next), session)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => session.workspaceChanged()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => session.workspaceChanged()),
    vscode.commands.registerCommand('orbit.open', () => controller.show(true)),
    vscode.commands.registerCommand('orbit.reindex', () => {
      controller.show();
      void graphs.load(true);
    }),
    vscode.commands.registerCommand('orbit.prompt', (text?: unknown) => controller.promptCommand(typeof text === 'string' ? text : undefined)),
    vscode.commands.registerCommand('orbit.interrupt', () => session.interrupt()),
    vscode.commands.registerCommand('orbit.newSession', () => session.newConversation()),
  );

  // `yarn self` starts an Extension Development Host: open straight into the graph.
  if (context.extensionMode === vscode.ExtensionMode.Development && vscode.workspace.workspaceFolders?.length) {
    controller.show();
    if (process.env.ORBIT_REINDEX === '1') void graphs.load(true);
  }

  return { fileRequest: (path, request) => controller.fileRequest(path, request) };
}

export function deactivate(): void {}
