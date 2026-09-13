// Orbit Code's desktop app: Electron's main process. One window per open folder, each running the engine the VS Code
// extension runs (see workspace.ts), plus the native parts: the menu, the tray and dock count, notifications for
// permission requests, recent folders and folder trust.
//
//   yarn desktop [--folder <path>] [--reindex] [--disable-workspace-trust]
//
// Environment: ORBIT_DESKTOP_FOLDER (a folder to open), ORBIT_REINDEX=1, ORBIT_DESKTOP_USER_DATA (where settings, graphs
// and logs live), ORBIT_DESKTOP_LOG (the log file), ORBIT_DESKTOP_SOFTWARE_GL=1 (WebGL without a GPU, for CI).

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, dialog, shell } from 'electron';
import { FileLogger } from './logger';
import { registerScheme, servePage } from './page';
import { RecentFolders } from './recent';
import { SettingsFile } from './settings';
import { adoptLoginShellPath } from './shellPath';
import { SessionTray } from './tray';
import { TrustedFolders } from './trust';
import { OrbitWindow } from './window';
import { Workspace } from './workspace';

/** main.js's own directory: the bundles sit beside it, media/ one up. */
const dist = __dirname;
const media = join(__dirname, '..', 'media');
/** A worker thread can't start from inside the asar; electron-builder unpacks the indexer next to it. */
const indexerPath = join(dist, 'indexer.mjs').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');

interface Launch {
  folder: string | undefined;
  reindex: boolean;
  trustAll: boolean;
}

if (process.env.ORBIT_DESKTOP_USER_DATA) app.setPath('userData', resolve(process.env.ORBIT_DESKTOP_USER_DATA));
else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Orbit Code Dev'));
if (process.env.ORBIT_DESKTOP_SOFTWARE_GL === '1') app.commandLine.appendSwitch('enable-unsafe-swiftshader');
registerScheme();

const launch = parseLaunch(process.argv, process.cwd());
const windows = new Map<OrbitWindow, Workspace | undefined>();
let log: FileLogger;
let settings: SettingsFile;
let recent: RecentFolders;
let trust: TrustedFolders;
let tray: SessionTray | undefined;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (!app.isReady()) return;
    const next = parseLaunch(argv, workingDirectory);
    if (next.folder) openFolder(next.folder, next.reindex);
    else [...windows.keys()][0]?.reveal();
  });
  void app.whenReady().then(start);
}

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  log = new FileLogger(process.env.ORBIT_DESKTOP_LOG ? resolve(process.env.ORBIT_DESKTOP_LOG) : join(userData, 'logs', 'orbit.log'));
  log.info(`Orbit Code ${app.getVersion()}: Electron ${process.versions.electron}, Node ${process.versions.node}, user data ${userData}`);
  await adoptLoginShellPath(log);
  servePage(dist);
  settings = new SettingsFile(join(userData, 'settings.json'), log);
  recent = new RecentFolders(join(userData, 'recent.json'));
  trust = new TrustedFolders(join(userData, 'trust.json'), launch.trustAll);
  settings.onChanged(({ previous, next }) => {
    for (const workspace of workspaces()) workspace.settingsChanged(previous, next);
  });
  try {
    tray = new SessionTray(join(media, process.platform === 'darwin' ? 'trayTemplate.png' : 'icon.png'), trayEntries, {
      openFolder: () => void chooseFolder(),
      stopAll: () => {
        for (const workspace of workspaces()) workspace.session.interrupt();
      },
      quit: () => app.quit(),
    });
  } catch (error) {
    log.warn(`tray: ${error instanceof Error ? error.message : String(error)}`);
  }
  buildMenu();

  app.on('activate', () => {
    if (windows.size === 0) openWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
    recent.setOpen(openFolders());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => {
    tray?.dispose();
    settings.dispose();
  });

  const folders = launch.folder ? [launch.folder] : recent.lastOpen.filter(isDirectory);
  if (folders.length === 0) openWindow();
  for (const folder of folders) openFolder(folder, launch.reindex);
}

/** A window with no folder yet: the page says how to open one. */
function openWindow(): OrbitWindow {
  const window = new OrbitWindow(join(dist, 'preload.js'), 'Orbit Code');
  windows.set(window, undefined);
  window.onReady(() => {
    if (windows.get(window)) return;
    window.post({ type: 'host', capabilities: { tabs: false } });
    window.post({ type: 'status', phase: 'error', message: 'No folder is open. Choose File › Open Folder… to see its graph.' });
  });
  window.onDidDispose(() => {
    const workspace = windows.get(window);
    windows.delete(window);
    workspace?.dispose();
    // Closing the last window quits the app off macOS: keep the folders it had for the next launch.
    const lastBeforeQuit = process.platform !== 'darwin' && windows.size === 0;
    if (!quitting && !lastBeforeQuit) recent.setOpen(openFolders());
    tray?.update();
    buildMenu();
  });
  return window;
}

