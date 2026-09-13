import { type FSWatcher, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { type Disposable, Emitter } from '@orbit-code/common/event';
import type { Logger } from '@orbit-code/common/log';
import { type OrbitSettings, normalizeSettings } from '@orbit-code/core/settings';

/** Editors save in bursts (a temporary file, a rename); one read follows the last event. */
const RELOAD_DEBOUNCE_MS = 200;

export interface SettingsChange {
  previous: OrbitSettings;
  next: OrbitSettings;
}

/**
 * Orbit's settings as a JSON file in the app's user data, with the keys VS Code's `orbit.*` settings have
 * (`maxFiles`, `claude.path`, `claude.model`, …). Never read from an opened folder, so a repository can't choose the
 * executable, its arguments or the permission mode; `bypassPermissions` is accepted only from here.
 */
export class SettingsFile implements Disposable {
  private current: OrbitSettings;
  private readonly changed = new Emitter<SettingsChange>();
  private readonly watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly onChanged = this.changed.event;

  constructor(
    readonly path: string,
    private readonly log: Logger,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(normalizeSettings({}), null, 2)}\n`);
    this.current = this.read() ?? normalizeSettings({});
    try {
      // The directory, not the file: an editor that saves by renaming would leave a file watcher on the old one.
      this.watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
        if (name !== basename(path)) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.reload(), RELOAD_DEBOUNCE_MS);
      });
      this.watcher.on('error', (error) => this.log.warn(`settings: stopped watching ${path}: ${error.message}`));
    } catch (error) {
      this.log.warn(`settings: cannot watch ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get settings(): OrbitSettings {
    return this.current;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.changed.dispose();
  }

  private reload(): void {
    const next = this.read();
    if (!next || JSON.stringify(next) === JSON.stringify(this.current)) return;
    const previous = this.current;
    this.current = next;
    this.log.info(`settings: applied ${this.path}`);
    this.changed.fire({ previous, next });
  }

  /** The file's settings, checked; undefined (and a warning) while it isn't valid JSON, so a half-typed edit changes nothing. */
  private read(): OrbitSettings | undefined {
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (error) {
      this.log.warn(`settings: ${this.path} could not be read (${error instanceof Error ? error.message : String(error)}); keeping the settings in use`);
      return undefined;
    }
  }
}
