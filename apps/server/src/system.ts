// What the desktop app asks Electron's shell and dialog for, done with each platform's own commands: open a web page,
// move a file to the trash, choose files. Arguments go to the command as arguments or environment, never through a shell.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

function run(command: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: env ? { ...process.env, ...env } : process.env, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** Opens a web page in the default browser; anything but http(s) is refused. Whether a browser was started. */
export function openUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command as string, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Moves a file to the system's trash, as the desktop app's `shell.trashItem` does. Throws where that can't be done, so the file stays. */
export async function trash(absolute: string): Promise<void> {
  if (process.platform === 'darwin') {
    if (existsSync('/usr/bin/trash')) await run('/usr/bin/trash', [absolute]);
    else await run('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', absolute]);
    return;
  }
  if (process.platform === 'win32') {
    const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:ORBIT_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')";
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { ORBIT_TRASH_PATH: absolute });
    return;
  }
  await run('gio', ['trash', '--', absolute]);
}

/** The system's open dialog, starting in `folder`: the absolute paths chosen, none when cancelled or when there is no dialog to show. */
export async function chooseFiles(folder: string | undefined): Promise<string[]> {
  const start = folder ?? homedir();
  try {
    if (process.platform === 'darwin') {
      const script = [
        'on run argv',
        'activate',
        'set chosen to choose file with prompt "Attach files to the prompt" default location (POSIX file (item 1 of argv)) with multiple selections allowed',
        'set out to ""',
        'repeat with f in chosen',
        'set out to out & POSIX path of f & linefeed',
        'end repeat',
        'return out',
        'end run',
      ];
      return lines(await run('osascript', [...script.flatMap((line) => ['-e', line]), start]));
    }
    if (process.platform === 'win32') {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Attach files to the prompt'; $d.Multiselect = $true; $d.InitialDirectory = $env:ORBIT_DIALOG_FOLDER; if ($d.ShowDialog() -eq 'OK') { $d.FileNames -join \"`n\" }";
      return lines(await run('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { ORBIT_DIALOG_FOLDER: start }));
    }
    try {
      return lines(await run('zenity', ['--file-selection', '--multiple', '--separator=\n', '--title=Attach files to the prompt', `--filename=${start}/`]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return [];
      return lines(await run('kdialog', ['--getopenfilename', start, '--multiple', '--separate-output']));
    }
  } catch {
    return [];
  }
}
