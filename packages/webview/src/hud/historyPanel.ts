import type { ConversationSummary, SessionState } from '@orbit-code/protocol';
import { button, el } from './dom';
import { plural, relativeTime } from './turns';

export interface HistoryPanelActions {
  /** The next prompt continues this conversation. */
  resume(id: string): void;
  openFile(path: string): void;
  close(): void;
}

const SHEET_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * An earlier conversation, opened out of its gyroscope in the history constellation: what was asked, the files Claude
 * read and edited, the skills and MCP servers it used, and a button to continue it in Orbit.
 */
export class HistoryPanel {
  private readonly root = el('section', 'history-panel');
  private readonly panel = el('div', 'hp-panel');
  private readonly title = el('h2', 'hp-title');
  private readonly meta = el('p', 'hp-meta');
  private readonly closeButton = button('', 'sv-close hp-close', 'Close (Esc)');
  private readonly body = el('div', 'hp-body');
  private readonly note = el('p', 'hp-note');
  private readonly resumeButton = button('Continue this conversation', 'button primary hp-resume');
  private conversation: ConversationSummary | undefined;
  private state: SessionState | undefined;
  private origin: DOMRect | undefined;
  private motion: Animation | undefined;

  constructor(host: HTMLElement, actions: HistoryPanelActions) {
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Earlier conversation');
    this.closeButton.setAttribute('aria-label', 'Close');
    const heading = el('div', 'hp-titles');
    heading.append(this.title, this.meta);
    const head = el('header', 'hp-head');
    head.append(heading, this.closeButton);
    const footer = el('footer', 'hp-footer');
    footer.append(this.note, this.resumeButton);
    this.panel.append(head, this.body, footer);
    this.root.append(this.panel);
    host.append(this.root);

    this.closeButton.addEventListener('click', () => actions.close());
    this.resumeButton.addEventListener('click', () => {
      if (this.conversation && !this.resumeButton.disabled) actions.resume(this.conversation.id);
    });
    this.body.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest<HTMLElement>('[data-file]');
      if (link?.dataset.file) actions.openFile(link.dataset.file);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Opens out of `origin`, the conversation's glyph. */
  open(conversation: ConversationSummary, origin: DOMRect | undefined): void {
    this.origin = origin;
    this.show(conversation);
    this.root.hidden = false;
    this.body.scrollTop = 0;
    this.motion?.cancel();
    if (!reducedMotion()) {
      const clip = this.clipFrom(origin);
      this.motion = this.panel.animate([{ clipPath: clip.from }, { clipPath: clip.to }], { duration: 500, easing: SHEET_EASE });
      for (const [k, part] of [...this.panel.children].entries()) {
        part.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 120 + k * 45, easing: 'ease-out', fill: 'backwards' });
      }
    }
    (this.resumeButton.disabled ? this.closeButton : this.resumeButton).focus({ preventScroll: true });
  }

  /** Newer data for the conversation on show. */
  update(conversations: readonly ConversationSummary[]): void {
    const fresh = this.conversation && conversations.find((candidate) => candidate.id === this.conversation?.id);
    if (fresh && this.isOpen) this.show(fresh);
  }

  close(): void {
    if (this.root.hidden) return;
    this.motion?.cancel();
    if (reducedMotion()) {
      this.root.hidden = true;
      return;
    }
    const clip = this.clipFrom(this.origin);
    const motion = this.panel.animate([{ clipPath: clip.to, opacity: 1 }, { clipPath: clip.from, opacity: 0.4 }], { duration: 300, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
    this.motion = motion;
    motion.onfinish = () => {
      this.root.hidden = true;
      motion.cancel();
    };
  }

  setState(state: SessionState): void {
    this.state = state;
    this.refreshFooter();
  }

  private show(conversation: ConversationSummary): void {
    this.conversation = conversation;
    this.title.textContent = conversation.title;
    this.meta.textContent = [relativeTime(conversation.updatedAt), plural(conversation.promptCount, 'prompt'), conversation.model, conversation.branch].filter(Boolean).join(' · ');
    this.meta.title = `Started ${new Date(conversation.startedAt).toLocaleString()}, last active ${new Date(conversation.updatedAt).toLocaleString()}`;

    const sections: HTMLElement[] = [];
    const prompts = el('ol', 'hp-prompts');
    for (const prompt of conversation.prompts) prompts.append(el('li', undefined, prompt));
    const more = conversation.promptCount - conversation.prompts.length;
    sections.push(section('What was asked', prompts, more > 0 ? `and ${plural(more, 'more prompt')}` : undefined));

    if (conversation.files.length > 0) {
      const files = el('ul', 'hp-files');
      for (const file of conversation.files) {
        const row = el('li', 'hp-file');
        const link = button(file.id, 't-link hp-file-link', `Open ${file.id}`);
        link.dataset.file = file.id;
        const counts = [file.edits > 0 ? `edited ${file.edits}×` : '', file.reads > 0 ? `read ${file.reads}×` : ''].filter(Boolean).join(', ');
        row.dataset.edited = String(file.edits > 0);
        row.append(link, el('span', 'hp-file-counts', counts));
        files.append(row);
      }
      sections.push(section('Files Claude worked on', files));
    }
    if (conversation.skills.length > 0) sections.push(section('Skills and commands', chips(conversation.skills.map((skill) => `/${skill}`), 'hp-chip')));
    if (conversation.mcpServers.length > 0) sections.push(section('MCP servers', chips(conversation.mcpServers, 'hp-chip hp-chip-mcp')));
    this.body.replaceChildren(...sections);
    this.refreshFooter();
  }

  private refreshFooter(): void {
    const conversation = this.conversation;
    if (!conversation) return;
    const phase = this.state?.phase ?? 'unavailable';
    const current = conversation.id === this.state?.sessionId;
    const busy = phase === 'working' || phase === 'stopping';
    this.root.dataset.current = String(current);
    this.resumeButton.disabled = current || busy || phase === 'unavailable';
    this.resumeButton.textContent = current ? 'In Orbit now' : 'Continue this conversation';
    this.note.textContent = current
      ? 'This is the conversation Orbit continues. Reply from the drawer.'
      : busy
        ? 'Claude is on a prompt; you can continue this one when it finishes.'
        : phase === 'unavailable'
          ? (this.state?.error ?? 'Claude Code is not available.')
          : 'The next prompt picks it up where it left off, with everything Claude knew then.';
  }

  private clipFrom(origin: DOMRect | undefined): { from: string; to: string } {
    const box = this.panel.getBoundingClientRect();
    const cx = origin ? origin.left + origin.width / 2 - box.left : box.width / 2;
    const cy = origin ? origin.top + origin.height / 2 - box.top : box.height;
    const radius = Math.hypot(Math.max(Math.abs(cx), Math.abs(box.width - cx)), Math.max(Math.abs(cy), Math.abs(box.height - cy))) + 8;
    return { from: `circle(20px at ${cx}px ${cy}px)`, to: `circle(${radius}px at ${cx}px ${cy}px)` };
  }
}

function section(title: string, content: HTMLElement, note?: string): HTMLElement {
  const part = el('section', 'hp-section');
  part.append(el('h3', 'hp-heading', title), content);
  if (note) part.append(el('p', 'hp-more', note));
  return part;
}

function chips(values: readonly string[], className: string): HTMLElement {
  const list = el('p', 'hp-chips');
  for (const value of values) list.append(el('span', className, value));
  return list;
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
