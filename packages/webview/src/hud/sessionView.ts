import type { AgentCatalog, PermissionAnswer, Question, SessionOptions, SessionState, TranscriptEntry } from '@orbit-code/protocol';
import { isWorkspaceId } from '@orbit-code/protocol/workspacePath';
import { Composer, type ComposerHost } from './composer';
import type { ConstellationMode } from './constellation';
import { button, el } from './dom';
import { renderMarkdown } from './markdown';
import { type Turn, activityOf, clock, dollars, fileName, outcomeLine, promptLine, seconds, toolLabel } from './turns';

export interface SessionViewActions {
  /** A follow-up from the view's own composer, continuing the conversation `key` with the skills and files attached to it; false if it could not be sent. */
  prompt(text: string, key: string, skills: readonly string[], files: readonly string[]): boolean;
  interrupt(key: string): void;
  /** `answers`: for a request asking questions, the answer to each, by question text. */
  answerPermission(key: string, id: string, answer: PermissionAnswer, answers?: Record<string, string>): void;
  openFile(path: string): void;
  close(): void;
  setOptions(options: Partial<SessionOptions>): void;
  /** The composer's Files button: the host's open dialog picks files to attach. */
  pickFiles(): void;
  /** The composer's Skills toggle: the skills panel opens over the view, or closes. */
  toggleSkills(from: DOMRect): void;
  /** A slash command being typed in the composer: `query` is the text after the slash, undefined once it is not. */
  slash(query: string | undefined, from: DOMRect): void;
  /** A key pressed while a slash command is being typed; true if the skills panel took it. */
  slashKey(key: string): boolean;
  /** The skills attached to the reply changed. */
  skillsChanged(names: readonly string[]): void;
}

/** What is picked on the question card for one question: option labels, and text of the user's own. */
interface Pick {
  labels: Set<string>;
  other: string;
}

/** One conversation's transcript, kept rendered whether or not it is the one on show. */
interface Pane {
  readonly root: HTMLElement;
  group: HTMLElement | undefined;
  entries: number;
}

const MAX_ENTRIES = 400;
const STICK_TO_BOTTOM_PX = 32;
const MAX_INPUT_PX = 140;
const SHEET_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * A session opened out of its bubble: what it asked, Claude's replies as Markdown, every tool call, the
 * permission card, and a composer to reply with, carrying skills, files, the model, effort and permission mode
 * like the drawer's. While Claude works, Stop takes Send's place and the reply can be written and attached to
 * ahead; it goes once the turn ends. The transcript is the whole conversation the session belongs to (a reply
 * continues it); the header follows the session that was opened. Every conversation's transcript is kept, and
 * the view shows one at a time.
 */
