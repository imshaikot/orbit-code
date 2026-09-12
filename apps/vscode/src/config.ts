import { isEffort, isModelName, isPermissionMode } from '@orbit-code/agent/options';
import type { EffortLevel, PermissionMode } from '@orbit-code/protocol';
import * as vscode from 'vscode';

export interface ClaudeSettings {
  /** Executable; empty means PATH plus the usual install locations. */
  path: string;
  /** Model alias or id; empty means Claude Code's own default. */
  model: string;
  /** Effort level; empty means Claude Code's own default. */
  effort: EffortLevel | '';
  permissionMode: PermissionMode;
  /** Appended to every `claude` invocation, e.g. ["--add-dir", "../shared"]. */
  extraArgs: string[];
}

export interface OrbitSettings {
  maxFiles: number;
  claude: ClaudeSettings;
}

export function readSettings(): OrbitSettings {
  const config = vscode.workspace.getConfiguration('orbit');
  const model = config.get<string>('claude.model', '').trim();
  const effort = config.get<string>('claude.effort', '');
  const mode = config.get<string>('claude.permissionMode', 'default');
  return {
    maxFiles: config.get<number>('maxFiles', 20000),
    claude: {
      path: config.get<string>('claude.path', '').trim(),
      model: isModelName(model) ? model : '',
      effort: isEffort(effort) ? effort : '',
      permissionMode: isPermissionMode(mode) ? mode : 'default',
      extraArgs: config.get<unknown[]>('claude.extraArgs', []).filter((arg): arg is string => typeof arg === 'string'),
    },
  };
}

export function onSettingsChanged(listener: (settings: OrbitSettings) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('orbit')) listener(readSettings());
  });
}
