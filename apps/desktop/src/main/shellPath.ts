import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';
import type { Logger } from '@orbit-code/common/log';

const TIMEOUT_MS = 3000;
const MARKER = '__ORBIT_PATH__';

/**
 * An app started from the Finder, the dock or a desktop launcher gets a bare PATH, without what the user's shell
 * profile adds, so `git` and `claude` would be missing. Asks the login shell once and appends the entries PATH lacks,
 * keeping the order of what is there (a launch from a terminal already has them). Not on Windows, where GUI apps get
 * the user's PATH.
 */
export function adoptLoginShellPath(log: Logger): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  return new Promise((resolve) => {
    // Markers around the value, since an interactive profile may print anything around it.
    execFile(shell, ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`], { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const found = new RegExp(`${MARKER}(.*?)${MARKER}`, 's').exec(stdout ?? '')?.[1];
      if (!found) {
        log.warn(`PATH: could not ask ${shell} for the login PATH${error ? ` (${error.message})` : ''}; keeping the inherited one`);
        resolve();
        return;
      }
      const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
      const added = found.split(delimiter).filter((entry) => entry && !current.includes(entry));
      if (added.length > 0) process.env.PATH = [...current, ...added].join(delimiter);
      resolve();
    });
  });
}
