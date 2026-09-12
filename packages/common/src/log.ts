/**
 * Where Orbit's services write their log lines. vscode.LogOutputChannel satisfies it as is; another host passes its
 * own (a console, a log file). The smoke test greps some of these lines, so keep their wording.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(error: string | Error): void;
}
