// What the packaging scripts share (package.mjs, publish.mjs, install-local.mjs). The workflows reach vsce and ovsx
// only through those scripts, so these pins are the only place their versions live.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VSCE = '@vscode/vsce@3.9.2';
export const OVSX = 'ovsx@1.2.0';

/** apps/vscode, the extension's own root. */
export const app = join(dirname(fileURLToPath(import.meta.url)), '..');
export const workspace = join(app, '..', '..');

/** Where package.mjs writes the .vsix: dist/apps/vscode/<name>-<version>.vsix under the workspace root. */
export function vsixPath() {
  const { name, version } = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  return join(workspace, 'dist', 'apps', 'vscode', `${name}-${version}.vsix`);
}
