// Workspace-relative POSIX paths typed by people (the rename prompt) or sent by the webview, checked the same way
// on both sides: the webview to explain a bad name before sending it, the host to refuse one anyway.

/**
 * `input` read relative to directory `dir` ("." for the workspace root), normalized: `.` segments dropped, `..` climbing.
 * Undefined for an empty or absolute path, a backslash or control character, a trailing slash, or one leaving the workspace.
 */
export function resolveWithin(dir: string, input: string): string | undefined {
  if (input === '' || input.startsWith('/') || input.endsWith('/') || [...input].some(isForbidden)) return undefined;
  const parts = dir === '.' || dir === '' ? [] : dir.split('/');
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') parts.push(segment);
    else if (parts.pop() === undefined) return undefined;
  }
  return parts.length > 0 ? parts.join('/') : undefined;
}

/** Whether `path` is already a normalized workspace-relative path, as graph node ids are. */
export function isWorkspaceId(path: unknown): path is string {
  return typeof path === 'string' && resolveWithin('.', path) === path;
}

/** Control characters, and the backslash, which is a separator on Windows. */
function isForbidden(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 32 || code === 92 || code === 127;
}
