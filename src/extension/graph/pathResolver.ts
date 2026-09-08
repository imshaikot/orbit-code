import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type PathResolver = (filePath: string) => number | undefined;

/**
 * Maps a path a tool reported (absolute, or relative to the workspace root) to a
 * graph node index. Anything outside the workspace or not in the graph resolves to
 * undefined; nothing is remapped onto a stand-in.
 */
export function createPathResolver(root: string, ids: readonly string[]): PathResolver {
  const indexOf = new Map(ids.map((id, i) => [id, i]));
  // Tools may report the resolved path (macOS /tmp → /private/tmp), so try both spellings of the root.
  const roots = [...new Set([root, realpathOr(root)])];
  return (filePath) => {
    for (const base of roots) {
      const rel = relative(base, isAbsolute(filePath) ? filePath : resolve(base, filePath));
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      const node = indexOf.get(sep === '/' ? rel : rel.split(sep).join('/'));
      if (node !== undefined) return node;
    }
    return undefined;
  };
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
