import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Folders the user said they trust, as VS Code's workspace trust: Claude Code runs in a folder with the settings,
 * hooks and MCP servers the folder configures, so sessions stay off in a folder until the user trusts it. The graph
 * works either way. `--disable-workspace-trust` trusts every folder, as it does for VS Code.
 */
export class TrustedFolders {
  private readonly folders: Set<string>;

  constructor(
    private readonly path: string,
    private readonly trustAll: boolean,
  ) {
    this.folders = new Set(load(path));
  }

  has(folder: string): boolean {
    return this.trustAll || this.folders.has(folder);
  }

  add(folder: string): void {
    this.folders.add(folder);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify({ trusted: [...this.folders] }, null, 2)}\n`);
    } catch {
      // trusted for this run at least
    }
  }
}

function load(path: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { trusted?: unknown };
    return Array.isArray(raw.trusted) ? raw.trusted.filter((folder): folder is string => typeof folder === 'string') : [];
  } catch {
    return [];
  }
}
