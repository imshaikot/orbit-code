import { type OrbitSettings, normalizeSettings } from '@orbit-code/core/settings';
import * as vscode from 'vscode';

/** The `orbit.*` settings, checked the way every host checks its settings. */
export function readSettings(): OrbitSettings {
  const config = vscode.workspace.getConfiguration('orbit');
  return normalizeSettings({
    maxFiles: config.get<number>('maxFiles', 20000),
    claude: {
      path: config.get<string>('claude.path', ''),
      model: config.get<string>('claude.model', ''),
      effort: config.get<string>('claude.effort', ''),
      permissionMode: config.get<string>('claude.permissionMode', 'default'),
      extraArgs: config.get<unknown[]>('claude.extraArgs', []),
    },
  });
}

export function onSettingsChanged(listener: (settings: OrbitSettings) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('orbit')) listener(readSettings());
  });
}