export class SessionView implements ComposerHost {
  private readonly root = el('section', 'session-view');
  private readonly panel = el('div', 'sv-panel');
  private readonly title = el('h2', 'sv-title');
  private readonly verb = el('span', 'sv-verb');
  private readonly path = el('span', 'sv-path');
  private readonly time = el('span', 'sv-time');
  private readonly meta = el('span', 'sv-meta');
  private readonly closeButton = button('', 'sv-close', 'Close (Esc)');
  private readonly transcript = el('div', 'transcript');
  private readonly permission = el('div', 'permission');
  private readonly permissionTitle = el('p', 'permission-title');
  private readonly permissionDetail = el('p', 'permission-detail');
  private readonly allow = button('Allow', 'button primary');
  /** The agent's "don't ask again" choice, labelled by the request; hidden when it offers none. */
  private readonly always = button('', 'button permission-always');
  private readonly deny = button('Deny', 'button');
  /** Claude's questions (AskUserQuestion), shown in place of the permission card: options to pick, or an answer of the user's own. */
  private readonly question = el('div', 'question');
  private readonly questionList = el('div', 'question-list');
  private readonly skip = button('Skip', 'button', 'Let Claude go on without an answer');
  private readonly submitAnswers = button('Answer', 'button primary');
  /** The request the question card shows, and what is picked for each of its questions. */
  private asked: { id: string; questions: readonly Question[]; picks: Map<string, Pick> } | undefined;
  /** The reply to the conversation on show. */
  private readonly composer: Composer;
  /** Shown only once a turn has failed (an API error, or the process lost to the machine sleeping): resumes the same conversation without retyping anything. */
  private readonly continueButton = button('Continue', 'button primary sv-continue', 'Continue this conversation');
  /** Where the skills panel opens from the composer, standing on it over the transcript. */
  readonly overlay = el('div', 'sv-overlay');
  private readonly panes = new Map<string, Pane>();
  /** The latest state of each conversation, by key. */
  private readonly states = new Map<string, SessionState>();
  /** The conversation on show. */
  private shown: string | undefined;
  private turn: Turn | undefined;
  private state: SessionState | undefined;
  private answered: string | undefined;
  private motion: Animation | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(
    host: HTMLElement,
    private readonly actions: SessionViewActions,
  ) {
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Claude session');
    this.closeButton.setAttribute('aria-label', 'Close');

    const head = el('header', 'sv-head');
    const status = el('p', 'sv-status');
    status.append(this.verb, this.path, this.meta, this.time);
    const heading = el('div', 'sv-heading');
    heading.append(this.title, status);
    head.append(heading, this.closeButton);

    this.transcript.setAttribute('aria-live', 'polite');

    this.permission.hidden = true;
    this.permission.setAttribute('role', 'alertdialog');
    const decisions = el('div', 'permission-actions');
    decisions.append(this.deny, this.always, this.allow);
    this.permission.append(this.permissionTitle, this.permissionDetail, decisions);

    this.question.hidden = true;
    this.question.setAttribute('role', 'alertdialog');
    this.question.setAttribute('aria-label', 'Claude asks');
    const replies = el('div', 'question-actions');
    replies.append(this.skip, this.submitAnswers);
    this.question.append(el('p', 'question-title', 'Claude asks'), this.questionList, replies);

    this.composer = new Composer(
      {
        send: (text, _from, skills, files) => this.send(text, skills, files),
        sent: () => {
          this.transcript.scrollTop = this.transcript.scrollHeight;
        },
        stop: () => {
          if (this.shown !== undefined) actions.interrupt(this.shown);
        },
        setOptions: (options) => actions.setOptions(options),
        toggleSkills: (from) => actions.toggleSkills(from),
        pickFiles: () => actions.pickFiles(),
        slash: (query, from) => actions.slash(query, from),
        slashKey: (key) => actions.slashKey(key),
        skillsChanged: (names) => actions.skillsChanged(names),
      },
      { placeholder: 'Reply to continue the conversation… or type / for a skill', label: 'Reply', maxInputPx: MAX_INPUT_PX },
    );
    const footer = this.composer.element;
    footer.classList.add('sv-footer');
    this.composer.addAction(this.continueButton);

    this.panel.append(head, this.transcript, this.permission, this.question, footer);
    this.root.append(this.panel, this.overlay);
    host.append(this.root);
    // The skills panel stands on the composer, over the transcript between it and the header, however tall chips or the title make them.
    const measure = new ResizeObserver(() => {
      this.root.style.setProperty('--sv-footer-height', `${footer.offsetHeight}px`);
      this.root.style.setProperty('--sv-room', `${this.panel.offsetHeight - head.offsetHeight - footer.offsetHeight}px`);
    });
    measure.observe(head);
    measure.observe(footer);
    measure.observe(this.panel);

    this.closeButton.addEventListener('click', () => actions.close());
    this.transcript.append(el('div', 't-pane'));
    this.continueButton.addEventListener('click', () => this.continueTurn());
    this.allow.addEventListener('click', () => this.answer('allow'));
    this.always.addEventListener('click', () => this.answer('always'));
    this.deny.addEventListener('click', () => this.answer('deny'));
    this.skip.addEventListener('click', () => this.answer('deny'));
    this.submitAnswers.addEventListener('click', () => this.answer('allow'));
    this.transcript.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest<HTMLElement>('[data-file]');
      if (link?.dataset.file) actions.openFile(link.dataset.file);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** The conversation on show, if open. */
  get key(): string | undefined {
    return this.isOpen ? this.shown : undefined;
  }

  /** Skills attached to the reply. */
  get skills(): readonly string[] {
    return this.composer.skills;
  }

  get slashQuery(): string | undefined {
    return this.composer.slashQuery;
  }

  /** Opens out of `origin` (the bubble), over the session `turn` of the conversation `key`; without a turn, over the whole conversation. */
  open(turn: Turn | undefined, origin: DOMRect | undefined, key: string): void {
    this.show(key);
    this.turn = turn;
    this.root.hidden = false;
    this.renderHead();
    this.refreshFooter();
    this.syncTicker();
    this.transcript.scrollTop = this.transcript.scrollHeight;
    this.motion?.cancel();
    if (!reducedMotion()) {
      const clip = this.clipFrom(origin);
      this.motion = this.panel.animate([{ clipPath: clip.from }, { clipPath: clip.to }], { duration: 480, easing: SHEET_EASE });
      for (const [k, part] of [...this.panel.children].entries()) {
        part.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 110 + k * 35, easing: 'ease-out', fill: 'backwards' });
      }
    }
    if (!this.composer.focus()) this.closeButton.focus({ preventScroll: true });
  }

  /** Collapses back into `origin`. */
  close(origin: DOMRect | undefined): void {
    if (this.root.hidden) return;
    this.motion?.cancel();
    this.syncTicker(false);
    if (reducedMotion()) {
      this.root.hidden = true;
      return;
    }
    const clip = this.clipFrom(origin);
    const motion = this.panel.animate([{ clipPath: clip.to }, { clipPath: clip.from }], { duration: 300, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
    this.motion = motion;
    motion.onfinish = () => {
      this.root.hidden = true;
      motion.cancel();
    };
  }

  /** The header follows another session (a reply sent from the view starts one). */
  follow(turn: Turn | undefined): void {
    this.turn = turn;
    this.renderHead();
    this.syncTicker();
  }

  /** The followed session's activity changed. */
  refresh(): void {
    if (!this.isOpen) return;
    this.renderHead();
    // The transcript's `turn` entry (which the header and Continue read from `this.turn.end`) can arrive after the
    // state message that dropped the phase back to idle, so the footer needs its own refresh once it does.
    this.refreshFooter();
  }

  /** One conversation's state; only the one on show changes what is drawn. */
  setState(state: SessionState): void {
    this.states.set(state.key, state);
    if (state.key !== this.shown) return;
    this.state = state;
    const request = state.permission;
    const questions = request?.questions;
    this.permission.hidden = !request || questions !== undefined;
    this.question.hidden = questions === undefined;
    if (request && questions) {
      if (this.asked?.id !== request.id) this.renderQuestions(request.id, questions);
      this.skip.disabled = this.answered === request.id;
      this.refreshAnswers();
    } else if (request) {
      this.permissionTitle.replaceChildren('Allow Claude to use ', el('b', undefined, toolLabel(request.tool)), '?');
      this.permissionDetail.textContent = request.detail;
      this.always.hidden = !request.always;
      this.always.textContent = request.always ?? '';
      this.allow.disabled = this.always.disabled = this.deny.disabled = this.answered === request.id;
    } else {
      this.answered = undefined;
      this.asked = undefined;
    }
    this.composer.setState(state);
    this.refreshFooter();
    this.renderHead();
    this.syncTicker();
  }

  /** Models from Claude Code itself, for the composer. */
  setCatalog(catalog: AgentCatalog): void {
    this.composer.setCatalog(catalog);
  }

  /** Attaches a skill to the reply. */
  attach(name: string): void {
    this.composer.attach(name);
    if (this.isOpen) this.composer.focus();
  }

  /** Attaches files to the reply as context. */
  attachFiles(paths: readonly string[]): void {
    this.composer.attachFiles(paths);
    if (this.isOpen) this.composer.focus();
  }

  /** Where a dragged skill is dropped: anywhere on the composer, while the view is open. */
  dropRect(): DOMRect | undefined {
    return this.isOpen ? this.composer.dropRect() : undefined;
  }

  setDropState(state: 'ready' | 'over' | undefined): void {
    this.composer.setDropState(state);
  }

  /** The composer has only the Skills toggle. */
  setToggled(kind: ConstellationMode | undefined): void {
    this.composer.setSkillsPressed(kind === 'skills');
  }

  /** The transcript of the conversation `key` grew, or starts over. */
  appendTranscript(key: string, reset: boolean, entries: readonly TranscriptEntry[]): void {
    const pane = this.pane(key);
    const list = this.transcript;
    const onShow = key === this.shown;
    const atBottom = onShow && list.scrollHeight - list.scrollTop - list.clientHeight < STICK_TO_BOTTOM_PX;
    if (reset) {
      pane.root.replaceChildren();
      pane.group = undefined;
      pane.entries = 0;
    }
    for (const entry of entries) {
      if (entry.kind === 'prompt' || !pane.group) {
        pane.group = el('article', 't-group');
        pane.root.append(pane.group);
      }
      pane.group.append(renderEntry(entry));
      pane.entries++;
    }
    while (pane.entries > MAX_ENTRIES) {
      const first = pane.root.firstElementChild;
      if (!first) break;
      const oldest = first.firstElementChild;
      if (oldest) {
        oldest.remove();
        pane.entries--;
      }
      if (!first.firstElementChild) first.remove();
    }
    if (onShow && (reset || atBottom)) list.scrollTop = list.scrollHeight;
  }

  /** The conversation the drawer continues: its transcript is the one in the box while the view is closed, ready for View conversation. */
  setCurrent(key: string): void {
    if (!this.isOpen) this.show(key);
  }

  /** The conversation `key` is gone, its transcript with it. */
  forget(key: string): void {
    this.states.delete(key);
    const pane = this.panes.get(key);
    this.panes.delete(key);
    if (this.shown === key) {
      this.shown = undefined;
      this.state = undefined;
      this.transcript.replaceChildren(el('div', 't-pane'));
      this.composer.setState(undefined);
    } else {
      pane?.root.remove();
    }
  }

  private pane(key: string): Pane {
    let pane = this.panes.get(key);
    if (!pane) {
      pane = { root: el('div', 't-pane'), group: undefined, entries: 0 };
      this.panes.set(key, pane);
    }
    return pane;
  }

  /** Puts the conversation `key`'s transcript in the scroll box and takes its state. */
  private show(key: string): void {
    if (key !== this.shown) {
      this.shown = key;
      this.transcript.replaceChildren(this.pane(key).root);
    }
    const state = this.states.get(key);
    this.state = state;
    this.answered = undefined;
    if (state) this.setState(state);
    else {
      this.permission.hidden = this.question.hidden = true;
      this.composer.setState(undefined);
    }
  }

  /** The composer's reply goes to the conversation on show, once that is idle. */
  private send(text: string, skills: readonly string[], files: readonly string[]): boolean {
    const key = this.shown;
    return key !== undefined && this.state?.phase === 'idle' && this.actions.prompt(text, key, skills, files);
  }

  /** Resumes the conversation after a failed turn, without needing anything typed: `prompt()` already restarts the agent process with `--resume`. */
  private continueTurn(): void {
    const key = this.shown;
    if (key === undefined || this.state?.phase !== 'idle') return;
    this.actions.prompt('Continue', key, [], []);
  }

  private answer(answer: PermissionAnswer): void {
    const request = this.state?.permission;
    if (!request || this.answered === request.id || this.shown === undefined) return;
    const answers = request.questions && answer !== 'deny' ? this.collectAnswers() : undefined;
    if (request.questions && answer !== 'deny' && !answers) return;
    this.answered = request.id;
    this.allow.disabled = this.always.disabled = this.deny.disabled = this.skip.disabled = this.submitAnswers.disabled = true;
    this.actions.answerPermission(this.shown, request.id, answer, answers);
  }

  /** A fieldset per question: its header and text, an option button each (radio, or checkbox for a multi-select question), and a field for an answer of the user's own. */
  private renderQuestions(id: string, questions: readonly Question[]): void {
    const picks = new Map<string, Pick>(questions.map((q) => [q.question, { labels: new Set<string>(), other: '' }]));
    this.asked = { id, questions, picks };
    this.questionList.replaceChildren(
      ...questions.map((q) => {
        const pick = picks.get(q.question) as Pick;
        const item = el('fieldset', 'q-item');
        const legend = el('legend', 'q-legend');
        if (q.header) legend.append(el('span', 'q-header', q.header));
        legend.append(el('span', 'q-text', q.question));

        const other = el('input', 'q-other');
        other.type = 'text';
        other.placeholder = q.options.length > 0 ? 'Something else…' : 'Your answer…';
        other.setAttribute('aria-label', `Your own answer to: ${q.question}`);
        const choices = el('div', 'q-options');
        choices.setAttribute('role', q.multiSelect ? 'group' : 'radiogroup');
        const sync = () => {
          for (const option of choices.children) option.setAttribute('aria-checked', String(pick.labels.has((option as HTMLElement).dataset.label ?? '')));
          this.refreshAnswers();
        };
        for (const option of q.options) {
          const choice = el('button', 'q-option');
          choice.type = 'button';
          choice.dataset.label = option.label;
          choice.setAttribute('role', q.multiSelect ? 'checkbox' : 'radio');
          choice.append(el('span', 'q-option-label', option.label));
          if (option.description) choice.append(el('span', 'q-option-detail', option.description));
          choice.addEventListener('click', () => {
            if (!q.multiSelect) {
              // One answer to a single-choice question: picking an option replaces whatever was typed.
              pick.labels.clear();
              pick.other = other.value = '';
              pick.labels.add(option.label);
            } else if (!pick.labels.delete(option.label)) {
              pick.labels.add(option.label);
            }
            sync();
          });
          choices.append(choice);
        }
        other.addEventListener('input', () => {
          pick.other = other.value;
          if (!q.multiSelect && other.value.trim()) pick.labels.clear();
          sync();
        });
        other.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            this.answer('allow');
          }
        });
        sync();
        if (q.options.length > 0) item.append(legend, choices, other);
        else item.append(legend, other);
        return item;
      }),
    );
  }

  /** The answer to every question on the card, as the host sends them on: picked labels in the order offered, then the user's own text, comma-separated. Undefined while one is unanswered. */
  private collectAnswers(): Record<string, string> | undefined {
    if (!this.asked) return undefined;
    const answers: Record<string, string> = {};
    for (const q of this.asked.questions) {
      const pick = this.asked.picks.get(q.question);
      if (!pick) return undefined;
      const parts = q.options.filter((option) => pick.labels.has(option.label)).map((option) => option.label);
      if (pick.other.trim()) parts.push(pick.other.trim());
      if (parts.length === 0) return undefined;
      answers[q.question] = parts.join(', ');
    }
    return answers;
  }

  private refreshAnswers(): void {
    this.submitAnswers.disabled = !this.asked || this.answered === this.asked.id || !this.collectAnswers();
  }

  private renderHead(): void {
    const state = this.state;
    const turn = this.turn;
    this.root.dataset.phase = turn?.end ? turn.end.outcome : state?.permission ? 'waiting' : (state?.phase ?? 'unavailable');
    this.title.textContent = turn ? promptLine(turn.prompt, turn.skills, turn.files) : 'This conversation';
    this.meta.textContent = state?.model ?? (state?.options.model || '');
    this.path.textContent = this.time.textContent = '';
    if (!state) return;
    if (!turn) {
      this.verb.textContent = state.turns > 0 ? `${state.turns} ${state.turns === 1 ? 'prompt' : 'prompts'}, ${dollars(state.costUsd)}` : 'Nothing asked yet';
    } else if (turn.end) {
      this.verb.textContent = turn.end.costUsd > 0 && turn.end.outcome !== 'failed' ? `${outcomeLine(turn.end)}, ${dollars(turn.end.costUsd)}` : outcomeLine(turn.end);
    } else {
      const activity = activityOf(turn, state);
      this.verb.textContent = activity.verb;
      this.path.textContent = activity.detail ?? '';
      this.time.textContent = clock(Date.now() - turn.startedAt);
    }
  }

  /** Continue after a failed turn, and what the composer's input says; its Send or Stop follows the state by itself. */
  private refreshFooter(): void {
    const phase = this.state?.phase ?? 'unavailable';
    const busy = phase === 'working' || phase === 'stopping';
    const canContinue = phase === 'idle' && this.turn?.end?.outcome === 'failed';
    this.continueButton.hidden = !canContinue;
    this.composer.setPlaceholder(
      busy
        ? 'Write the next prompt now, and send it once Claude finishes'
        : phase === 'unavailable'
          ? (this.state?.error ?? 'Claude Code is not available')
          : canContinue
            ? 'Continue where it left off, or reply with something else…'
            : 'Reply to continue the conversation… or type / for a skill',
    );
  }

  private syncTicker(running = this.isOpen && !!this.turn && !this.turn.end): void {
    if (running && !this.ticker) this.ticker = setInterval(() => this.renderHead(), 1000);
    else if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  /** Circle clips centred on the bubble: its own size, and large enough to uncover the whole panel. */
  private clipFrom(origin: DOMRect | undefined): { from: string; to: string } {
    const box = this.panel.getBoundingClientRect();
    const cx = origin ? origin.left + origin.width / 2 - box.left : 22;
    const cy = origin ? origin.top + origin.height / 2 - box.top : box.height - 22;
    const radius = Math.hypot(Math.max(cx, box.width - cx), Math.max(cy, box.height - cy)) + 8;
    return { from: `circle(22px at ${cx}px ${cy}px)`, to: `circle(${radius}px at ${cx}px ${cy}px)` };
  }
}

