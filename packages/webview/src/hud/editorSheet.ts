import { getChunks, unifiedMergeView } from '@codemirror/merge';
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { basenameOf, dirnameOf } from '@orbit-code/graph/languages';
import type { FileReply } from '@orbit-code/protocol';
import type { FileRequests } from '../fileRequests';
import { editorExtensions, languageOf } from './codeEditor';
import { button, el } from './dom';

export type EditorMode = 'code' | 'changes';

export interface EditorSheetEvents {
  /** The sheet takes this many pixels of the bottom of the panel (0 once closed): the HUD above it makes room. */
  resized(inset: number): void;
  openInTab(path: string, diff: boolean): void;
}

/** What the harness reads through `__orbit.editor()`. */
export interface EditorDebugState {
  open: boolean;
  path?: string;
  mode: EditorMode;
  dirty: boolean;
  language?: string;
  text?: string;
  changes: number;
  notice?: string;
  saving: boolean;
}

type Content = Extract<FileReply, { kind: 'content' }>;

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const MIN_HEIGHT_PX = 180;
/** The sheet leaves at least this much of the graph above it. */
const GRAPH_ROOM_PX = 96;
const DEFAULT_SHARE = 0.46;

/**
 * The bottom overlay: one workspace file in a code editor. It opens on the file (Open) or on its changes against
 * HEAD (View diff) and switches between the two. Mod-S saves through VS Code's document; edits made elsewhere
 * arrive while it is open and replace the text when nothing here is unsaved, or ask first when something is.
 * The top edge drags to resize; Esc closes, asking about unsaved changes.
 */
export class EditorSheet {
  private readonly root = el('section', 'editor-sheet');
  private readonly grabber = button('', 'es-grabber', 'Drag to resize');
  private readonly dirtyDot = el('span', 'es-dot');
  private readonly name = el('span', 'es-name');
  private readonly dir = el('span', 'es-dir');
  private readonly modes = el('div', 'es-modes');
  private readonly codeButton = button('Code', 'es-mode');
  private readonly changesButton = button('Changes', 'es-mode', 'Differences against HEAD');
  private readonly tabButton = button('Open in a tab', 'button es-tab');
  private readonly saveButton = button('Save', 'button primary es-save');
  private readonly closeButton = button('', 'sv-close es-close', 'Close (Esc)');
  private readonly notice = el('div', 'es-notice');
  private readonly noticeText = el('p', 'es-notice-text');
  private readonly noticeActions = el('div', 'es-notice-actions');
  private readonly frame = el('div', 'es-editor');
  private readonly loading = el('p', 'es-loading');
  private readonly position = el('span', 'es-position');
  private readonly language = el('span', 'es-language');
  private readonly summary = el('span', 'es-summary');
  private readonly saveState = el('span', 'es-state');
  private readonly languageSlot = new Compartment();
  private readonly diffSlot = new Compartment();
  private view: EditorView | undefined;
  private path: string | undefined;
  private follow: number | undefined;
  private revision = 0;
  /** The text as last loaded or saved; the sheet is dirty when its document differs. */
  private saved: Text | undefined;
  private base: string | undefined;
  private mode: EditorMode = 'code';
  private dirty = false;
  private saving = false;
  private languageLabel = '';
  /** A change made elsewhere that arrived while this sheet had unsaved edits. */
  private outside: Content | undefined;
  private height = 0;
  private motion: Animation | undefined;
  /** The host has editor tabs of its own (`HostCapabilities.tabs`): offer to open the file in one. */
  private tabs = true;

