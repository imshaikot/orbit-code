// Which skills Claude Code offers in a workspace, and where each comes from: SKILL.md files under the workspace's
// .claude/skills (project), the user's skills directory (user) and installed plugins (plugin). The commands the CLI
// reports decide what is listed, so a disabled plugin or a directory without a valid SKILL.md drops out; the files
// add the scope and what each skill's instructions name of the others.

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { SkillInfo, SkillScope } from '@orbit-code/protocol';
import type { CliCommand } from './streamJson';
import { oneLine } from './tools';

const MAX_SKILL_BYTES = 256_000;
const MAX_SKILLS = 200;
const MAX_DESCRIPTION = 600;

export interface DiskSkill {
  /** As invoked: frontmatter name, else the directory; `plugin:` in front for a plugin's. */
  name: string;
  /** The same with the directory name, which the CLI may use instead. */
  dir: string;
  description: string;
  scope: SkillScope;
  plugin?: string;
  path: string;
  body: string;
}

/** Claude Code's configuration directory: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export async function findSkills(cwd: string, configDir = claudeConfigDir()): Promise<DiskSkill[]> {
  const found = [...(await skillsIn(join(cwd, '.claude', 'skills'), 'project')), ...(await skillsIn(join(configDir, 'skills'), 'user'))];
  for (const plugin of await installedPlugins(configDir)) found.push(...(await skillsIn(join(plugin.path, 'skills'), 'plugin', plugin.name)));
  return found.slice(0, MAX_SKILLS);
}

/**
 * The catalog's skills. With `commands` (what the CLI offers), a skill on disk is listed only if the CLI offers it, and a
 * plugin command without a file found is listed too; without them (the CLI did not answer), everything found on disk.
 */
export function catalogSkills(disk: readonly DiskSkill[], commands: readonly CliCommand[] | undefined, cwd: string): SkillInfo[] {
  const offered = commands && new Map(commands.map((command) => [command.name, command]));
  const skills: SkillInfo[] = [];
  const bodies = new Map<string, string>();
  for (const skill of disk) {
    const command = offered?.get(skill.name) ?? offered?.get(skill.dir);
    if (offered && !command) continue;
    const name = command?.name ?? skill.name;
    if (bodies.has(name)) continue;
    bodies.set(name, skill.body);
    skills.push({
      name,
      description: oneLine(command?.description || skill.description, MAX_DESCRIPTION),
      argumentHint: command?.argumentHint,
      scope: skill.scope,
      plugin: skill.plugin,
      file: skill.scope === 'project' ? workspaceRelative(cwd, skill.path) : undefined,
      references: [],
    });
  }
  for (const command of commands ?? []) {
    const colon = command.name.indexOf(':');
    if (colon <= 0 || bodies.has(command.name) || skills.some((skill) => skill.name === command.name)) continue;
    skills.push({ name: command.name, description: oneLine(command.description, MAX_DESCRIPTION), argumentHint: command.argumentHint, scope: 'plugin', plugin: command.name.slice(0, colon), references: [] });
  }
  for (const skill of skills) {
    const body = bodies.get(skill.name);
    if (body) skill.references = referencesIn(body, skill.name, skills);
  }
  return skills;
}

async function skillsIn(dir: string, scope: SkillScope, plugin?: string): Promise<DiskSkill[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  const skills: DiskSkill[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const path = join(dir, entry, 'SKILL.md');
    let text: string;
    try {
      // stat follows symlinks: a skills directory is often a link into another checkout.
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_SKILL_BYTES) continue;
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const { fields, body } = frontmatter(text);
    const prefix = plugin ? `${plugin}:` : '';
    skills.push({ name: `${prefix}${fields.name || entry}`, dir: `${prefix}${entry}`, description: fields.description ?? '', scope, plugin, path, body });
  }
  return skills;
}

/** installed_plugins.json: { plugins: { "name@marketplace": [{ installPath, … }] } }. */
async function installedPlugins(configDir: string): Promise<Array<{ name: string; path: string }>> {
  let registry: unknown;
  try {
    registry = JSON.parse(await readFile(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return [];
  }
  const plugins = typeof registry === 'object' && registry !== null ? (registry as { plugins?: unknown }).plugins : undefined;
  if (typeof plugins !== 'object' || plugins === null) return [];
  const found = new Map<string, { name: string; path: string }>();
  for (const [key, installs] of Object.entries(plugins)) {
    const name = key.split('@')[0];
    for (const install of Array.isArray(installs) ? installs : []) {
      const path = typeof install?.installPath === 'string' ? install.installPath : undefined;
      if (name && path && isAbsolute(path)) found.set(path, { name, path });
    }
  }
  return [...found.values()];
}

/** The YAML frontmatter's top-level scalar fields, block scalars (`>`, `|`) folded onto one line. */
function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  let block: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) {
      const value = field[2].trim();
      block = /^[>|][+-]?$/.test(value) ? field[1] : undefined;
      fields[field[1]] = block ? '' : unquote(value);
    } else if (block && /^\s+\S/.test(line)) {
      fields[block] = `${fields[block]} ${line.trim()}`.trim();
    }
  }
  return { fields, body: text.slice(match[0].length) };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/**
 * Skills another skill's instructions name. A name with a hyphen or colon counts wherever it stands (paths included);
 * a plain word only as `/name`, **name**, `name` in code, or "name skill", so "run" in prose is not a reference.
 */
function referencesIn(body: string, self: string, skills: readonly SkillInfo[]): string[] {
  const names: string[] = [];
  for (const other of skills) {
    if (other.name === self) continue;
    const bare = escapeRegExp(other.name.slice(other.name.indexOf(':') + 1));
    const full = escapeRegExp(other.name);
    const pattern = /[-:]/.test(other.name)
      ? new RegExp(`(?<![\\w-])(?:${full}|${bare})(?![\\w-])`)
      : new RegExp(`\\*\\*${bare}\\*\\*|\`/?${bare}\`|(?<![\\w/-])/${bare}(?![\\w-])|\\b${bare} skill\\b`, 'i');
    if (pattern.test(body)) names.push(other.name);
  }
  return names;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function workspaceRelative(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join('/') : undefined;
}
