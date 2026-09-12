import { basenameOf, dirnameOf } from '../../shared/languages';
import type { FileReply, GitFileState } from '../../shared/protocol';
import { resolveWithin } from '../../shared/workspacePath';
import { button, el } from './dom';

export interface FileTarget {
  /** Workspace-relative id. */
  path: string;
  /** Its file type's colour, as CSS. */
  color: string;
  kind: string;
}

export interface FileMenuActions {
  viewDiff(path: string): void;
  open(path: string): void;
  openInTab(path: string): void;
  /** The file goes with the next prompt, as context. */
  attach(path: string): void;
  rename(path: string, to: string): Promise<FileReply>;
  /** The scene collapses the file while the host deletes it. */
  remove(path: string): Promise<FileReply>;
  /** The delete prompt came up or went: the scene rings the file red meanwhile. */
  confirming(on: boolean): void;
  closed(): void;
}

type View = 'actions' | 'confirm' | 'rename';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** Gap between the file on screen and the menu beside it. */
const OFFSET_PX = 20;
const EDGE_PX = 12;
/** The confirm button stays disarmed this long, so a double click on Delete… cannot delete. */
const ARM_MS = 420;

/**
 * A card beside the file that was clicked: View diff (only when git has changes for it), Open (the editor sheet),
 * Open in a tab, Rename… and Delete…. Rename and Delete turn the card into a prompt in place; the host's answer
 * either closes it or shakes it with the reason. The card follows the file as the camera moves.
 */
export class FileMenu {
  private readonly root = el('section', 'file-menu');
  private readonly card = el('div', 'fm-card');
  private readonly swatch = el('span', 'fm-swatch');
  private readonly name = el('p', 'fm-name');
  private readonly dir = el('p', 'fm-dir');
  private readonly body = el('div', 'fm-views');
  private readonly items = el('div', 'fm-actions');
  private readonly diff = this.item('diff', 'View diff', 'vs HEAD');
  private readonly confirmView = el('form', 'fm-confirm');
  private readonly confirmPrompt = el('p', 'fm-prompt');
  private readonly confirmError = el('p', 'fm-error');
  private readonly confirmButton = button('Delete', 'button danger fm-go');
  private readonly renameView = el('form', 'fm-rename');
  private readonly renamePrompt = el('label', 'fm-prompt');
  private readonly input = el('input', 'fm-input');
  private readonly renameDetail = el('p', 'fm-detail');
  private readonly renameButton = button('Rename', 'button primary fm-go');
  private readonly views: Record<View, HTMLElement>;
  private target: FileTarget | undefined;
  private view: View = 'actions';
  private working = false;
  private leaving: Animation | undefined;
  private armed: ReturnType<typeof setTimeout> | undefined;

  constructor(
    host: HTMLElement,
    private readonly actions: FileMenuActions,
  ) {
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'File');
    this.root.tabIndex = -1;

    const title = el('div', 'fm-title');
    title.append(this.name, this.dir);
    const head = el('header', 'fm-head');
    this.swatch.setAttribute('aria-hidden', 'true');
    head.append(this.swatch, title);

    this.items.setAttribute('role', 'menu');
    this.items.append(this.diff, this.item('open', 'Open', 'here'), this.item('tab', 'Open in a tab', 'beside'), this.item('attach', 'Attach to prompt', 'for Claude'), el('div', 'fm-rule'), this.item('rename', 'Rename…'), this.item('delete', 'Delete…'));

    const alarm = el('span', 'fm-alarm');
    alarm.setAttribute('aria-hidden', 'true');
    const confirmDetail = el('p', 'fm-detail', 'VS Code deletes it the way the Explorer does, so Undo there brings it back.');
    const confirmButtons = el('div', 'fm-buttons');
    const cancelDelete = button('Cancel', 'button');
    this.confirmButton.type = 'submit';
    this.confirmButton.append(el('span', 'fm-arm'));
    confirmButtons.append(cancelDelete, this.confirmButton);
    this.confirmError.hidden = true;
    this.confirmView.append(alarm, this.confirmPrompt, confirmDetail, this.confirmError, confirmButtons);

    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.id = 'orbit-rename-input';
    this.renamePrompt.htmlFor = this.input.id;
    const renameButtons = el('div', 'fm-buttons');
    const cancelRename = button('Cancel', 'button');
    this.renameButton.type = 'submit';
    renameButtons.append(cancelRename, this.renameButton);
    this.renameView.append(this.renamePrompt, this.input, this.renameDetail, renameButtons);

