import { summarizeSessions } from '@orbit-code/agent/sessionSummary';
import type { SessionService } from '@orbit-code/agent/sessionService';
import type { SessionsSnapshot } from '@orbit-code/protocol';
import * as vscode from 'vscode';

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
    const summary = summarizeSessions(states);
    if (!summary) {
      this.item.hide();
      return;
    }
    this.item.text = `${summary.waiting > 0 ? '$(warning)' : '$(loading~spin)'} ${summary.text}`;
    this.item.tooltip = summary.tooltip;
    this.item.show();
  }
}
