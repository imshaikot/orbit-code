import type { AgentLine, AgentLog } from './agentLogs';
import { button, el } from './dom';

export interface SparkPopupActions {
  /** Follow was on: turn it off. Off: turn it on, framing the star at a fair distance and panning to keep pace with it. Returns whether the star is followed now. */
  toggleFollow(): boolean;
  /** The popup closed, by Esc, an outside click, or choosing the toggle. */
  closed(): void;
}

/** How a subagent's run reads, by how its call returned. */
const STATUS = { running: 'running', done: 'done', failed: 'failed', interrupted: 'stopped' } as const;
/** Within this many pixels of its end, the log keeps to the newest line as lines come. */
const STICK_TO_END_PX = 24;

/**
 * The popup a click on one of Claude's stars opens, with one toggle: "Follow Spark" while the star isn't followed,
 * "Stop Following" while it is. For a conversation's star it closes itself once chosen; clicking the star again reopens
 * it with the current state, which is how Follow is turned back off. For a subagent's star it also shows what the
 * subagent was asked and, as it comes, what it has done and written; that one stays open after the toggle, and after the
 * star has gone, until Esc or a click elsewhere.
 */
export class SparkPopup {
  private readonly root = el('section', 'spark-popup');
  private readonly title = el('span', 'spark-popup-title');
  private readonly status = el('span', 'spark-popup-status');
  private readonly detail = el('p', 'spark-popup-detail');
  private readonly log = el('div', 'spark-popup-log');
  private readonly toggle = button('Follow Spark', 'button primary spark-popup-toggle');
  private open_ = false;
  /** The subagent's log on show, when the star is a subagent's. */
  private shown: AgentLog | undefined;

  constructor(
    host: HTMLElement,
    private readonly actions: SparkPopupActions,
  ) {
    this.root.hidden = true;
    this.root.dataset.kind = 'claude';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Claude');
    this.root.tabIndex = -1;
    const head = el('header', 'spark-popup-head');
    head.append(this.title, this.status);
    this.log.setAttribute('role', 'log');
    this.root.append(head, this.detail, this.log, this.toggle);
    host.append(this.root);

    this.toggle.addEventListener('click', () => {
      const following = this.actions.toggleFollow();
      // A subagent's output stays up to be read; a conversation's star's popup has done its job.
      if (this.shown) this.setFollowing(following);
      else this.close();
    });

    // Esc closes the popup before anything else sees it, like the file menu's.
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || !this.open_) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
      },
      true,
    );
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (this.open_ && !this.root.contains(event.target as Node)) this.close();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Opens with the toggle reading `following`'s state, and for a subagent's star what its `log` holds; `place()` positions it beside the star. */
  open(following: boolean, log?: AgentLog): void {
    this.setFollowing(following);
    this.toggle.hidden = false;
    this.shown = undefined;
    this.root.dataset.kind = log ? 'agent' : 'claude';
    this.root.setAttribute('aria-label', log ? `Subagent ${log.name}` : 'Claude');
    if (log) this.showLog(log);
    this.root.hidden = false;
    this.open_ = true;
    this.root.dataset.offscreen = 'false';
    this.log.scrollTop = this.log.scrollHeight;
    this.root.focus({ preventScroll: true });
  }

  /** Shows a subagent's log as it stands, keeping to the newest line unless the reader has scrolled back. */
  showLog(log: AgentLog): void {
    const stuck = this.shown !== log || this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < STICK_TO_END_PX;
    this.shown = log;
    const status = log.outcome ?? 'running';
    this.root.dataset.status = status;
    this.title.textContent = log.name;
    this.status.textContent = STATUS[status];
    this.detail.textContent = log.detail;
    this.detail.hidden = log.detail === '';
    this.log.replaceChildren(...(log.lines.length > 0 ? log.lines.map(renderLine) : [el('p', 'spl-empty', 'Nothing yet.')]));
    if (stuck) this.log.scrollTop = this.log.scrollHeight;
  }

  /** The subagent's star has gone: its output stays where it is, with nothing left to follow. */
  starGone(): void {
    this.toggle.hidden = true;
    this.root.dataset.offscreen = 'false';
  }

  /** Relabels the toggle for the current Follow state, while open. */
  setFollowing(following: boolean): void {
    this.toggle.textContent = following ? 'Stop Following' : 'Follow Spark';
  }

  /** Keeps the popup beside the star, above it or below it when there is no room above: (x, y) in client pixels, or off screen (the star left the view). */
  place(x: number, y: number, onScreen: boolean): void {
    if (this.root.hidden) return;
    this.root.dataset.offscreen = String(!onScreen);
    if (!onScreen) return;
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const left = Math.min(Math.max(8, x - width / 2), window.innerWidth - width - 8);
    const above = y - height - 16;
    const top = Math.min(Math.max(8, above >= 8 ? above : y + 16), window.innerHeight - height - 8);
    this.root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.open_ = false;
    this.shown = undefined;
    this.actions.closed();
  }
}

/** A line of a subagent's output, the way a terminal shows it: a tool and what it was given, text as written, a failure in its colour. */
function renderLine(line: AgentLine): HTMLElement {
  const row = el('div', 'spl-line');
  row.dataset.kind = line.kind;
  if (line.kind === 'tool') {
    const detail = line.mcp ? (line.detail ? `${line.mcp.tool} · ${line.detail}` : line.mcp.tool) : line.detail;
    const action = line.mcp ? 'mcp' : line.action;
    if (action) row.dataset.action = action;
    const text = el('span', 'spl-detail', detail);
    text.title = detail;
    row.append(el('span', 'spl-tool', line.mcp ? line.mcp.server : line.tool), text);
  } else {
    if (line.kind === 'notice') row.dataset.level = line.level;
    row.textContent = line.text;
  }
  return row;
}
