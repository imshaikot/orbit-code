// The permission updates Claude Code attaches to a can_use_tool request (`permission_suggestions`) and takes back
// in an allow answer (`updatedPermissions`). They are what a terminal's "Yes, don't ask again" chooses: a rule for
// the tool (persisted to settings by the CLI itself), edits accepted for the rest of the session, or a directory
// added. Orbit passes them through as they came, so Claude Code applies its own suggestions; nothing here knows how
// a rule is written or where a setting file lives. Shapes as of Claude Code 2.1.267. Pure.

export type PermissionDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';

export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
}

export type PermissionUpdate =
  | { type: 'addRules' | 'replaceRules' | 'removeRules'; rules: PermissionRule[]; behavior: 'allow' | 'deny' | 'ask'; destination: PermissionDestination }
  | { type: 'setMode'; mode: string; destination: PermissionDestination }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: PermissionDestination };

const DESTINATIONS: ReadonlySet<string> = new Set(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']);
const BEHAVIORS: ReadonlySet<string> = new Set(['allow', 'deny', 'ask']);

/** The well-formed updates in a `permission_suggestions` value; anything else is left out. */
export function parsePermissionUpdates(value: unknown): PermissionUpdate[] {
  if (!Array.isArray(value)) return [];
  const updates: PermissionUpdate[] = [];
  for (const item of value) {
    const update = parseUpdate(item);
    if (update) updates.push(update);
  }
  return updates;
}

function parseUpdate(item: unknown): PermissionUpdate | undefined {
  if (!isObject(item) || typeof item.destination !== 'string' || !DESTINATIONS.has(item.destination)) return undefined;
  const destination = item.destination as PermissionDestination;
  switch (item.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules': {
      if (typeof item.behavior !== 'string' || !BEHAVIORS.has(item.behavior) || !Array.isArray(item.rules)) return undefined;
      const rules: PermissionRule[] = [];
      for (const rule of item.rules) {
        if (!isObject(rule) || typeof rule.toolName !== 'string') return undefined;
        rules.push(typeof rule.ruleContent === 'string' ? { toolName: rule.toolName, ruleContent: rule.ruleContent } : { toolName: rule.toolName });
      }
      return { type: item.type, rules, behavior: item.behavior as 'allow' | 'deny' | 'ask', destination };
    }
    case 'setMode':
      return typeof item.mode === 'string' ? { type: 'setMode', mode: item.mode, destination } : undefined;
    case 'addDirectories':
    case 'removeDirectories':
      return Array.isArray(item.directories) && item.directories.every((directory) => typeof directory === 'string')
        ? { type: item.type, directories: item.directories as string[], destination }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * What allowing with these updates would do, as the label of that choice: "Allow all edits this session",
 * "Always allow in this project", "Allow this directory this session". Undefined when the updates would not
 * allow anything more, so the choice is not offered.
 */
export function describeAlways(updates: readonly PermissionUpdate[]): string | undefined {
  const update = updates.find(allows);
  if (!update) return undefined;
  const scope = scopeOf(update.destination);
  switch (update.type) {
    case 'setMode':
      return update.mode === 'acceptEdits' ? `Allow all edits ${scope}` : `Switch to ${update.mode} ${scope}`;
    case 'addDirectories':
      return `Allow ${update.directories.length === 1 ? 'this directory' : 'these directories'} ${scope}`;
    default:
      return `Always allow ${scope}`;
  }
}

function allows(update: PermissionUpdate): boolean {
  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
      return update.behavior === 'allow' && update.rules.length > 0;
    case 'setMode':
    case 'addDirectories':
      return true;
    default:
      return false;
  }
}

function scopeOf(destination: PermissionDestination): string {
  switch (destination) {
    case 'userSettings':
      return 'everywhere';
    case 'projectSettings':
    case 'localSettings':
      return 'in this project';
    default:
      return 'this session';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
