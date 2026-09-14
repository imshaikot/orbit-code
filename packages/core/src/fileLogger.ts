import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '@orbit-code/common/log';

/** Past this size at launch, the log moves to `<name>.1` and a new one starts. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Orbit's log as a file, with the lines VS Code's Orbit.log holds (the smoke tests grep the same ones), also written to
 * stderr when `echo` is on, so `yarn desktop` shows them; the server echoes them only with `--verbose`.
 */
export class FileLogger implements Logger {
  constructor(
    readonly path: string,
    private readonly echo = true,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // no log yet
    }
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(error: string | Error): void {
    this.write('error', error instanceof Error ? (error.stack ?? error.message) : error);
  }

  private write(level: 'info' | 'warn' | 'error', message: string): void {
    const line = `${timestamp(new Date())} [${level}] ${message}\n`;
    if (this.echo) process.stderr.write(line);
    try {
      appendFileSync(this.path, line);
    } catch {
      // a full or read-only disk loses the line, not the app
    }
  }
}

/** As VS Code's log channels write it: `2026-09-13 01:40:10.133`. */
function timestamp(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
