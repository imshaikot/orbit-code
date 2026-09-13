// Where the desktop app's scripts find things, and the one place electron-builder's version is pinned (fetched with
// `yarn dlx`, as vsce is for the extension, so it isn't a dependency every install downloads).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ELECTRON_BUILDER = 'electron-builder@26.15.3';

export const app = join(dirname(fileURLToPath(import.meta.url)), '..');
export const workspace = join(app, '..', '..');
/** electron-builder-yml's directories.output. */
export const output = join(workspace, 'dist', 'apps', 'desktop');
