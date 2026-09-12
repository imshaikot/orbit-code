// Checks for the session options a host passes on from its settings or its UI. Each value becomes a claude CLI
// argument, so a host checks it here before handing it to SessionService.
import { EFFORT_LEVELS, type EffortLevel, PERMISSION_MODES, type PermissionMode } from '@orbit-code/protocol';

/** Aliases and ids, including provider forms such as `us.anthropic.…` or ARNs; nothing a shell would interpret. */
const MODEL_NAME = /^[\w.:@/[\]-]{0,200}$/;

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(value);
}

/** An effort level, or '' for none. */
export function isEffort(value: unknown): value is EffortLevel | '' {
  return value === '' || (EFFORT_LEVELS as readonly unknown[]).includes(value);
}

export function isModelName(value: unknown): value is string {
  return typeof value === 'string' && MODEL_NAME.test(value);
}
