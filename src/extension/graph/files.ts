import * as vscode from 'vscode';
import { type ListedFiles, gitLsFiles, toListedFiles } from '../../indexer/listFiles';
import { FALLBACK_EXCLUDED_DIRS, fallbackExcludeGlob, indexableGlob, isIndexable } from '../../shared/languages';

/** git ls-files when the folder is a work tree (respects .gitignore), otherwise workspace.findFiles. */
export async function listWorkspaceFiles(folder: vscode.WorkspaceFolder, maxFiles: number): Promise<ListedFiles> {
  const root = folder.uri.fsPath;
  const tracked = await gitLsFiles(root);
  if (tracked) return toListedFiles(root, tracked.filter((id) => isIndexable(id)), maxFiles, 'git');

  const excluded = new Set(FALLBACK_EXCLUDED_DIRS);
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, indexableGlob()), fallbackExcludeGlob(), maxFiles + 1);
  const ids = uris
    .map((uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'))
    .filter((id) => isIndexable(id, excluded));
  return toListedFiles(root, ids, maxFiles, 'findFiles');
}
