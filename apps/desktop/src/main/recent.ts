import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_RECENT = 10;

interface Stored {
  /** Most recent first. */
  recent: string[];
  /** The folders open when the app last quit, reopened at the next launch. */
  open: string[];
}

/** Folders opened before, kept in the app's user data. */
export class RecentFolders {
  private readonly stored: Stored;

  constructor(private readonly path: string) {
    this.stored = load(path);
  }

  get recent(): readonly string[] {
    return this.stored.recent;
  }

  get lastOpen(): readonly string[] {
    return this.stored.open;
  }

  opened(folder: string): void {
    this.stored.recent = [folder, ...this.stored.recent.filter((known) => known !== folder)].slice(0, MAX_RECENT);
    this.save();
  }

  forget(folder: string): void {
    this.stored.recent = this.stored.recent.filter((known) => known !== folder);
    this.save();
  }

  clear(): void {
    this.stored.recent = [];
    this.save();
  }

  setOpen(folders: readonly string[]): void {
    this.stored.open = [...folders];
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(this.stored, null, 2)}\n`);
    } catch {
      // losing the list is not worth failing over
    }
  }
}

function load(path: string): Stored {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Record<string, unknown>>;
    return { recent: strings(raw.recent), open: strings(raw.open) };
  } catch {
    return { recent: [], open: [] };
  }
}