  constructor(
    host: HTMLElement,
    private readonly files: FileRequests,
    private readonly nonce: string | undefined,
    private readonly events: EditorSheetEvents,
  ) {
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Editor');
    this.closeButton.setAttribute('aria-label', 'Close');
    this.grabber.setAttribute('aria-label', 'Resize the editor');

    const title = el('h2', 'es-title');
    this.dirtyDot.title = 'Unsaved changes';
    title.append(this.dirtyDot, this.name, this.dir);
    this.modes.setAttribute('role', 'tablist');
    for (const mode of [this.codeButton, this.changesButton]) mode.setAttribute('role', 'tab');
    this.modes.append(this.codeButton, this.changesButton);
    const actions = el('div', 'es-actions');
    actions.append(this.modes, this.tabButton, this.saveButton, this.closeButton);
    const head = el('header', 'es-head');
    head.append(title, actions);

    this.notice.hidden = true;
    this.notice.setAttribute('role', 'alert');
    this.notice.append(this.noticeText, this.noticeActions);
    this.loading.hidden = true;
    this.frame.append(this.loading);

    const status = el('footer', 'es-status');
    const shortcut = el('span', 'es-shortcut', /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S saves · Esc closes' : 'Ctrl+S saves · Esc closes');
    status.append(this.position, this.language, this.summary, this.saveState, shortcut);

    const panel = el('div', 'es-panel');
    panel.append(this.grabber, head, this.notice, this.frame, status);
    this.root.append(panel);
    host.append(this.root);

    this.codeButton.addEventListener('click', () => this.setMode('code'));
    this.changesButton.addEventListener('click', () => this.setMode('changes'));
    this.tabButton.addEventListener('click', () => this.path && events.openInTab(this.path, this.mode === 'changes'));
    this.saveButton.addEventListener('click', () => void this.save(false));
    this.closeButton.addEventListener('click', () => this.close());
    this.resizable();

    // A shortcut the editor handled (undo, save, find, select all) must not also reach VS Code, which would apply it again.
    this.root.addEventListener('keydown', (event) => {
      if (event.defaultPrevented && (event.metaKey || event.ctrlKey)) event.stopPropagation();
    });
    // On document, so the drawer and session view, listening on window, close first when they are open.
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || !this.isOpen) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('.cm-panel')) return; // the search panel closes itself
        event.preventDefault();
        event.stopPropagation();
        if (!this.notice.hidden && this.dirty) this.hideNotice();
        else this.close();
      },
      true,
    );
    window.addEventListener('resize', () => this.isOpen && this.applyHeight(this.height));
  }

  get isOpen(): boolean {
    return !this.root.hidden && this.root.dataset.closing !== 'true';
  }

  get openPath(): string | undefined {
    return this.isOpen ? this.path : undefined;
  }

  /** Whether the host has editor tabs to open the file in. */
  setTabs(tabs: boolean): void {
    this.tabs = tabs;
    this.tabButton.hidden = !tabs;
  }

  /** Opens `path` on its code or on its changes; asks first if another file has unsaved edits here. */
  open(path: string, mode: EditorMode): void {
    if (this.isOpen && this.path === path && this.view) {
      this.setMode(mode);
      this.view.focus();
      return;
    }
    this.guard(`open ${basenameOf(path)}`, () => this.load(path, mode));
  }

  /** Closes, asking first about unsaved edits. */
  close(): void {
    if (!this.isOpen) return;
    this.guard('close', () => this.hide());
  }

  /** The file was renamed: the host follows it under the new name. */
  renamed(from: string, to: string): void {
    if (this.path !== from) return;
    this.path = to;
    this.renderTitle();
  }

  /** The file was deleted: nothing is left to save. */
  deleted(path: string): void {
    if (this.path === path && this.isOpen) this.hide();
  }

  debugState(): EditorDebugState {
    const state = this.view?.state;
    return {
      open: this.isOpen,
      path: this.path,
      mode: this.mode,
      dirty: this.dirty,
      language: this.languageLabel || undefined,
      text: state?.doc.toString(),
      changes: state ? (getChunks(state)?.chunks.length ?? 0) : 0,
      notice: this.notice.hidden ? undefined : (this.noticeText.textContent ?? undefined),
      saving: this.saving,
    };
  }

  private load(path: string, mode: EditorMode): void {
    this.detach();
    this.clearEditor();
    this.path = path;
    this.mode = mode;
    this.renderTitle();
    this.hideNotice();
    this.loading.hidden = false;
    this.loading.textContent = `Opening ${basenameOf(path)}…`;
    this.show();
    const { id, first } = this.files.follow(path, (reply, current) => this.onFollow(id, reply, current));
    this.follow = id;
    void first.then((reply) => {
      if (this.follow !== id) return;
      this.loading.hidden = true;
      if (reply.kind === 'content') this.attach(reply);
      else this.showNotice(reply.kind === 'failed' ? reply.error : `${basenameOf(path)} could not be opened.`, this.tabs ? [['Open in a tab', () => this.events.openInTab(path, false)]] : [['Close', () => this.hide()]]);
    });
  }

  private attach(content: Content): void {
    const language = languageOf(content.language, this.path ?? '');
    this.languageLabel = language.label;
    this.base = content.base;
    this.revision = content.revision;
    if (this.mode === 'changes' && this.base === undefined) this.mode = 'code';
    const state = EditorState.create({
      doc: content.text,
      extensions: [
        editorExtensions(() => void this.save(false), this.nonce),
        this.languageSlot.of(language.extension),
        this.diffSlot.of(this.diffExtension()),
        EditorView.updateListener.of((update) => this.onUpdate(update)),
      ],
    });
    this.view = new EditorView({ state, parent: this.frame });
    this.saved = this.view.state.doc;
    this.dirty = false;
    this.renderStatus();
    this.view.focus();
    if (!reducedMotion()) this.view.dom.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  }

  private onFollow(id: number, reply: FileReply, path: string): void {
    if (this.follow !== id || reply.kind !== 'content' || !this.view) return;
    this.path = path;
    if (this.dirty) {
      this.outside = reply;
      this.showNotice(`${basenameOf(path)} changed outside the editor.`, [
        ['Reload', () => this.takeOutside()],
        ['Keep mine', () => this.hideNotice()],
      ]);
      return;
    }
    this.outside = reply;
    this.takeOutside();
    this.flash('Updated from disk');
  }

  /** Replaces the text with the change made elsewhere, keeping the cursor near where it was. */
  private takeOutside(): void {
    const content = this.outside;
    const view = this.view;
    this.outside = undefined;
    this.hideNotice();
    if (!content || !view) return;
    this.revision = content.revision;
    const next = EditorState.create({ doc: content.text }).doc;
    view.dispatch({ changes: minimalChange(view.state.doc.toString(), next.toString()) });
    this.saved = view.state.doc;
    this.dirty = false;
    if (content.base !== this.base) {
      this.base = content.base;
      if (this.mode === 'changes' && this.base === undefined) this.mode = 'code';
      view.dispatch({ effects: this.diffSlot.reconfigure(this.diffExtension()) });
    }
    this.renderStatus();
  }

  private async save(force: boolean): Promise<void> {
    const view = this.view;
    const path = this.path;
    if (!view || !path || this.saving) return;
    if (!this.dirty && !force) {
      this.flash('No changes to save');
      return;
    }
    const doc = view.state.doc;
    this.saving = true;
    this.renderStatus();
    const reply = await this.files.send(path, { kind: 'write', text: doc.toString(), revision: this.revision, force });
    this.saving = false;
    if (this.view !== view) return;
    if (reply.kind === 'saved') {
      this.revision = reply.revision;
      this.saved = doc;
      this.dirty = !view.state.doc.eq(doc);
      this.hideNotice();
      this.flash('Saved');
    } else if (reply.kind === 'failed' && reply.conflict) {
      this.showNotice(reply.error, [
        ['Overwrite', () => void this.save(true)],
        ['Reload theirs', () => this.reload()],
        ['Cancel', () => this.hideNotice()],
      ]);
    } else {
      this.showNotice(reply.kind === 'failed' ? reply.error : 'Not saved.', [['Dismiss', () => this.hideNotice()]]);
    }
    this.renderStatus();
  }

  /** Throws away the unsaved edits and reads the file again. */
  private reload(): void {
    if (this.path) this.load(this.path, this.mode);
  }

  private setMode(mode: EditorMode): void {
    if (mode === 'changes' && this.base === undefined) return;
    if (mode === this.mode) return;
    this.mode = mode;
    this.view?.dispatch({ effects: this.diffSlot.reconfigure(this.diffExtension()) });
    if (this.view && !reducedMotion()) this.view.dom.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    this.renderStatus();
  }

  private diffExtension(): Extension {
    if (this.mode !== 'changes' || this.base === undefined) return [];
    return unifiedMergeView({ original: this.base, mergeControls: false, gutter: true, syntaxHighlightDeletions: true, collapseUnchanged: { margin: 3, minSize: 6 } });
  }

  private onUpdate(update: ViewUpdate): void {
    if (update.docChanged && this.saved) {
      const dirty = !update.state.doc.eq(this.saved);
      if (dirty !== this.dirty) {
        this.dirty = dirty;
        this.renderStatus();
        return;
      }
    }
    if (update.docChanged || update.selectionSet) this.renderPosition();
  }

  /** Runs `then` now, or once unsaved edits are saved or thrown away. */
  private guard(what: string, then: () => void): void {
    if (!this.isOpen || !this.dirty || !this.path) {
      then();
      return;
    }
    this.showNotice(`${basenameOf(this.path)} has unsaved changes. Save them before you ${what}?`, [
      [
        'Save',
        async () => {
          await this.save(false);
          if (!this.dirty) then();
        },
      ],
      ["Don't save", then],
      ['Cancel', () => this.hideNotice()],
    ]);
  }

  private show(): void {
    const wasOpen = this.isOpen;
    this.motion?.cancel();
    this.root.hidden = false;
    delete this.root.dataset.closing;
    if (this.height === 0) this.height = Math.round(window.innerHeight * DEFAULT_SHARE);
    this.applyHeight(this.height);
    if (wasOpen || reducedMotion()) return;
    this.motion = this.root.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: 440, easing: EASE });
  }

  private hide(): void {
    if (this.path) void this.files.send(this.path, { kind: 'close' });
    this.detach();
    this.events.resized(0);
    this.motion?.cancel();
    if (reducedMotion()) {
      this.root.hidden = true;
      this.clearEditor();
      return;
    }
    this.root.dataset.closing = 'true';
    const motion = this.root.animate([{ transform: 'none' }, { transform: 'translateY(100%)' }], { duration: 280, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
    this.motion = motion;
    motion.onfinish = () => {
      if (this.motion !== motion) return;
      this.root.hidden = true;
      delete this.root.dataset.closing;
      motion.cancel();
      this.clearEditor();
    };
  }

  /** Stops following the file and forgets unsaved state. The editor itself stays until `clearEditor`, so a closing sheet slides down with its text. */
  private detach(): void {
    if (this.follow !== undefined) this.files.unfollow(this.follow);
    this.follow = undefined;
    this.outside = undefined;
    this.dirty = false;
    this.saving = false;
  }

  private clearEditor(): void {
    this.view?.destroy();
    this.view = undefined;
  }

  private applyHeight(height: number): void {
    this.height = Math.round(Math.min(Math.max(MIN_HEIGHT_PX, height), window.innerHeight - GRAPH_ROOM_PX));
    this.root.style.height = `${this.height}px`;
    this.events.resized(this.height);
  }

  /** The grabber follows the pointer; a double click switches between the default height and the tallest. */
  private resizable(): void {
    this.grabber.addEventListener('pointerdown', (down) => {
      if (down.button !== 0) return;
      const start = this.height;
      this.grabber.setPointerCapture(down.pointerId);
      this.root.dataset.resizing = 'true';
      const move = (event: PointerEvent) => this.applyHeight(start - (event.clientY - down.clientY));
      const end = () => {
        this.grabber.removeEventListener('pointermove', move);
        this.grabber.removeEventListener('pointerup', end);
        this.grabber.removeEventListener('pointercancel', end);
        delete this.root.dataset.resizing;
      };
      this.grabber.addEventListener('pointermove', move);
      this.grabber.addEventListener('pointerup', end);
      this.grabber.addEventListener('pointercancel', end);
    });
    this.grabber.addEventListener('dblclick', () => {
      const tallest = window.innerHeight - GRAPH_ROOM_PX;
      this.applyHeight(this.height >= tallest - 4 ? window.innerHeight * DEFAULT_SHARE : tallest);
    });
  }

  private renderTitle(): void {
    const path = this.path ?? '';
    this.name.textContent = basenameOf(path);
    const dir = dirnameOf(path);
    this.dir.textContent = dir === '.' ? '' : dir;
    this.root.title = path;
  }

  private renderStatus(): void {
    this.root.dataset.mode = this.mode;
    this.root.dataset.dirty = String(this.dirty);
    this.changesButton.hidden = this.base === undefined;
    this.modes.hidden = this.base === undefined;
    this.codeButton.setAttribute('aria-selected', String(this.mode === 'code'));
    this.changesButton.setAttribute('aria-selected', String(this.mode === 'changes'));
    this.saveButton.disabled = !this.view || this.saving;
    this.saveButton.textContent = this.saving ? 'Saving…' : 'Save';
    this.tabButton.textContent = this.mode === 'changes' ? 'Diff in a tab' : 'Open in a tab';
    this.tabButton.hidden = !this.tabs;
    this.language.textContent = this.languageLabel;
    this.saveState.textContent = this.saving ? 'Saving…' : this.dirty ? 'Unsaved' : '';
    const chunks = this.mode === 'changes' && this.view ? (getChunks(this.view.state)?.chunks.length ?? 0) : undefined;
    this.summary.textContent = chunks === undefined ? '' : chunks === 0 ? 'No changes against HEAD' : `${chunks} ${chunks === 1 ? 'change' : 'changes'} against HEAD`;
    this.renderPosition();
  }

  private renderPosition(): void {
    const state = this.view?.state;
    if (!state) {
      this.position.textContent = '';
      return;
    }
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    this.position.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
    if (this.mode === 'changes') {
      const chunks = getChunks(state)?.chunks.length ?? 0;
      this.summary.textContent = chunks === 0 ? 'No changes against HEAD' : `${chunks} ${chunks === 1 ? 'change' : 'changes'} against HEAD`;
    }
  }

  private flash(text: string): void {
    this.saveState.textContent = text;
    if (!reducedMotion()) this.saveState.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
    const shown = text;
    setTimeout(() => {
      if (this.saveState.textContent === shown) this.saveState.textContent = this.dirty ? 'Unsaved' : '';
    }, 1800);
  }

  private showNotice(text: string, actions: Array<[string, () => void]>): void {
    const wasHidden = this.notice.hidden;
    this.noticeText.textContent = text;
    this.noticeActions.replaceChildren(
      ...actions.map(([label, run], k) => {
        const action = button(label, k === 0 ? 'button primary' : 'button');
        action.addEventListener('click', run);
        return action;
      }),
    );
    this.notice.hidden = false;
    if (wasHidden && !reducedMotion()) {
      this.notice.animate([{ opacity: 0, transform: 'translateY(-6px)', maxHeight: '0px' }, { opacity: 1, transform: 'none', maxHeight: '120px' }], { duration: 260, easing: EASE });
    }
  }

  private hideNotice(): void {
    this.notice.hidden = true;
  }
}

/** The smallest single replacement turning `from` into `to`: shared start and end stay, so the cursor keeps its place. */
function minimalChange(from: string, to: string): { from: number; to: number; insert: string } {
  let start = 0;
  const shorter = Math.min(from.length, to.length);
  while (start < shorter && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (end < shorter - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