function renderEntry(entry: TranscriptEntry): HTMLElement {
  const item = el(entry.kind === 'text' ? 'div' : 'p', `t-entry t-${entry.kind}`);
  switch (entry.kind) {
    case 'prompt':
      for (const skill of entry.skills ?? []) item.append(el('span', 't-skill', `/${skill}`));
      for (const file of entry.files ?? []) {
        // A workspace file opens like any link in the transcript; one from outside the workspace is only named.
        if (isWorkspaceId(file)) {
          const link = button(fileName(file), 't-attached t-link', `Open ${file}`);
          link.dataset.file = file;
          item.append(link);
        } else {
          const name = el('span', 't-attached', fileName(file));
          name.title = file;
          item.append(name);
        }
      }
      item.append(entry.text);
      break;
    case 'text':
      item.append(renderMarkdown(entry.text));
      break;
    case 'tool': {
      if (entry.mcp) {
        // The server names the call; the tool and what it was asked follow.
        item.classList.add('t-mcp');
        item.title = `${entry.mcp.server} (MCP) › ${entry.mcp.tool}`;
        item.append(el('span', 't-tool-name', entry.mcp.server), el('span', 't-tool-detail', entry.detail ? `${entry.mcp.tool} · ${entry.detail}` : entry.mcp.tool));
        break;
      }
      if (entry.action) item.classList.add(`t-${entry.action}`);
      item.append(el('span', 't-tool-name', entry.tool));
      if (entry.file) {
        const link = button(entry.detail, 't-tool-detail t-link', `Open ${entry.file}`);
        link.dataset.file = entry.file;
        item.append(link);
      } else {
        const detail = el('span', 't-tool-detail', entry.detail);
        if (entry.action) detail.title = 'Not in the indexed graph';
        item.append(detail);
      }
      break;
    }
    case 'turn': {
      item.dataset.outcome = entry.outcome;
      const cost = entry.costUsd > 0 ? `, ${dollars(entry.costUsd)}` : '';
      if (entry.outcome === 'done') item.textContent = `Done in ${seconds(entry.durationMs)}${cost}`;
      else if (entry.outcome === 'interrupted') item.textContent = `Stopped${cost}`;
      else item.textContent = `Failed${entry.message ? `: ${entry.message}` : ''}`;
      break;
    }
    case 'notice':
      item.dataset.level = entry.level;
      item.textContent = entry.text;
      break;
  }
  return item;
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
