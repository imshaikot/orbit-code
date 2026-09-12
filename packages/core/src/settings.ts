import { isEffort, isModelName, isPermissionMode } from '@orbit-code/agent/options';
import type { SessionService } from '@orbit-code/agent/sessionService';
import type { EffortLevel, PermissionMode } from '@orbit-code/protocol';

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

/** Orbit's settings, whichever store a host keeps them in (VS Code's `orbit.*`, a settings file). */
export interface OrbitSettings {
  maxFiles: number;
  claude: ClaudeSettings;
}

export const DEFAULT_MAX_FILES = 20000;
const MIN_MAX_FILES = 100;

/**
 * Settings as a host read them, checked: every value becomes part of an index run or a command line, so anything
 * malformed falls back to its default. `claude.model` and `claude.effort` pass the same checks a webview value does.
 */
export function normalizeSettings(raw: unknown): OrbitSettings {
  const top = record(raw);
  const claude = record(top.claude);
  const maxFiles = top.maxFiles;
  const model = typeof claude.model === 'string' ? claude.model.trim() : '';
  return {
    maxFiles: typeof maxFiles === 'number' && Number.isFinite(maxFiles) ? Math.max(MIN_MAX_FILES, Math.floor(maxFiles)) : DEFAULT_MAX_FILES,
    claude: {
      path: typeof claude.path === 'string' ? claude.path.trim() : '',
      model: isModelName(model) ? model : '',
      effort: isEffort(claude.effort) ? claude.effort : '',
      permissionMode: isPermissionMode(claude.permissionMode) ? claude.permissionMode : 'default',
      extraArgs: Array.isArray(claude.extraArgs) ? claude.extraArgs.filter((arg): arg is string => typeof arg === 'string') : [],
    },
  };
}

/** What a settings change does to the session: a new executable or arguments probes again; a new model, effort or mode applies from the next prompt. */
export function applySettings(previous: OrbitSettings, next: OrbitSettings, session: SessionService): void {
  const { claude: before } = previous;
  const { claude: after } = next;
  if (after.path !== before.path || after.extraArgs.join('\0') !== before.extraArgs.join('\0')) void session.refresh();
  if (after.model !== before.model || after.effort !== before.effort || after.permissionMode !== before.permissionMode) {
    session.setOptions({ model: after.model, effort: after.effort, permissionMode: after.permissionMode });
  }
}

function record(value: unknown): Partial<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
