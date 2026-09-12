import type { WorkspaceFolderInfo } from '@orbit-code/core/graphService';
import { FALLBACK_EXCLUDED_DIRS, fallbackExcludeGlob, indexableGlob, isIndexable } from '@orbit-code/graph/languages';
import { type ListedFiles, gitLsFiles, toListedFiles } from '@orbit-code/indexer/listFiles';
import * as vscode from 'vscode';

/** git ls-files when the folder is a work tree (respects .gitignore), otherwise workspace.findFiles. */
export async function listWorkspaceFiles(folder: WorkspaceFolderInfo, maxFiles: number): Promise<ListedFiles> {
  const root = folder.path;
  const tracked = await gitLsFiles(root);
  if (tracked) return toListedFiles(root, tracked.filter((id) => isIndexable(id)), maxFiles, 'git');

  const excluded = new Set(FALLBACK_EXCLUDED_DIRS);
  const base = vscode.Uri.file(root);
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.workspace.getWorkspaceFolder(base) ?? base, indexableGlob()), fallbackExcludeGlob(), maxFiles + 1);
  const ids = uris
    .map((uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'))
    .filter((id) => isIndexable(id, excluded));
  return toListedFiles(root, ids, maxFiles, 'findFiles');
}
