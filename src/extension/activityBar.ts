import * as vscode from 'vscode';

/**
 * Orbit's activity bar icon. Only a view container gets one, so the container holds a single empty
 * view, and that view being shown is the click: the panel opens and the side bar collapses.
 */
export class ActivityBarLauncher implements vscode.Disposable {
  private readonly view = vscode.window.createTreeView<never>('orbit.launcher', { treeDataProvider: { getChildren: () => [], getTreeItem: (item) => item } });
  private readonly subscription: vscode.Disposable;

  constructor(open: () => void) {
    this.subscription = this.view.onDidChangeVisibility(async ({ visible }) => {
      if (!visible) return;
      // Collapsed while showing Orbit, the side bar would reopen on Orbit with Toggle Side Bar and shut again.
      await vscode.commands.executeCommand('workbench.view.explorer');
      open();
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.view.dispose();
  }
}
