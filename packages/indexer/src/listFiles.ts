import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FALLBACK_EXCLUDED_DIRS, isIndexable } from '@orbit-code/graph/languages';

export interface ListedFiles {
  files: { id: string; path: string }[];
  truncated: boolean;
  via: 'git' | 'walk' | 'findFiles';
}

/** Tracked + untracked-but-not-ignored files, relative to `root`. Undefined when `root` is not in a git work tree. */
export function gitLsFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout.split('\0').filter(Boolean)),
    );
  });
}

export function toListedFiles(root: string, ids: Iterable<string>, maxFiles: number, via: ListedFiles['via']): ListedFiles {
  const unique = [...new Set(ids)].sort();
  return {
    files: unique.slice(0, maxFiles).map((id) => ({ id, path: join(root, id) })),
    truncated: unique.length > maxFiles,
    via,
  };
}

/** Used outside VS Code (CLI, harness). The extension host uses workspace.findFiles instead of the walk. */
export async function listFilesOnDisk(root: string, maxFiles: number): Promise<ListedFiles> {
  const tracked = await gitLsFiles(root);
  if (tracked) return toListedFiles(root, tracked.filter((id) => isIndexable(id)), maxFiles, 'git');

  const excluded = new Set(FALLBACK_EXCLUDED_DIRS);
  const ids: string[] = [];
  const pending = [''];
  while (pending.length > 0 && ids.length <= maxFiles) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const id = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name) && !entry.name.startsWith('.')) pending.push(id);
      } else if (entry.isFile() && isIndexable(id, excluded)) {
        ids.push(id);
      }
    }
  }
  return toListedFiles(root, ids, maxFiles, 'walk');
}