    this.views = { actions: this.items, confirm: this.confirmView, rename: this.renameView };
    this.confirmView.hidden = this.renameView.hidden = true;
    this.body.append(this.items, this.confirmView, this.renameView);
    this.card.append(head, this.body);
    this.root.append(this.card);
    host.append(this.root);

    this.items.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('.fm-item')?.dataset.action;
      if (action) this.choose(action);
    });
    this.items.addEventListener('keydown', (event) => this.navigate(event));
    cancelDelete.addEventListener('click', () => this.close());
    cancelRename.addEventListener('click', () => this.close());
    this.confirmView.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.remove();
    });
    this.renameView.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.rename();
    });
    this.input.addEventListener('input', () => this.validate());
    // Enter renames without leaning on implicit form submission, like the composer's Enter.
    this.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      void this.rename();
    });

    // Esc closes the card before anything else sees it; the card is on top of everything it could close.
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || !this.isOpen) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
      },
      true,
    );
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (this.isOpen && !this.working && !this.root.contains(event.target as Node)) this.close();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return !this.root.hidden && this.leaving === undefined;
  }

  /** The file the card is for, while it is open. */
  get path(): string | undefined {
    return this.isOpen ? this.target?.path : undefined;
  }

  /** A delete or rename is waiting for the host. */
  get busy(): boolean {
    return this.working;
  }

  open(target: FileTarget): void {
    if (this.working) return;
    this.leaving?.cancel();
    this.leaving = undefined;
    this.target = target;
    this.name.textContent = basenameOf(target.path);
    const dir = dirnameOf(target.path);
    this.dir.textContent = dir === '.' ? target.kind : `${dir} · ${target.kind}`;
    this.swatch.style.background = target.color;
    this.diff.hidden = true;
    this.setView('actions', false);
    this.root.hidden = false;
    this.root.dataset.offscreen = 'false';
    this.root.focus({ preventScroll: true });
    if (reducedMotion()) return;
    this.card.animate(
      [
        { opacity: 0, transform: 'scale(0.84)', filter: 'blur(6px)' },
        { opacity: 1, transform: 'none', filter: 'blur(0px)' },
      ],
      { duration: 260, easing: EASE },
    );
    [...this.items.children].forEach((item, k) =>
      item.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: 50 + k * 28, easing: 'ease-out', fill: 'backwards' }),
    );
  }

  /** Git answered: View diff shows only for a file with changes. */
  setGit(path: string, git: GitFileState): void {
    if (path !== this.target?.path || git !== 'changed' || !this.diff.hidden) return;
    this.morph(() => (this.diff.hidden = false));
    if (!reducedMotion()) this.diff.animate([{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
  }

  /** Keeps the card beside the file: (x, y) in client pixels, or off screen. */
  place(x: number, y: number, onScreen: boolean): void {
    if (this.root.hidden) return;
    this.root.dataset.offscreen = String(!onScreen);
    if (!onScreen) return;
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const right = x + OFFSET_PX + width <= window.innerWidth - EDGE_PX;
    const left = right ? x + OFFSET_PX : Math.max(EDGE_PX, x - OFFSET_PX - width);
    const top = Math.min(Math.max(EDGE_PX, y - 28), window.innerHeight - height - EDGE_PX);
    this.root.dataset.side = right ? 'right' : 'left';
    this.root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    // The notch points at the file even when the card is held inside the window.
    this.root.style.setProperty('--fm-notch', `${Math.round(Math.min(Math.max(16, y - top), height - 16))}px`);
  }

  /** A rename landed in the graph: the card, if still open, is for the new path. */
  retarget(path: string): void {
    if (this.target) this.target = { ...this.target, path };
  }

  close(): void {
    if (this.root.hidden || this.leaving) return;
    if (this.view === 'confirm') this.actions.confirming(false);
    clearTimeout(this.armed);
    this.working = false;
    this.actions.closed();
    if (reducedMotion()) {
      this.root.hidden = true;
      return;
    }
    const motion = this.card.animate(
      [
        { opacity: 1, transform: 'none', filter: 'blur(0px)' },
        { opacity: 0, transform: 'scale(0.9)', filter: 'blur(4px)' },
      ],
      { duration: 180, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    );
    this.leaving = motion;
    motion.onfinish = () => {
      if (this.leaving !== motion) return;
      this.leaving = undefined;
      this.root.hidden = true;
      motion.cancel();
    };
  }

  private item(action: string, label: string, hint?: string): HTMLButtonElement {
    const item = button('', `fm-item fm-item-${action}`);
    item.dataset.action = action;
    item.setAttribute('role', 'menuitem');
    const icon = el('span', 'fm-icon');
    icon.setAttribute('aria-hidden', 'true');
    item.append(icon, el('span', 'fm-label', label));
    if (hint) item.append(el('span', 'fm-hint', hint));
    return item;
  }

  private choose(action: string): void {
    const target = this.target;
    if (!target || this.working) return;
    switch (action) {
      case 'diff':
        this.actions.viewDiff(target.path);
        this.close();
        break;
      case 'open':
        this.actions.open(target.path);
        this.close();
        break;
      case 'tab':
        this.actions.openInTab(target.path);
        this.close();
        break;
      case 'attach':
        this.actions.attach(target.path);
        this.close();
        break;
      case 'rename':
        this.renamePrompt.textContent = `Rename ${basenameOf(target.path)}`;
        this.input.value = basenameOf(target.path);
        this.validate();
        this.setView('rename', true);
        this.input.focus({ preventScroll: true });
        // The name, not its extension, is what usually changes.
        this.input.setSelectionRange(0, Math.max(0, this.input.value.lastIndexOf('.')) || this.input.value.length);
        break;
      case 'delete':
        this.confirmPrompt.replaceChildren('Delete ', el('b', undefined, basenameOf(target.path)), '?');
        this.confirmError.hidden = true;
        this.confirmButton.firstChild!.textContent = 'Delete';
        this.setView('confirm', true);
        this.actions.confirming(true);
        this.arm();
        break;
    }
  }

  private async remove(): Promise<void> {
    const target = this.target;
    if (!target || this.working || this.confirmButton.disabled) return;
    this.setWorking(true, this.confirmButton, 'Deleting…');
    const reply = await this.actions.remove(target.path);
    if (this.target !== target) return;
    this.setWorking(false, this.confirmButton, 'Try again');
    if (reply.kind === 'deleted') {
      this.close();
      return;
    }
    this.fail(this.confirmError, reply.kind === 'failed' ? reply.error : 'The file was not deleted.');
  }

  private async rename(): Promise<void> {
    const target = this.target;
    const to = this.validate();
    if (!target || !to || this.working) return;
    this.setWorking(true, this.renameButton, 'Renaming…');
    const reply = await this.actions.rename(target.path, to);
    if (this.target !== target) return;
    this.setWorking(false, this.renameButton, 'Rename');
    if (reply.kind === 'renamed') {
      this.retarget(reply.to);
      this.renameView.dataset.done = 'true';
      setTimeout(() => {
        delete this.renameView.dataset.done;
        // Unless another file's card was opened meanwhile.
        if (this.target?.path === reply.to && this.view === 'rename') this.close();
      }, 260);
      return;
    }
    this.fail(this.renameDetail, reply.kind === 'failed' ? reply.error : 'The file was not renamed.');
    this.input.focus({ preventScroll: true });
  }

  /** The new path the input names, or undefined with the reason shown under it. */
  private validate(): string | undefined {
    const target = this.target;
    const value = this.input.value.trim();
    const to = target && value ? resolveWithin(dirnameOf(target.path), value) : undefined;
    let problem: string | undefined;
    if (!value) problem = 'Type the new name. A path moves it, like ../lib/name.ts.';
    else if (!to) problem = 'That leaves the workspace, or has a backslash or a trailing slash.';
    else if (to === target?.path) problem = 'That is its name now.';
    this.renameView.dataset.invalid = String(problem !== undefined && value !== '' && to !== target?.path);
    this.renameDetail.dataset.level = '';
    if (problem || !to || !target) {
      this.renameDetail.textContent = problem ?? '';
    } else {
      // Where it ends up: the name is already in the input, so only the directory is worth saying.
      const dir = dirnameOf(to);
      const path = el('span', 'fm-path', dir === '.' ? 'the workspace root' : dir);
      this.renameDetail.replaceChildren(dir === dirnameOf(target.path) ? 'Stays in ' : 'Moves to ', path);
      this.renameDetail.title = to;
    }
    this.renameButton.disabled = problem !== undefined;
    return problem ? undefined : to;
  }

  private setWorking(working: boolean, action: HTMLButtonElement, label: string): void {
    this.working = working;
    this.root.dataset.working = String(working);
    action.firstChild!.textContent = label;
    for (const control of this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) control.disabled = working;
    if (!working) this.validate();
  }

  private fail(line: HTMLElement, message: string): void {
    this.morph(() => {
      line.hidden = false;
      line.dataset.level = 'error';
      line.textContent = message;
    });
    if (!reducedMotion()) {
      this.card.animate(
        [{ transform: 'none' }, { transform: 'translateX(-9px)' }, { transform: 'translateX(7px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(2px)' }, { transform: 'none' }],
        { duration: 380, easing: 'ease-out' },
      );
    }
  }

  /** The delete button fills over ARM_MS before it takes a click. */
  private arm(): void {
    clearTimeout(this.armed);
    this.confirmButton.disabled = true;
    const fill = this.confirmButton.querySelector('.fm-arm');
    if (fill && !reducedMotion()) fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: ARM_MS, easing: 'linear', fill: 'forwards' });
    this.armed = setTimeout(() => {
      this.confirmButton.disabled = false;
      this.confirmButton.focus({ preventScroll: true });
    }, ARM_MS);
  }

  /** Swaps one view for another: the old one slides out, the new one in, and the card's height follows. */
  private setView(view: View, animate: boolean): void {
    const from = this.view;
    this.view = view;
    this.root.dataset.view = view;
    if (!animate || from === view || reducedMotion()) {
      for (const [name, element] of Object.entries(this.views)) element.hidden = name !== view;
      return;
    }
    const outgoing = this.views[from];
    const incoming = this.views[view];
    this.morph(() => {
      outgoing.hidden = true;
      incoming.hidden = false;
    });
    outgoing.hidden = false;
    outgoing.classList.add('fm-leaving');
    const leave = outgoing.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-20px) scale(0.98)' }], { duration: 170, easing: 'ease-in', fill: 'forwards' });
    leave.onfinish = () => {
      outgoing.hidden = this.view !== from;
      outgoing.classList.remove('fm-leaving');
      leave.cancel();
    };
    incoming.animate([{ opacity: 0, transform: 'translateX(22px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 50, easing: EASE, fill: 'backwards' });
  }

  /** Runs a change to the card's contents and animates its height from before to after. */
  private morph(change: () => void): void {
    const before = this.body.offsetHeight;
    change();
    const after = this.body.offsetHeight;
    if (before !== after && !reducedMotion()) this.body.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration: 280, easing: EASE });
  }

  private navigate(event: KeyboardEvent): void {
    const items = [...this.items.querySelectorAll<HTMLButtonElement>('.fm-item')].filter((item) => !item.hidden);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (next === undefined || items.length === 0) return;
    event.preventDefault();
    items[(next + items.length) % items.length].focus();
  }
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
