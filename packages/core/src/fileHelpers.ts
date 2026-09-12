import { execFile } from 'node:child_process';
import type { FileReply, FileRequest, GitFileState } from '@orbit-code/protocol';

/** Larger files are refused by the editor sheet. */
export const MAX_SHEET_BYTES = 4 * 1024 * 1024;
/** Changes to the followed file made elsewhere are gathered this long before one `content` goes out. */
export const FOLLOW_DEBOUNCE_MS = 150;

/** Where a host sends the followed file's changes made anywhere but the sheet. */
export type FileReplySink = (id: number, path: string, reply: FileReply) => void;

/** Only well-formed requests reach the file system; the webview is untrusted. */
export function parseFileRequest(value: unknown): FileRequest | undefined {
  const request = value as Partial<Record<string, unknown>> | undefined;
  switch (request?.kind) {
    case 'info':
    case 'read':
    case 'close':
    case 'delete':
      return { kind: request.kind };
    case 'show':
      return { kind: 'show', diff: request.diff === true };
    case 'write':
      return typeof request.text === 'string' && Number.isInteger(request.revision) ? { kind: 'write', text: request.text, revision: request.revision as number, force: request.force === true } : undefined;
    case 'rename':
      return typeof request.to === 'string' ? { kind: 'rename', to: request.to } : undefined;
    default:
      return undefined;
  }
}

export function failedReply(error: string): FileReply {
  return { kind: 'failed', error };
}

/** Resolves to stdout, or undefined when git fails or is missing, or there is no folder on disk. */
export function git(root: string | undefined, args: string[]): Promise<string | undefined> {
  if (root === undefined) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--literal-pathspecs', ...args],
      // No optional locks: the editor's own git integration may be reading the index at the same time.
      { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

export async function gitState(root: string | undefined, path: string): Promise<GitFileState> {
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', path]);
  if (status === undefined) return 'none';
  if (status === '') return 'clean';
  return status.startsWith('??') ? 'untracked' : 'changed';
}

/** The file as HEAD has it; empty when HEAD lacks it (a new file, or a repository without commits). */
export async function headText(root: string | undefined, path: string): Promise<string> {
  // `./` makes the path relative to the workspace folder, wherever the repository root is.
  return (await git(root, ['show', `HEAD:./${path}`])) ?? '';
}

/** What the editor sheet diffs against: HEAD's text when the file has changes, else nothing. */
export async function baseText(root: string | undefined, path: string): Promise<string | undefined> {
  return (await gitState(root, path)) === 'changed' ? headText(root, path) : undefined;
}
