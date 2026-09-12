import type { ConversationHistory } from '@orbit-code/agent/history';
import type { SessionService } from '@orbit-code/agent/sessionService';
import { type HostUi, OrbitController, type PermissionPrompt } from '@orbit-code/core/controller';
import type { GraphService, WorkspaceFolderInfo } from '@orbit-code/core/graphService';
import type { FileReply, FileRequest, HostCapabilities } from '@orbit-code/protocol';
import * as vscode from 'vscode';
import { FileActions } from './fileActions';
import { OrbitPanel } from './panel/orbitPanel';

/** The first workspace folder, which Orbit indexes and runs Claude in. */
export function firstFolder(): WorkspaceFolderInfo | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && { name: folder.name, path: folder.uri.fsPath };
}

/**
 * VS Code's side of the shared OrbitController: the Orbit panel, the dialogs, notifications and editor tabs the
 * controller asks for, and the commands that open the panel or prompt from outside it.
 */
export class PanelController implements HostUi, vscode.Disposable {
  readonly capabilities: HostCapabilities = { tabs: true };
  private readonly controller: OrbitController;
  private panel: OrbitPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    log: vscode.LogOutputChannel,
    graphs: GraphService,
    private readonly session: SessionService,
    history: ConversationHistory,
  ) {
    const files = new FileActions(log, (id, path, reply) => this.controller.sendFile(id, path, reply));
    this.controller = new OrbitController(log, graphs, session, history, files, this);
  }

  /**
   * Opens the panel or brings it forward. Turning Orbit on collapses the side bar to give the graph the
   * width; `collapseSidebar` does that for an open panel too (Orbit Code: Open, the activity bar icon).
   */
  show(collapseSidebar = false): void {
    if (collapseSidebar || !this.panel) void vscode.commands.executeCommand('workbench.action.closeSidebar');
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = OrbitPanel.create(this.extensionUri);
    this.panel = panel;
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    this.controller.attach(panel);
  }

  /** `orbit.prompt`: takes the text as an argument (automation) or asks for it. It continues the current conversation, or starts one beside a busy one. */
  async promptCommand(text: string | undefined): Promise<boolean> {
    this.show();
    await this.session.ensureProbed();
    const state = this.session.state;
    if (state.phase === 'unavailable') {
      void vscode.window.showWarningMessage(`Orbit Code: ${state.error ?? 'Claude Code is not available.'}`);
      return false;
    }
    const prompt =
      text ??
      (await vscode.window.showInputBox({
        title: 'Ask Claude',
        prompt: `${state.agent ?? 'Claude Code'} in ${vscode.workspace.workspaceFolders?.[0]?.name ?? 'this workspace'}`,
        placeHolder: 'What should Claude do?',
        ignoreFocusOut: true,
      }));
    return prompt ? this.session.prompt(prompt) !== undefined : false;
  }

  /** A file menu request, as the webview sends it; what the smoke test drives. */
  fileRequest(path: string, request: FileRequest): Promise<FileReply | undefined> {
    return this.controller.fileRequest(0, path, request);
  }

  folder(): WorkspaceFolderInfo | undefined {
    return firstFolder();
  }

  async pickFiles(folder: string | undefined): Promise<string[]> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: folder ? vscode.Uri.file(folder) : undefined,
      openLabel: 'Attach',
      title: 'Attach files to the prompt',
    });
    return (uris ?? []).filter((uri) => uri.scheme === 'file').map((uri) => uri.fsPath);
  }

  openExternal(url: string): void {
    // Handed over as the string itself: VS Code opens a string exactly as given, where a parsed Uri would re-encode the
    // page's query (its redirect_uri, say) and break the sign-in.
    void vscode.env.openExternal(url as unknown as vscode.Uri);
  }

  async openFile(absolute: string): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(absolute), { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  notifyPermission({ request, answer }: PermissionPrompt): void {
    if (request.questions) {
      // Questions are answered on the card, which a notification can't hold: open Orbit, or let Claude go on without them.
      const asked = request.questions.length === 1 ? request.questions[0].question : `${request.questions.length} questions`;
      void vscode.window.showWarningMessage(`Claude asks: ${asked}`, 'Open Orbit', 'Skip').then((choice) => {
        if (choice === 'Open Orbit') this.show();
        else if (choice === 'Skip') answer('deny');
      });
      return;
    }
    const choices = request.always ? ['Allow', request.always, 'Deny'] : ['Allow', 'Deny'];
    void vscode.window.showWarningMessage(`Claude wants to use ${request.tool}: ${request.detail}`, ...choices).then((choice) => {
      if (choice) answer(choice === 'Allow' ? 'allow' : choice === 'Deny' ? 'deny' : 'always');
    });
  }

  dispose(): void {
    this.controller.dispose();
    this.panel?.dispose();
  }
}