function openFolder(requested: string, reindex = false): void {
  const path = resolve(requested);
  if (!isDirectory(path)) {
    log.warn(`open: ${path} is not a folder`);
    recent.forget(path);
    buildMenu();
    void dialog.showMessageBox({ type: 'warning', message: 'Orbit Code can only open a folder.', detail: path });
    return;
  }
  const open = workspaces().find((workspace) => workspace.info.path === path);
  if (open) {
    open.window.reveal();
    if (reindex) void open.graphs.load(true);
    return;
  }
  // A window without a folder takes it, the focused one first; otherwise it gets a window of its own.
  const empty = [...windows].filter(([, workspace]) => !workspace).map(([window]) => window);
  const reused = empty.find((window) => window.window.isFocused()) ?? empty[0];
  const window = reused ?? openWindow();
  const workspace = new Workspace({
    path,
    window,
    log,
    settings: () => settings.settings,
    storageRoot: join(app.getPath('userData'), 'workspaces'),
    indexerPath,
    trusted: () => trust.has(path),
    sessionsChanged: () => tray?.update(),
  });
  windows.set(window, workspace);
  log.info(`opened ${path}`);
  recent.opened(path);
  recent.setOpen(openFolders());
  app.addRecentDocument(path);
  // The page already said it was ready to no one: loading it again gets the workspace's snapshot.
  if (reused) window.reload();
  if (reindex) void workspace.graphs.load(true);
  buildMenu();
  tray?.update();
  if (!trust.has(path)) void askTrust(workspace);
}

async function askTrust(workspace: Workspace): Promise<void> {
  const { response } = await dialog.showMessageBox(workspace.window.window, {
    type: 'question',
    message: `Do you trust the authors of the files in ${workspace.info.name}?`,
    detail:
      'Claude Code runs in this folder with the settings, hooks and MCP servers the folder configures. The graph works either way; Claude sessions start once you trust the folder (File › Trust Folder).',
    buttons: ['Trust Folder', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0 && !workspace.window.closed) trustFolder(workspace);
}

function trustFolder(workspace: Workspace): void {
  if (trust.has(workspace.info.path)) return;
  trust.add(workspace.info.path);
  log.info(`trusted ${workspace.info.path}`);
  workspace.trustChanged();
  buildMenu();
}

async function chooseFolder(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow();
  const options = { title: 'Open Folder', buttonLabel: 'Open', properties: ['openDirectory' as const, 'createDirectory' as const] };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const [folder] = result.filePaths;
  if (!result.canceled && folder) openFolder(folder);
}

function buildMenu(): void {
  const mac = process.platform === 'darwin';
  const current = focusedWorkspace();
  const recentItems: MenuItemConstructorOptions[] =
    recent.recent.length === 0
      ? [{ label: 'No Recent Folders', enabled: false }]
      : [
          ...recent.recent.map((folder): MenuItemConstructorOptions => ({ label: folder, click: () => openFolder(folder) })),
          { type: 'separator' },
          {
            label: 'Clear Recent',
            click: () => {
              recent.clear();
              app.clearRecentDocuments();
              buildMenu();
            },
          },
        ];
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => void chooseFolder() },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        {
          label: 'Trust Folder',
          enabled: current !== undefined && !trust.has(current.info.path),
          click: () => {
            const workspace = focusedWorkspace();
            if (workspace) trustFolder(workspace);
          },
        },
        { label: 'Settings…', click: () => void shell.openPath(settings.path) },
        { label: 'Show Log', click: () => shell.showItemInFolder(log.path) },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reindex Workspace', click: () => void focusedWorkspace()?.graphs.load(true) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function focusedWorkspace(): Workspace | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  for (const [window, workspace] of windows) if (window.window === focused) return workspace;
  return undefined;
}

function workspaces(): Workspace[] {
  return [...windows.values()].filter((workspace): workspace is Workspace => workspace !== undefined);
}

function openFolders(): string[] {
  return workspaces().map((workspace) => workspace.info.path);
}

function trayEntries() {
  return workspaces().map((workspace) => ({ name: workspace.info.name, states: () => workspace.states, reveal: () => workspace.window.reveal() }));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `--folder <path>` or `--folder=<path>` (relative to the launch's directory), `--reindex`, `--disable-workspace-trust`; the environment otherwise. */
function parseLaunch(argv: readonly string[], cwd: string): Launch {
  let folder: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--folder' && argv[i + 1] !== undefined) folder = argv[++i];
    else if (arg.startsWith('--folder=')) folder = arg.slice('--folder='.length);
  }
  folder ??= process.env.ORBIT_DESKTOP_FOLDER || undefined;
  return {
    folder: folder ? resolve(cwd, folder) : undefined,
    reindex: argv.includes('--reindex') || process.env.ORBIT_REINDEX === '1',
    trustAll: argv.includes('--disable-workspace-trust'),
  };
}
