import * as vscode from 'vscode';
import type { SessionsSnapshot } from '../shared/protocol';
import type { SessionService } from './session/sessionService';

/** Keeps running turns visible when Orbit is hidden or closed: how many conversations are working, and whether one waits for approval. */
export class SessionStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('orbit.session', vscode.StatusBarAlignment.Left, 50);
  private readonly subscriptions: vscode.Disposable[];

  constructor(session: SessionService) {
    this.item.name = 'Orbit Code: Claude sessions';
    this.item.command = 'orbit.open';
    this.subscriptions = [session.onState(() => this.update(session.sessions)), session.onSessions((sessions) => this.update(sessions))];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.item.dispose();
  }

  private update({ states }: SessionsSnapshot): void {
    const running = states.filter((state) => state.phase === 'working' || state.phase === 'stopping');
    if (running.length === 0) {
      this.item.hide();
      return;
    }
    const waiting = running.filter((state) => state.permission);
    if (waiting.length > 0) {
      const [first] = waiting;
      this.item.text = waiting.length === 1 ? '$(warning) Claude needs approval' : `$(warning) ${waiting.length} Claude sessions need approval`;
      this.item.tooltip = `Claude wants to use ${first.permission?.tool}. Open Orbit Code to decide.`;
    } else if (running.length === 1) {
      this.item.text = running[0].phase === 'stopping' ? '$(loading~spin) Claude stopping' : '$(loading~spin) Claude working';
      this.item.tooltip = 'Open Orbit Code';
    } else {
      this.item.text = `$(loading~spin) ${running.length} Claude sessions working`;
      this.item.tooltip = 'Open Orbit Code';
    }
    this.item.show();
  }
}
