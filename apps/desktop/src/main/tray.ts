import { summarizeSessions } from '@orbit-code/agent/sessionSummary';
import type { Disposable } from '@orbit-code/common/event';
import type { SessionState } from '@orbit-code/protocol';
import { Menu, type MenuItemConstructorOptions, Tray, app, nativeImage } from 'electron';

/** An open folder, as the tray lists it. */
export interface TrayEntry {
  name: string;
  states(): readonly SessionState[];
  reveal(): void;
}

export interface TrayActions {
  openFolder(): void;
  stopAll(): void;
  quit(): void;
}

/**
 * Running turns while Orbit's windows are out of sight, as VS Code's status bar item shows them: the tray icon's
 * tooltip and menu, a count beside the icon and on the dock (macOS) or launcher (Linux). Waiting for approval counts
 * before working.
 */
export class SessionTray implements Disposable {
  private readonly tray: Tray;

  constructor(
    icon: string,
    private readonly entries: () => readonly TrayEntry[],
    private readonly actions: TrayActions,
  ) {
    const image = nativeImage.createFromPath(icon);
    if (process.platform === 'darwin') image.setTemplateImage(true);
    this.tray = new Tray(image);
    this.update();
  }

  update(): void {
    const entries = this.entries();
    const summary = summarizeSessions(entries.flatMap((entry) => entry.states()));
    const count = summary ? summary.waiting || summary.running : 0;
    app.setBadgeCount(count);
    this.tray.setToolTip(summary ? `Orbit Code: ${summary.text}` : 'Orbit Code');
    if (process.platform === 'darwin') this.tray.setTitle(count > 0 ? String(count) : '');
    const template: MenuItemConstructorOptions[] = [
      { label: summary?.text ?? 'No Claude turn running', enabled: false },
      { type: 'separator' },
      ...entries.map((entry): MenuItemConstructorOptions => ({ label: `Show ${entry.name}`, click: () => entry.reveal() })),
      { label: 'Open Folder…', click: () => this.actions.openFolder() },
      { type: 'separator' },
      { label: 'Stop Claude', enabled: summary !== undefined, click: () => this.actions.stopAll() },
      { label: 'Quit Orbit Code', click: () => this.actions.quit() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  dispose(): void {
    app.setBadgeCount(0);
    this.tray.destroy();
  }
}
