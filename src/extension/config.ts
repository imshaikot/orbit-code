import * as vscode from 'vscode';
import { EFFORT_LEVELS, type EffortLevel, PERMISSION_MODES, type PermissionMode } from '../shared/protocol';

/** Aliases and ids, including provider forms such as `us.anthropic.…` or ARNs; nothing a shell would interpret. */
const MODEL_NAME = /^[\w.:@/[\]-]{0,200}$/;

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

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(value);
}

/** An effort level, or '' for none; it becomes a CLI argument. */
export function isEffort(value: unknown): value is EffortLevel | '' {
  return value === '' || (EFFORT_LEVELS as readonly unknown[]).includes(value);
}

export function isModelName(value: unknown): value is string {
  return typeof value === 'string' && MODEL_NAME.test(value);
}
