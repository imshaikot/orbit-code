import type { SessionState } from '@orbit-code/protocol';

/** The running conversations in a line, for a host's status bar, tray or dock while Orbit is out of sight. */
export interface SessionsSummary {
  /** Conversations with a turn working or stopping. */
  running: number;
  /** Of those, how many wait for a permission or a question to be answered. */
  waiting: number;
  text: string;
  tooltip: string;
}

/** Undefined while no turn runs. */
export function summarizeSessions(states: readonly SessionState[]): SessionsSummary | undefined {
  const running = states.filter((state) => state.phase === 'working' || state.phase === 'stopping');
  if (running.length === 0) return undefined;
  const waiting = running.filter((state) => state.permission);
  if (waiting.length > 0) {
    return {
      running: running.length,
      waiting: waiting.length,
      text: waiting.length === 1 ? 'Claude needs approval' : `${waiting.length} Claude sessions need approval`,
      tooltip: `Claude wants to use ${waiting[0].permission?.tool}. Open Orbit Code to decide.`,
    };
  }
  const text = running.length === 1 ? (running[0].phase === 'stopping' ? 'Claude stopping' : 'Claude working') : `${running.length} Claude sessions working`;
  return { running: running.length, waiting: 0, text, tooltip: 'Open Orbit Code' };
}
