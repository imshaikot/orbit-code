import * as vscode from 'vscode';
import type { FileReply, FileRequest } from '../shared/protocol';
import { ActivityBarLauncher } from './activityBar';
import { type OrbitSettings, onSettingsChanged, readSettings } from './config';
import { OrbitController } from './controller';
import { GraphService } from './graph/graphService';
import { WorkspaceWatcher } from './graph/watcher';
import { ClaudeCliBackend } from './session/claudeCli';
import { ConversationHistory } from './session/history';
import { SessionService } from './session/sessionService';
import { SessionStatusBar } from './statusBar';

/** What `activate` returns: what scripts/smoke-suite.cjs drives without a webview. */
export interface OrbitApi {
  /** A file menu request, as the webview sends it. */
  fileRequest(path: string, request: FileRequest): Promise<FileReply | undefined>;
}

/** Composition root: builds the services, connects them and registers the commands. */
export function activate(context: vscode.ExtensionContext): OrbitApi {
  const log = vscode.window.createOutputChannel('Orbit', { log: true });
  let settings = readSettings();

  const graphs = new GraphService(context, log, () => settings.maxFiles);
  const session = new SessionService(
    new ClaudeCliBackend(() => settings.claude),
    log,
    { model: settings.claude.model, effort: settings.claude.effort, permissionMode: settings.claude.permissionMode },
    () => ({ cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, trusted: vscode.workspace.isTrusted }),
  );
  const controller = new OrbitController(context.extensionUri, log, graphs, session, new ConversationHistory());
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

  return { fileRequest: (path, request) => controller.fileRequest(0, path, request) };
}

export function deactivate(): void {}

function applySettings(previous: OrbitSettings, next: OrbitSettings, session: SessionService): void {
  const { claude: before } = previous;
  const { claude: after } = next;
  if (after.path !== before.path || after.extraArgs.join('\0') !== before.extraArgs.join('\0')) void session.refresh();
  if (after.model !== before.model || after.effort !== before.effort || after.permissionMode !== before.permissionMode) {
    session.setOptions({ model: after.model, effort: after.effort, permissionMode: after.permissionMode });
  }
}
