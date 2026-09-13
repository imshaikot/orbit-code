import type { PermissionPrompt } from '@orbit-code/core/controller';
import type { PermissionAnswer } from '@orbit-code/protocol';
import { Notification } from 'electron';

/** Shown notifications, held until they close: one collected early would drop its click and action handlers. */
const shown = new Set<Notification>();

/**
 * A permission request or questions while the window is out of sight, as a system notification. On macOS the
 * notification's buttons answer a permission request (Allow, the request's "don't ask again" choice, Deny) or skip
 * questions; everywhere, a click brings the window forward, where the card is.
 */
export function notifyPermission({ request, answer }: PermissionPrompt, folderName: string, reveal: () => void): void {
  if (!Notification.isSupported()) return;
  const buttons = process.platform === 'darwin';
  let notification: Notification;
  let answers: PermissionAnswer[];
  if (request.questions) {
    const asked = request.questions.length === 1 ? request.questions[0].question : `${request.questions.length} questions`;
    answers = ['deny'];
    notification = new Notification({ title: `Claude asks: ${asked}`, body: `In ${folderName}. Open Orbit Code to answer.`, actions: buttons ? [{ type: 'button', text: 'Skip' }] : [] });
  } else {
    const labels = request.always ? ['Allow', request.always, 'Deny'] : ['Allow', 'Deny'];
    answers = request.always ? ['allow', 'always', 'deny'] : ['allow', 'deny'];
    notification = new Notification({
      title: `Claude wants to use ${request.tool}`,
      body: `${request.detail}\nIn ${folderName}.`,
      actions: buttons ? labels.map((text) => ({ type: 'button' as const, text })) : [],
    });
  }
  notification.on('click', reveal);
  notification.on('action', (_event, index) => {
    const chosen = answers[index];
    if (chosen) answer(chosen);
  });
  notification.on('close', () => shown.delete(notification));
  shown.add(notification);
  notification.show();
}
