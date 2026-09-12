import type { AgentCatalog, ConversationSummary, HistorySnapshot, McpAction, McpServerInfo, SkillInfo, SkillScope } from '@orbit-code/protocol';
import { type ForceLink, ForceLayout, type ForceNode } from '../constellation/forceLayout';
import type { CoreInstance, GlyphInstance, LinkInstance } from '../constellation/glyphs';
import { ConstellationView, type FitPoint } from '../constellation/view';
import { MCP_STATUS_COLORS, PALETTE, type Rgb, SCOPE_COLORS, cssColor, hex } from '../palette';
import { button, el } from './dom';
import { TimeRange } from './timeRange';
import { plural, relativeTime } from './turns';

export type ConstellationMode = 'skills' | 'history' | 'mcp';

export interface ConstellationEvents {
  /** A skill was chosen: dropped on the composer, clicked, or picked with the keyboard. */
  attach(name: string): void;
  /** Where a dragged skill can be dropped. */
  dropTarget(): DOMRect | undefined;
  /** A skill is being dragged ('ready'), is over the drop target ('over'), or no longer (undefined). */
  dragState(state: 'ready' | 'over' | undefined): void;
  openConversation(conversation: ConversationSummary, origin: DOMRect): void;
  /** Refresh (skills, history) or Reload (MCP servers). */
  refresh(mode: ConstellationMode): void;
  /** A button under the MCP constellation: reconnect, enable, disable, sign in to or sign out of a server. */
  mcpAction(server: string, action: McpAction): void;
  openFile(path: string): void;
  /** The panel closed, by any path. */
  closed(): void;
  wake(): void;
}

interface Item {
  key: string;
  kind: 'hub' | 'skill' | 'conversation' | 'server' | 'tool';
  color: Rgb;
  size: number;
  node: ForceNode;
  appearAt: number;
  emphasis: number;
  ring: number;
  phase: number;
  /** How well the item answers the filter typed after a slash: 0 hides it, higher ranks it. 1 without a filter. */
  match: number;
  /** Eased visibility under the filter: 1 shown, near 0 dimmed away. */
  dim: number;
  /** Where a conversation, pinned to its place in time across, is gliding to after the time range changed. */
  slideTo?: number;
  target?: HTMLButtonElement;
  tag?: HTMLElement;
  skill?: SkillInfo;
  conversation?: ConversationSummary;
  server?: McpServerInfo;
  scope?: SkillScope;
}

interface Link {
  a: number;
  b: number;
  color: Rgb;
  alpha: number;
  width: number;
  flow: number;
  seed: number;
}

interface Graph {
  items: Item[];
  links: Link[];
  forces: ForceLink[];
}

const SCOPES: readonly SkillScope[] = ['project', 'user', 'plugin'];
const SCOPE_LABELS: Record<SkillScope, string> = { project: 'This workspace', user: 'Your skills', plugin: 'Plugins' };
const SCOPE_WHERE: Record<SkillScope, string> = { project: '.claude/skills in this workspace', user: 'your ~/.claude/skills, for every workspace', plugin: 'installed Claude Code plugins' };
const DRAG_SLOP_PX = 5;
const APPEAR_S = 0.55;
const STAGGER_S = 0.03;
const LEAVE_S = 0.28;
/** With more skills than this, only the one pointed at is named on the graph. */
const MAX_LABELS = 30;
const SHEET_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const OLDER = hex('#6d85cc');
const CHAIN = hex('#7f93d6');
const SHARED = hex('#d9ceff');
/** How far the wheel zooms in past fitting the whole graph. */
const MAX_ZOOM = 4;
/** What a glyph that fails the filter fades to. */
const DIMMED = 0.1;
/** How far the graph sways about the vertical, either way (radians): the timeline less, so it reads left to right. */
const SKILLS_SWAY = 0.4;
const HISTORY_SWAY = 0.16;
const ELEVATION = 0.18;
/** CSS pixels kept clear inside the field's edges, for the names under the glyphs. */
const FIT_MARGIN = { x: 30, y: 22 };

/** How an MCP server connected, as the MCP constellation groups and colours it. */
type ServerGroup = keyof typeof MCP_STATUS_COLORS;
const GROUPS: readonly ServerGroup[] = ['connected', 'pending', 'needs-auth', 'failed', 'disabled'];
const GROUP_LABELS: Record<ServerGroup, string> = { connected: 'Connected', pending: 'Connecting', 'needs-auth': 'Needs you', failed: 'Failed', disabled: 'Disabled' };
const GROUP_TITLES: Record<ServerGroup, string> = {
  connected: 'Claude can use their tools',
  pending: 'Still connecting',
  'needs-auth': 'Waiting for you to sign in, or to approve them',
  failed: 'Could not connect',
  disabled: 'Disabled in your Claude Code settings',
};
/** How strongly the line from Claude to a server shows, by how it connected. */
const LINK_ALPHA: Record<ServerGroup, number> = { connected: 0.34, pending: 0.22, 'needs-auth': 0.2, failed: 0.14, disabled: 0.08 };
const MCP_SCOPES: Record<string, string> = {
  user: 'your settings',
  project: "the workspace's .mcp.json",
  local: 'this workspace, for you',
  claudeai: 'claude.ai connector',
  dynamic: 'a plugin',
  enterprise: 'your organisation',
};
const TRANSPORTS: Record<string, string> = { stdio: 'local process', http: 'HTTP', sse: 'SSE', ws: 'WebSocket', 'claudeai-proxy': 'through claude.ai', sdk: 'SDK' };
const ACTION_LABELS: Record<McpAction, string> = { reconnect: 'Reconnect', enable: 'Enable', disable: 'Disable', signIn: 'Sign in', signOut: 'Sign out' };
const ACTION_PENDING: Record<McpAction, string> = { reconnect: 'Reconnecting…', enable: 'Enabling…', disable: 'Disabling…', signIn: 'Signing in…', signOut: 'Signing out…' };
const ACTION_TITLES: Record<McpAction, string> = {
  reconnect: 'Connect to it again',
  enable: 'Enable it in your Claude Code settings, as /mcp does',
  disable: 'Disable it in your Claude Code settings, as /mcp does: Claude goes without it',
  signIn: 'Open the page to sign in on, in your browser',
  signOut: 'Forget the sign-in Claude Code keeps for it',
};
/** Tools drawn around a connected server; the detail line names them all. */
const MAX_SATELLITES = 16;

/**
 * The panel above the composer that the Skills and History toggles, and the sheet's MCP button, open, drawn as a small
 * constellation.
 *
 * Skills: one tesseract per skill Claude Code offers here, turning in four dimensions, gathered around a star for where
 * it comes from (this workspace, the user's own, a plugin); lines join skills whose instructions name each other. A
 * skill is dragged out of the panel onto the composer, or clicked, to attach it to the prompt.
 *
 * History: one gyroscope per earlier conversation of this workspace, oldest on the left; lines join conversations that
 * worked on the same files. Clicking one opens it in the history panel.
 *
 * MCP: one 16-cell per MCP server Claude Code loads here, on a ring around Claude and coloured by how it connected, a
 * connected one with its tools around it. Clicking one offers what `/mcp` would: reconnect, sign in or out, enable or
 * disable. Reload starts every server afresh.
 *
 * The glyphs are WebGL on a canvas over the whole viewport (ConstellationView); what takes the pointer and the keyboard
 * are transparent buttons kept over each glyph, so picking is the browser's own hit testing.
 */
export class Constellation {
  private readonly root = el('div', 'constellation');
  private readonly panel = el('section', 'constellation-panel');
  private readonly title = el('h2', 'constellation-title');
  private readonly sub = el('p', 'constellation-sub');
  private readonly keys = el('ul', 'constellation-keys');
  private readonly refreshButton = button('Refresh', 'link-button constellation-refresh');
  private readonly fitButton = button('Fit', 'link-button constellation-fit', 'Show the whole constellation again (double-click the field does too)');
  private readonly closeButton = button('', 'sv-close constellation-close', 'Close (Esc)');
  private readonly field = el('div', 'constellation-field');
  private readonly targets = el('div', 'constellation-targets');
  private readonly empty = el('p', 'constellation-empty');
  private readonly detailTitle = el('p', 'cd-title');
  private readonly detailMeta = el('p', 'cd-meta');
  private readonly detailText = el('p', 'cd-text');
  private readonly detailOpen = button('Open SKILL.md', 'link-button cd-open');
  private readonly detailActions = el('div', 'cd-actions');
  private readonly dragLabel = el('div', 'skill-drag-label');
  private readonly range = new TimeRange(() => this.rangeChanged());
  private readonly view: ConstellationView;

  private current: ConstellationMode | undefined;
  private leavingAt: number | undefined;
  private openedAt = 0;
  private time = 0;
  private frames = 0;
  private items: Item[] = [];
  private links: Link[] = [];
  private layout = new ForceLayout([], []);
  private hovered: Item | undefined;
  /** The item the detail line describes once the pointer has moved on, so its link can still be clicked. */
  private selected: Item | undefined;
  /** The MCP server clicked: its detail and buttons stay while the pointer passes other glyphs on its way to them. */
  private pinned: Item | undefined;
  private drag: { item: Item; target: HTMLButtonElement; pointerId: number; x: number; y: number; moved: boolean; over: boolean } | undefined;
  private suppressClick = false;
  private catalog: AgentCatalog | undefined;
  private history: HistorySnapshot = { loading: false, conversations: [] };
  private conversationId: string | undefined;
  private readonly attached = new Set<string>();
  private skillSignature = '';
  private historySignature = '';
  private mcpSignature = '';
  /** The MCP buttons last drawn, so a catalog that changes nothing about them does not replace them under the pointer. */
  private actionsSignature = '';
  private orbit = 0;
  private distance = 0;
  private motion: Animation | undefined;
  /** The text typed after a slash in the composer, lower-cased; '' shows every skill. */
  private filter = '';
  /** Skills that answer the filter, best first; the first is what Enter attaches unless the arrows moved the pick. */
  private matches: Item[] = [];
  private highlighted: Item | undefined;
  /** The wheel zooms in from 1 (the whole graph fits) up to MAX_ZOOM, toward the pointer; `centre` is what the camera looks at. */
  private zoom = 1;
  private zoomTarget = 1;
  private readonly centre = { x: 0, y: 0, z: 0 };
  private readonly centreTarget = { x: 0, y: 0, z: 0 };
  /** Half extents of the graph, for keeping the centre over it. */
  private extent = { across: 6, up: 4 };
  private pan: { pointerId: number; x: number; y: number } | undefined;
  private labelScale = 1;

  constructor(
    mount: HTMLElement,
    canvasHost: HTMLElement,
    private readonly events: ConstellationEvents,
  ) {
    this.root.hidden = true;
    this.panel.setAttribute('role', 'dialog');
    this.closeButton.setAttribute('aria-label', 'Close');
    const heading = el('div', 'constellation-heading');
    heading.append(this.title, this.sub);
    const head = el('header', 'constellation-head');
    head.append(heading, this.keys, this.fitButton, this.refreshButton, this.closeButton);
    this.fitButton.hidden = true;
    this.empty.setAttribute('aria-live', 'polite');
    this.field.append(this.targets, this.empty);
    const detailHead = el('div', 'cd-head');
    detailHead.append(this.detailTitle, this.detailOpen, this.detailActions);
    this.detailActions.hidden = true;
    const detail = el('footer', 'constellation-detail');
    detail.append(detailHead, this.detailMeta, this.detailText);
    this.range.element.hidden = true;
    this.panel.append(head, this.field, this.range.element, detail);
    this.root.append(this.panel);
    mount.append(this.root);

    this.dragLabel.hidden = true;
    this.dragLabel.setAttribute('aria-hidden', 'true');
    canvasHost.append(this.dragLabel);
    this.view = new ConstellationView(canvasHost, () => {
      this.root.dataset.webgl = 'off';
      events.wake();
    });

    this.closeButton.addEventListener('click', () => this.close());
    this.refreshButton.addEventListener('click', () => this.current && events.refresh(this.current));
    this.fitButton.addEventListener('click', () => this.resetZoom());
    // The wheel over the field zooms the constellation, not the graph behind the panel.
    this.field.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0016)), event.clientX, event.clientY);
      },
      { passive: false },
    );
    this.field.addEventListener('pointerdown', (event) => this.startPan(event));
    this.field.addEventListener('dblclick', (event) => {
      if (event.target === this.field || event.target === this.targets) this.resetZoom();
    });
    this.detailOpen.addEventListener('click', () => {
      const file = (this.hovered ?? this.selected)?.skill?.file;
      if (file) events.openFile(file);
    });
  }

  get mode(): ConstellationMode | undefined {
    return this.current;
  }

  /** Read by tools/harness/harness.mjs. */
  get debug(): {
    mode: ConstellationMode | undefined;
    glyphs: number;
    links: number;
    frames: number;
    webgl: boolean;
    filter: string;
    matches: string[];
    highlighted: string | undefined;
    zoom: number;
    range: [number, number] | undefined;
    pinned: string | undefined;
  } {
    return {
      range: this.range.bounds,
      mode: this.current,
      glyphs: this.items.filter((item) => item.kind !== 'hub' && item.kind !== 'tool').length,
      links: this.links.length,
      frames: this.frames,
      webgl: this.root.dataset.webgl !== 'off',
      filter: this.filter,
      matches: this.matches.map((item) => item.skill?.name ?? ''),
      highlighted: this.highlighted?.skill?.name,
      zoom: this.zoomTarget,
      pinned: this.pinned?.server?.name,
    };
  }

  /**
   * Narrows the skills to those answering `query`, the text typed after a slash in the composer: by name first, then
   * by description, then by the letters of the name in order. The others dim away, and the best match is what Enter attaches.
   */
  setFilter(query: string): void {
    const filter = query.trim().toLowerCase();
    if (filter === this.filter) return;
    this.filter = filter;
    this.applyFilter();
    this.renderHead();
    this.renderDetail();
    this.events.wake();
  }

  /** Moves the keyboard pick among the filtered skills, wrapping around. */
  moveHighlight(delta: number): void {
    if (this.matches.length === 0) return;
    const at = this.highlighted ? this.matches.indexOf(this.highlighted) : -1;
    this.highlighted = this.matches[(at + delta + this.matches.length) % this.matches.length];
    this.renderDetail();
    this.events.wake();
  }

  /** The skill Enter attaches while filtering, if any. */
  highlightedSkill(): string | undefined {
    return this.filter ? this.highlighted?.skill?.name : undefined;
  }

  resetZoom(): void {
    this.zoomTarget = 1;
    Object.assign(this.centreTarget, { x: 0, y: 0, z: 0 });
    this.events.wake();
  }

  /** Opens out of `from` (the toggle), or switches to `mode` in place when another one is open. */
  open(mode: ConstellationMode, from?: DOMRect): void {
    const switching = this.current !== undefined;
    this.cancelDrag();
    this.current = mode;
    this.leavingAt = undefined;
    this.openedAt = this.time;
    this.root.hidden = false;
    this.root.dataset.mode = mode;
    this.panel.setAttribute('aria-label', mode === 'skills' ? 'Skills' : mode === 'history' ? 'Conversation history' : 'MCP servers');
    if (!this.view.ready) this.root.dataset.webgl = 'off';
    this.hovered = this.selected = this.pinned = undefined;
    this.items = [];
    this.distance = 0;
    this.zoom = this.zoomTarget = 1;
    Object.assign(this.centre, { x: 0, y: 0, z: 0 });
    Object.assign(this.centreTarget, { x: 0, y: 0, z: 0 });
    this.endPan();
    this.rebuild();
    this.view.setVisible(true);
    this.motion?.cancel();
    if (!reducedMotion()) {
      if (switching) {
        this.motion = this.field.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
      } else {
        const clip = this.clipFrom(from);
        this.motion = this.panel.animate([{ clipPath: clip.from, opacity: 0.35 }, { clipPath: clip.to, opacity: 1 }], { duration: 540, easing: SHEET_EASE });
      }
    }
    this.events.wake();
  }

  close(): void {
    if (!this.current) return;
    this.cancelDrag();
    this.endPan();
    this.current = undefined;
    this.hovered = undefined;
    this.pinned = undefined;
    this.filter = '';
    this.matches = [];
    this.highlighted = undefined;
    this.leavingAt = this.time;
    this.motion?.cancel();
    this.events.closed();
    if (reducedMotion()) {
      this.hide();
      return;
    }
    const motion = this.panel.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: 'translateY(16px) scale(0.97)', opacity: 0 },
      ],
      { duration: LEAVE_S * 1000, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    );
    this.motion = motion;
    motion.onfinish = () => {
      if (!this.current) this.root.hidden = true;
      motion.cancel();
    };
    this.events.wake();
  }

  setCatalog(catalog: AgentCatalog): void {
    this.catalog = catalog;
    const signature = catalog.skills.map((skill) => `${skill.scope}:${skill.name}>${skill.references.join(',')}`).join('|');
    const changed = signature !== this.skillSignature;
    this.skillSignature = signature;
    // What the MCP graph is built from; a note or `checkedAt` alone only changes the words.
    const servers = catalog.mcpServers.map((server) => `${server.name}:${server.status}:${server.tools}:${server.toolNames?.length ?? 0}:${server.pending ?? ''}`).join('|');
    const serversChanged = servers !== this.mcpSignature;
    this.mcpSignature = servers;
    if (this.current === 'skills') {
      if (changed) this.rebuild();
      else this.renderHead();
    } else if (this.current === 'mcp') {
      if (serversChanged) this.rebuild();
      else {
        this.renderHead();
        this.renderDetail();
      }
    }
  }

  setHistory(history: HistorySnapshot): void {
    this.history = history;
    this.range.setTimes(history.conversations.map((conversation) => conversation.updatedAt));
    const signature =history.conversations.map((conversation) => `${conversation.id}@${conversation.updatedAt}`).join('|');
    const changed = signature !== this.historySignature;
    this.historySignature = signature;
    if (this.current === 'history') {
      if (changed) this.rebuild();
      else this.renderHead();
    }
  }

  /** The conversation in Orbit now, marked among the history. */
  setConversation(id: string | undefined): void {
    if (id === this.conversationId) return;
    this.conversationId = id;
    if (this.current === 'history') this.rebuild();
  }

  /** Skills attached to the prompt wear a ring. */
  setAttached(names: readonly string[]): void {
    this.attached.clear();
    for (const name of names) this.attached.add(name);
    for (const item of this.items) {
      if (!item.skill) continue;
      item.ring = this.attached.has(item.skill.name) ? 1 : 0;
      if (item.target) item.target.dataset.attached = String(item.ring === 1);
    }
    this.renderDetail();
    this.events.wake();
  }

  /** Esc while dragging puts the skill back. True if a drag was cancelled. */
  cancelDrag(): boolean {
    const drag = this.drag;
    if (!drag) return false;
    try {
      drag.target.releasePointerCapture(drag.pointerId);
    } catch {
      // Already released.
    }
    this.endDrag(false);
    return true;
  }

  /** Advances and draws one frame. True while the panel is open or folding away. */
  frame(dt: number): boolean {
    if (!this.current && this.leavingAt === undefined) return false;
    this.time += dt;
    const fade = this.leavingAt === undefined ? 1 : 1 - (this.time - this.leavingAt) / LEAVE_S;
    if (fade <= 0) {
      this.hide();
      return false;
    }
    for (const item of this.items) {
      if (item.slideTo === undefined) continue;
      const anchor = item.node.anchor;
      anchor[0] += (item.slideTo - anchor[0]) * Math.min(1, dt * 7);
      if (Math.abs(item.slideTo - anchor[0]) < 0.01) {
        anchor[0] = item.slideTo;
        item.slideTo = undefined;
      }
      item.node.x = anchor[0];
    }
    this.layout.step();
    // Unfold quickly at first, then settle at the usual pace.
    if (this.time - this.openedAt < 0.8) this.layout.step();

    const rect = this.field.getBoundingClientRect();
    this.view.place(window.innerWidth, window.innerHeight, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    let across = 6;
    let up = 4;
    // However few the glyphs, the field frames at least this much.
    const points: FitPoint[] = [
      { x: -across, y: -up, z: 0, pad: 0 },
      { x: across, y: up, z: 0, pad: 0 },
    ];
    for (const item of this.items) {
      if (item === this.drag?.item) continue;
      const pad = item.kind === 'hub' ? 2.5 : item.size * 1.4;
      across = Math.max(across, Math.hypot(item.node.x, item.node.z) + pad);
      up = Math.max(up, Math.abs(item.node.y) + pad);
      points.push({ x: item.node.x, y: item.node.y, z: item.node.z, pad });
    }
    this.extent = { across, up };
    const sway = this.current === 'history' ? HISTORY_SWAY : SKILLS_SWAY;
    // Framed for the whole sway, so the distance holds steady while the graph turns.
    const fit = this.view.fitDistance(points, [-sway, -sway / 2, 0, sway / 2, sway], ELEVATION, FIT_MARGIN);
    // Zooming in brings the camera closer to the spot zoomed toward, and the graph holds still meanwhile.
    const zoomEase = Math.min(1, dt * 8);
    this.zoom += (this.zoomTarget - this.zoom) * zoomEase;
    if (Math.abs(this.zoomTarget - this.zoom) < 0.002) this.zoom = this.zoomTarget;
    const centreEase = this.pan ? 1 : zoomEase;
    this.centre.x += (this.centreTarget.x - this.centre.x) * centreEase;
    this.centre.y += (this.centreTarget.y - this.centre.y) * centreEase;
    this.centre.z += (this.centreTarget.z - this.centre.z) * centreEase;
    const wanted = fit / this.zoom;
    this.distance = this.distance > 0 ? this.distance + (wanted - this.distance) * Math.min(1, dt * (this.zoom === this.zoomTarget ? 2.5 : 8)) : wanted;
    // The graph turns slowly, and holds still while a glyph is pointed at or held, or the view is zoomed in.
    if (!this.drag && !this.hovered && this.zoomTarget <= 1.02 && !reducedMotion()) this.orbit += dt * 0.09;
    this.view.aim(this.distance, Math.sin(this.orbit) * sway, ELEVATION, this.centre);
    const labelScale = Math.min(1.7, Math.max(1, Math.sqrt(this.zoom)));
    if (Math.abs(labelScale - this.labelScale) > 0.005) {
      this.labelScale = labelScale;
      this.field.style.setProperty('--label-scale', labelScale.toFixed(3));
    }
    this.fitButton.hidden = this.zoomTarget <= 1.02;
    this.field.dataset.zoomed = String(this.zoomTarget > 1.02);

    const focus = this.drag?.item ?? this.hovered ?? this.highlighted ?? this.pinned;
    const tesseracts: GlyphInstance[] = [];
    const gyroscopes: GlyphInstance[] = [];
    const stations: GlyphInstance[] = [];
    const cores: CoreInstance[] = [];
    const shown = (item: Item) => ease((this.time - item.appearAt) / APPEAR_S) * fade;
    for (const item of this.items) {
      item.emphasis += ((item === focus ? 1 : 0) - item.emphasis) * Math.min(1, dt * 9);
      item.dim += ((item.match > 0 ? 1 : DIMMED) - item.dim) * Math.min(1, dt * 8);
      const appear = shown(item);
      const { x, y, z } = item.node;
      const size = item.size * (0.55 + 0.45 * item.dim);
      const glyph = { x, y, z, size, phase: item.phase, emphasis: item.emphasis, appear, color: item.color, alpha: item.dim };
      if (item.kind === 'skill') tesseracts.push(glyph);
      else if (item.kind === 'conversation') gyroscopes.push(glyph);
      else if (item.kind === 'server') stations.push(glyph);
      const coreSize = item.kind === 'hub' ? 2.2 : item.kind === 'tool' ? size : size * 0.85;
      cores.push({ x, y, z, size: coreSize, appear, emphasis: item.emphasis, ring: item.ring, color: item.color, alpha: (item.kind === 'hub' ? 1 : 0.7) * item.dim });
    }
    const links: LinkInstance[] = this.links.map((link) => {
      const a = this.items[link.a];
      const b = this.items[link.b];
      const lit = a === focus || b === focus ? 2 : 1;
      return { from: a.node, to: b.node, color: link.color, alpha: link.alpha * Math.min(shown(a), shown(b)) * Math.min(a.dim, b.dim) * lit, width: link.width, flow: link.flow, seed: link.seed };
    });
    // Kept to the field, but for a skill being dragged out of it to the composer.
    this.view.render(this.time, { tesseracts, gyroscopes, stations }, cores, links, !this.drag?.moved);
    this.placeTargets(rect, fade);
    this.frames++;
    return true;
  }

  /** Zooms by `factor` about the client point (x, y): what is under the pointer stays where it is on screen. */
  private zoomBy(factor: number, x: number, y: number): void {
    const before = this.zoomTarget;
    const after = Math.min(MAX_ZOOM, Math.max(1, before * factor));
    if (after === before) return;
    this.zoomTarget = after;
    if (after <= 1) {
      Object.assign(this.centreTarget, { x: 0, y: 0, z: 0 });
    } else {
      // The spot under the pointer, on the plane through the centre facing the camera.
      const at = this.view.unproject(x, y, this.centreTarget);
      const keep = before / after;
      this.centreTarget.x = at.x + (this.centreTarget.x - at.x) * keep;
      this.centreTarget.y = at.y + (this.centreTarget.y - at.y) * keep;
      this.centreTarget.z = at.z + (this.centreTarget.z - at.z) * keep;
      this.clampCentre();
    }
    this.events.wake();
  }

  /** The centre stays over the graph, so zooming and panning cannot lose it. */
  private clampCentre(): void {
    const { across, up } = this.extent;
    this.centreTarget.x = Math.max(-across, Math.min(across, this.centreTarget.x));
    this.centreTarget.y = Math.max(-up, Math.min(up, this.centreTarget.y));
    this.centreTarget.z = Math.max(-across, Math.min(across, this.centreTarget.z));
  }

  /** A drag on the field itself, zoomed in, moves the view; glyphs take their own pointer. */
  private startPan(down: PointerEvent): void {
    if (down.button !== 0 || this.pan || this.drag || this.zoomTarget <= 1.02) return;
    if (down.target !== this.field && down.target !== this.targets) return;
    this.field.setPointerCapture(down.pointerId);
    this.pan = { pointerId: down.pointerId, x: down.clientX, y: down.clientY };
    this.field.dataset.panning = 'true';
    const move = (event: PointerEvent) => {
      const pan = this.pan;
      if (!pan || event.pointerId !== pan.pointerId) return;
      const from = this.view.unproject(pan.x, pan.y, this.centreTarget);
      const to = this.view.unproject(event.clientX, event.clientY, this.centreTarget);
      this.centreTarget.x -= to.x - from.x;
      this.centreTarget.y -= to.y - from.y;
      this.centreTarget.z -= to.z - from.z;
      this.clampCentre();
      pan.x = event.clientX;
      pan.y = event.clientY;
      this.events.wake();
    };
    const end = () => {
      this.field.removeEventListener('pointermove', move);
      this.field.removeEventListener('pointerup', end);
      this.field.removeEventListener('pointercancel', end);
      this.endPan();
    };
    this.field.addEventListener('pointermove', move);
    this.field.addEventListener('pointerup', end);
    this.field.addEventListener('pointercancel', end);
  }

  private endPan(): void {
    const pan = this.pan;
    this.pan = undefined;
    delete this.field.dataset.panning;
    if (!pan) return;
    try {
      this.field.releasePointerCapture(pan.pointerId);
    } catch {
      // Already released.
    }
  }

  /** Scores every skill against the filter, dims the hubs whose skills all miss, and picks the best match for Enter. */
  private applyFilter(): void {
    const filter = this.filter;
    const scopesHit = new Set<SkillScope>();
    for (const item of this.items) {
      if (!item.skill) continue;
      item.match = filter ? skillMatch(item.skill, filter) : 1;
      if (item.match > 0 && item.scope) scopesHit.add(item.scope);
    }
    for (const item of this.items) {
      if (item.kind === 'hub') item.match = !filter || (item.scope !== undefined && scopesHit.has(item.scope)) ? 1 : 0;
      if (item.target && item.match === 0) item.target.dataset.shown = 'false';
    }
    this.matches = filter
      ? this.items
          .filter((item) => item.skill && item.match > 0)
          .sort((a, b) => b.match - a.match || (a.skill?.name ?? '').localeCompare(b.skill?.name ?? ''))
      : [];
    this.highlighted = this.matches[0];
  }

  private hide(): void {
    this.leavingAt = undefined;
    this.root.hidden = true;
    this.view.setVisible(false);
  }

  /** Builds the graph for the current mode. Items that were already there keep their place and do not appear again. */
  private rebuild(): void {
    this.cancelDrag();
    const previous = new Map(this.items.map((item) => [item.key, item]));
    const graph = this.current === 'history' ? this.historyGraph() : this.current === 'mcp' ? this.mcpGraph() : this.skillGraph();
    this.targets.replaceChildren();
    let fresh = 0;
    for (const item of graph.items) {
      const before = previous.get(item.key);
      if (before) {
        Object.assign(item.node, { x: before.node.x, y: before.node.y, z: before.node.z });
        // A conversation pinned to its place in time glides to its new one from where it was.
        if (item.node.pull[0] >= 1 && item.node.anchor[0] !== before.node.anchor[0] && !reducedMotion()) {
          item.slideTo = item.node.anchor[0];
          item.node.anchor[0] = before.node.anchor[0];
        }
        item.appearAt = before.appearAt;
        item.emphasis = before.emphasis;
        item.dim = before.dim;
      } else {
        // A server's tools come in just after it, without holding up the servers after it.
        item.appearAt = this.time + 0.14 + (item.kind === 'tool' ? (fresh + 4) * STAGGER_S : fresh++ * STAGGER_S);
      }
      if (item.target) {
        this.bind(item, item.target);
        this.targets.append(item.target);
      }
      if (item.tag) this.targets.append(item.tag);
    }
    const kept = graph.items.some((item) => previous.has(item.key));
    this.items = graph.items;
    this.links = graph.links;
    this.layout = new ForceLayout(
      graph.items.map((item) => item.node),
      graph.forces,
    );
    if (kept) this.layout.alpha = 0.5;
    if (reducedMotion()) this.layout.settle(400);
    const same = (item: Item | undefined) => (item ? this.items.find((candidate) => candidate.key === item.key) : undefined);
    this.hovered = same(this.hovered);
    this.selected = same(this.selected);
    this.pinned = same(this.pinned);
    const highlighted = same(this.highlighted);
    this.applyFilter();
    if (highlighted && this.matches.includes(highlighted)) this.highlighted = highlighted;
    this.renderHead();
    this.renderDetail();
    this.events.wake();
  }

  private skillGraph(): Graph {
    const skills = this.catalog?.skills ?? [];
    const items: Item[] = [];
    const links: Link[] = [];
    const forces: ForceLink[] = [];
    const scopes = SCOPES.filter((scope) => skills.some((skill) => skill.scope === scope));
    const hubs = new Map<SkillScope, number>();
    scopes.forEach((scope, k) => {
      // The scopes spread across the panel, which is wider than it is tall.
      const angle = Math.PI + (k * 2 * Math.PI) / scopes.length;
      const spread = scopes.length === 1 ? 0 : 16;
      const anchor: [number, number, number] = [Math.cos(angle) * spread, Math.sin(angle) * spread * 0.45, 0];
      const tag = el('span', 'constellation-label constellation-hub', SCOPE_LABELS[scope]);
      tag.style.setProperty('--key', cssColor(SCOPE_COLORS[scope]));
      hubs.set(scope, items.length);
      items.push(makeItem({ key: `hub:${scope}`, kind: 'hub', color: SCOPE_COLORS[scope], size: 1, at: anchor, anchor, pull: [0.06, 0.06, 0.06], charge: 50, tag, scope }));
    });
    for (const skill of skills) {
      const hub = hubs.get(skill.scope);
      if (hub === undefined) continue;
      const seed = seeded(skill.name);
      const anchor = items[hub].node.anchor;
      const target = button('', 'skill-node');
      target.dataset.skill = skill.name;
      target.dataset.attached = String(this.attached.has(skill.name));
      target.setAttribute('aria-label', `/${skill.name}, ${SCOPE_LABELS[skill.scope].toLowerCase()}: ${skill.description} Press Enter to attach it to the prompt, or drag it there.`);
      const siblings = skills.filter((other) => other.scope === skill.scope).length;
      const index = items.length;
      items.push(
        makeItem({
          key: `skill:${skill.name}`,
          kind: 'skill',
          color: SCOPE_COLORS[skill.scope],
          size: 2.2,
          at: [anchor[0] + (seed[0] - 0.5) * 2, anchor[1] + (seed[1] - 0.5) * 2, (seed[2] - 0.5) * 2],
          anchor,
          // Kept near the plane facing the camera, so glyphs of one scope do not hide behind each other.
          pull: [0.004, 0.006, 0.05],
          charge: 48,
          phase: seed[0] * 20,
          ring: this.attached.has(skill.name) ? 1 : 0,
          target,
          // The hub already says Plugins; the name after the plugin's is enough.
          tag: el('span', 'constellation-label', skill.name.slice(skill.name.indexOf(':') + 1)),
          skill,
          scope: skill.scope,
        }),
      );
      forces.push({ source: hub, target: index, distance: 6.5 + Math.sqrt(siblings) * 1.6, strength: 0.1 });
      links.push({ a: hub, b: index, color: SCOPE_COLORS[skill.scope], alpha: 0.2, width: 1.1, flow: 0, seed: seed[1] });
    }
    const byName = new Map(items.flatMap((item, k) => (item.skill ? [[item.skill.name, k] as const] : [])));
    const joined = new Set<string>();
    items.forEach((item, k) => {
      for (const name of item.skill?.references ?? []) {
        const other = byName.get(name);
        const pair = other === undefined ? '' : k < other ? `${k}:${other}` : `${other}:${k}`;
        if (other === undefined || other === k || joined.has(pair)) continue;
        joined.add(pair);
        forces.push({ source: k, target: other, distance: 8, strength: 0.035 });
        // Pulses travel from the skill that names another toward it.
        links.push({ a: k, b: other, color: SHARED, alpha: 0.34, width: 1.6, flow: 0.45, seed: (k * 0.37) % 1 });
      }
    });
    return { items, links, forces };
  }

  /** The conversations last active inside the time range, oldest first. */
  private shownConversations(): ConversationSummary[] {
    return this.history.conversations.filter((conversation) => this.range.includes(conversation.updatedAt)).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The time range moved: the timeline is built again once it keeps other conversations. */
  private rangeChanged(): void {
    if (this.current !== 'history') return;
    const shown = this.shownConversations().map((conversation) => conversation.id);
    const drawn = this.items.flatMap((item) => (item.conversation ? [item.conversation.id] : []));
    if (shown.join('|') !== drawn.join('|')) this.rebuild();
    this.events.wake();
  }

  private historyGraph(): Graph {
    const items: Item[] = [];
    const links: Link[] = [];
    const forces: ForceLink[] = [];
    const conversations = this.shownConversations();
    const n = conversations.length;
    const span = Math.max(20, n * 4.5);
    conversations.forEach((conversation, k) => {
      const x = n === 1 ? 0 : -span / 2 + (span * k) / (n - 1);
      const current = conversation.id === this.conversationId;
      const seed = seeded(conversation.id);
      const target = button('', 'history-node');
      target.dataset.conversation = conversation.id;
      target.setAttribute('aria-label', `${conversation.title}, ${relativeTime(conversation.updatedAt)}, ${plural(conversation.promptCount, 'prompt')}${current ? ', the conversation in Orbit now' : ''}. Open it`);
      items.push(
        makeItem({
          key: `conversation:${conversation.id}`,
          kind: 'conversation',
          color: current ? PALETTE.claudeCore : mix(OLDER, SCOPE_COLORS.project, n === 1 ? 1 : k / (n - 1)),
          size: 1.2 + 0.42 * Math.log2(1 + conversation.promptCount),
          at: [x, (seed[0] - 0.5) * 6, (seed[1] - 0.5) * 6],
          // Pinned to its place in time across; free to move up and down where files join it to others.
          anchor: [x, 0, 0],
          pull: [1, 0.02, 0.05],
          charge: 30,
          phase: seed[2] * 20,
          ring: current ? 1 : 0,
          target,
          tag: el('span', 'constellation-label constellation-when', relativeTime(conversation.updatedAt)),
          conversation,
        }),
      );
      if (k > 0) {
        forces.push({ source: k - 1, target: k, distance: span / Math.max(1, n - 1), strength: 0.02 });
        links.push({ a: k - 1, b: k, color: CHAIN, alpha: 0.16, width: 1, flow: 0, seed: 0 });
      }
    });
    // Conversations that worked on the same files: each keeps its three closest.
    const files = conversations.map((conversation) => new Set(conversation.files.map((file) => file.id)));
    const pairs: Array<{ a: number; b: number; overlap: number }> = [];
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        let shared = 0;
        for (const file of files[a]) if (files[b].has(file)) shared++;
        const union = files[a].size + files[b].size - shared;
        if (shared > 0) pairs.push({ a, b, overlap: shared / union });
      }
    }
    const degree = new Map<number, number>();
    for (const { a, b, overlap } of pairs.sort((x, y) => y.overlap - x.overlap)) {
      if (overlap < 0.08 || (degree.get(a) ?? 0) >= 3 || (degree.get(b) ?? 0) >= 3) continue;
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
      forces.push({ source: a, target: b, distance: 7, strength: 0.06 * overlap });
      links.push({ a, b, color: SHARED, alpha: 0.14 + 0.45 * overlap, width: 1 + 1.6 * overlap, flow: 0.25, seed: (a * 0.61) % 1 });
    }
    return { items, links, forces };
  }

  /**
   * Claude at the centre and a 16-cell per MCP server on a ring around it, the servers of one state side by side. Each
   * joins Claude by a line, pulsing out to a connected one, which carries its tools around it as sparks.
   */
  private mcpGraph(): Graph {
    const items: Item[] = [];
    const links: Link[] = [];
    const forces: ForceLink[] = [];
    const servers = [...(this.catalog?.mcpServers ?? [])].sort((a, b) => GROUPS.indexOf(groupOf(a.status)) - GROUPS.indexOf(groupOf(b.status)) || a.name.localeCompare(b.name));
    if (servers.length === 0) return { items, links, forces };
    const tag = el('span', 'constellation-label constellation-hub', 'Claude Code');
    tag.style.setProperty('--key', cssColor(PALETTE.claudeHalo));
    items.push(makeItem({ key: 'hub:claude', kind: 'hub', color: PALETTE.claudeHalo, size: 1, at: [0, 0, 0], anchor: [0, 0, 0], pull: [0.2, 0.2, 0.2], charge: 60, tag }));
    const n = servers.length;
    const radius = 8 + Math.sqrt(n) * 1.6;
    servers.forEach((server, k) => {
      const group = groupOf(server.status);
      const color = MCP_STATUS_COLORS[group];
      // Round from the left, connected servers first; the ring is flattened, as the panel is wider than it is tall.
      const angle = Math.PI - ((k + 0.5) / n) * 2 * Math.PI;
      const anchor: [number, number, number] = [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.5, 0];
      const seed = seeded(server.name);
      const target = button('', 'mcp-node');
      target.dataset.server = server.name;
      target.dataset.status = server.status;
      target.setAttribute('aria-label', `${server.name}, ${statusLabel(server.status)}${server.tools > 0 ? `, ${plural(server.tools, 'tool')}` : ''}. Show what can be done with it`);
      const index = items.length;
      items.push(
        makeItem({
          key: `server:${server.name}`,
          kind: 'server',
          color,
          size: 1.7 + 0.35 * Math.log2(1 + server.tools),
          at: [anchor[0] + (seed[0] - 0.5) * 2, anchor[1] + (seed[1] - 0.5) * 2, (seed[2] - 0.5) * 2],
          anchor,
          pull: [0.03, 0.03, 0.06],
          charge: 44,
          phase: seed[0] * 20,
          // An action under way wears a ring until the host says how it went.
          ring: server.pending ? 1 : 0,
          target,
          tag: el('span', 'constellation-label', server.name),
          server,
        }),
      );
      forces.push({ source: 0, target: index, distance: radius, strength: 0.06 });
      links.push({ a: 0, b: index, color, alpha: LINK_ALPHA[group], width: group === 'connected' ? 1.6 : 1.1, flow: group === 'connected' ? 0.5 : group === 'pending' ? 0.9 : 0, seed: seed[1] });
      if (group !== 'connected') return;
      const names = server.toolNames ?? [];
      const count = Math.min(MAX_SATELLITES, Math.max(names.length, server.tools));
      for (let t = 0; t < count; t++) {
        const around = angle + (t / count) * 2 * Math.PI;
        const reach = 3.2 + (t % 2) * 0.8;
        const spot: [number, number, number] = [anchor[0] + Math.cos(around) * reach, anchor[1] + Math.sin(around) * reach * 0.8, Math.sin(around * 1.7) * 1.2];
        const tool = items.length;
        items.push(makeItem({ key: `tool:${server.name}:${names[t] ?? t}`, kind: 'tool', color, size: 1.25, at: spot, anchor: spot, pull: [0.04, 0.04, 0.04], charge: 4 }));
        forces.push({ source: index, target: tool, distance: reach, strength: 0.25 });
        links.push({ a: index, b: tool, color, alpha: 0.2, width: 0.9, flow: 0.3, seed: (t * 0.37) % 1 });
      }
    });
    return { items, links, forces };
  }

  private bind(item: Item, target: HTMLButtonElement): void {
    const enter = () => this.hover(item);
    const leave = () => this.hover(undefined, item);
    target.addEventListener('pointerenter', enter);
    target.addEventListener('pointerleave', leave);
    target.addEventListener('focus', enter);
    target.addEventListener('blur', leave);
    target.addEventListener('click', () => {
      if (this.suppressClick) return;
      if (item.skill) this.choose(item);
      else if (item.conversation) this.events.openConversation(item.conversation, target.getBoundingClientRect());
      else if (item.server) this.pin(item);
    });
    if (item.skill) target.addEventListener('pointerdown', (event) => this.startDrag(item, target, event));
  }

  private hover(item: Item | undefined, leaving?: Item): void {
    if ((leaving && this.hovered !== leaving) || this.drag?.moved) return;
    this.hovered = item;
    if (item && !this.pinned) this.selected = item;
    this.renderDetail();
    this.events.wake();
  }

  /** An MCP server clicked: its detail and buttons stay while the pointer passes other glyphs on its way to them. */
  private pin(item: Item): void {
    this.pinned = this.selected = item;
    this.renderDetail();
    this.events.wake();
  }

  private choose(item: Item): void {
    if (!item.skill) return;
    this.events.attach(item.skill.name);
    // A flash past the usual emphasis, easing back.
    item.emphasis = 2.4;
    this.events.wake();
  }

  /** The glyph follows the pointer out of the panel, at its own depth; dropped on the composer, the skill is attached. */
  private startDrag(item: Item, target: HTMLButtonElement, down: PointerEvent): void {
    if (down.button !== 0 || this.drag) return;
    target.setPointerCapture(down.pointerId);
    this.drag = { item, target, pointerId: down.pointerId, x: down.clientX, y: down.clientY, moved: false, over: false };
    const move = (event: PointerEvent) => {
      const drag = this.drag;
      if (drag?.item !== item) return;
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_SLOP_PX) return;
        drag.moved = true;
        item.node.fixed = true;
        this.root.dataset.dragging = 'true';
        this.dragLabel.textContent = `/${item.skill?.name ?? ''}`;
        this.dragLabel.hidden = false;
        this.hovered = this.selected = item;
        this.renderDetail();
      }
      Object.assign(item.node, this.view.unproject(event.clientX, event.clientY, item.node));
      const drop = this.events.dropTarget();
      drag.over = drop !== undefined && event.clientX >= drop.left && event.clientX <= drop.right && event.clientY >= drop.top && event.clientY <= drop.bottom;
      this.events.dragState(drag.over ? 'over' : 'ready');
      this.dragLabel.style.transform = `translate(${event.clientX + 16}px, ${event.clientY + 14}px)`;
      this.events.wake();
    };
    const end = (event: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      if (this.drag?.item === item) this.endDrag(event.type === 'pointerup' && this.drag.over);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  private endDrag(drop: boolean): void {
    const drag = this.drag;
    this.drag = undefined;
    if (!drag) return;
    this.events.dragState(undefined);
    if (!drag.moved) return;
    delete this.root.dataset.dragging;
    this.dragLabel.hidden = true;
    // The click that ends a drag is not a click on the glyph.
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false), 0);
    drag.item.node.fixed = false;
    this.layout.reheat(0.35);
    if (drop) this.choose(drag.item);
    this.renderDetail();
    this.events.wake();
  }

  /** Keeps each button over its glyph, sized to it, and names each glyph where its name fits. */
  private placeTargets(rect: DOMRect, fade: number): void {
    const spots = new Map<Item, { x: number; y: number; pixels: number; shown: boolean; appear: number }>();
    for (const item of this.items) {
      const appear = ease((this.time - item.appearAt) / APPEAR_S) * fade;
      const at = this.view.project(item.node, item.kind === 'hub' ? 1.2 : item.size * 1.25);
      const x = at.x - rect.left;
      const y = at.y - rect.top;
      spots.set(item, { x, y, pixels: at.pixels, shown: at.inFront, appear });
      if (!item.target) continue;
      const radius = Math.max(14, Math.min(48, at.pixels));
      item.target.style.transform = `translate(${(x - radius).toFixed(1)}px, ${(y - radius).toFixed(1)}px)`;
      item.target.style.width = item.target.style.height = `${Math.round(radius * 2)}px`;
      item.target.dataset.shown = String(appear > 0.4 && at.inFront && item.match > 0);
    }

    // The glyph pointed at, held or picked is named first, then the other glyphs, then the scopes; a name that would
    // overlap one already placed stays hidden. A glyph's name sits under it, a scope's over its star. Zoomed in, there is
    // room for more names, and the filter names what it keeps.
    const focus = this.drag?.item ?? this.hovered ?? this.highlighted ?? this.pinned;
    const labelAll = this.items.filter((item) => item.kind !== 'hub' && item.tag && item.match > 0).length <= MAX_LABELS * this.zoom * this.zoom;
    const rank = (item: Item) => (item === focus ? 3 : item.kind === 'hub' ? 1 : 2);
    const glyphChar = 6.4 * this.labelScale;
    const hubChar = 7.6 * this.labelScale;
    const lineHeight = 15 * this.labelScale;
    const placed: Array<readonly [number, number, number, number]> = [];
    for (const item of [...this.items].sort((a, b) => rank(b) - rank(a))) {
      const spot = spots.get(item);
      if (!item.tag || !spot) continue;
      const top = item.kind === 'hub' ? spot.y - Math.max(10, spot.pixels) - 3 - lineHeight : spot.y + Math.max(10, spot.pixels) + 3;
      const half = ((item.tag.textContent?.length ?? 0) * (item.kind === 'hub' ? hubChar : glyphChar) + 8) / 2;
      const box = [spot.x - half, top, spot.x + half, top + lineHeight] as const;
      const clear = !placed.some(([left, upper, right, lower]) => box[0] < right && box[2] > left && box[1] < lower && box[3] > upper);
      const visible = item.match > 0 && (item.kind === 'hub' || labelAll || item === focus) && clear && spot.appear > 0.3 && spot.shown;
      item.tag.hidden = !visible;
      if (!visible) continue;
      placed.push(box);
      item.tag.style.opacity = spot.appear.toFixed(2);
      item.tag.style.transform = `translate(${spot.x.toFixed(1)}px, ${top.toFixed(1)}px) translateX(-50%)`;
    }
  }

  private renderHead(): void {
    this.keys.replaceChildren();
    this.range.element.hidden = this.current !== 'history' || !this.range.usable;
    if (this.current === 'history') {
      const count = this.history.conversations.length;
      const shown = this.shownConversations().length;
      this.title.textContent = 'History';
      this.sub.textContent =
        count === 0 ? '' : this.range.bounds ? `${shown} of ${plural(count, 'earlier conversation')} last active in this range, oldest on the left` : `${plural(count, 'earlier conversation')} in this workspace, oldest on the left`;
      if (count > 0) this.keys.append(key(OLDER, 'Older'), key(SCOPE_COLORS.project, 'Recent'), key(SHARED, 'Same files', 'Joins conversations that read or edited the same files'));
      if (this.history.conversations.some((conversation) => conversation.id === this.conversationId)) this.keys.append(key(PALETTE.claudeCore, 'In Orbit now'));
      this.setRefresh('Refresh', undefined, this.history.loading);
      this.empty.textContent =
        shown > 0 ? '' : count > 0 ? 'No conversation was last active in this range. Widen it, or choose All.' : this.history.loading ? 'Reading earlier conversations…' : this.history.error ? `Could not read them: ${this.history.error}` : 'No earlier Claude Code conversations in this workspace yet.';
    } else if (this.current === 'mcp') {
      const servers = this.catalog?.mcpServers ?? [];
      const mcp = this.catalog?.mcp;
      this.title.textContent = 'MCP servers';
      this.sub.textContent = mcp?.loading
        ? 'Starting every MCP server afresh…'
        : mcp?.error && servers.length > 0
          ? `Reload failed: ${mcp.error}`
          : servers.length === 0
            ? ''
            : `${plural(servers.length, 'server')} Claude Code loads here${mcp?.checkedAt ? `, checked ${relativeTime(mcp.checkedAt)}` : ''}. Click one to change it.`;
      for (const group of GROUPS) {
        const count = servers.filter((server) => groupOf(server.status) === group).length;
        if (count > 0) this.keys.append(key(MCP_STATUS_COLORS[group], `${GROUP_LABELS[group]} ${count}`, GROUP_TITLES[group]));
      }
      this.setRefresh('Reload', 'Start every MCP server afresh, picking up servers added since, and ask how each connected', mcp?.loading === true);
      this.empty.textContent =
        servers.length > 0
          ? ''
          : mcp?.loading
            ? 'Starting the MCP servers…'
            : mcp?.error
              ? `Claude Code could not be asked: ${mcp.error}`
              : this.catalog?.loading
                ? 'Asking Claude Code which MCP servers it loads…'
                : 'No MCP servers here. Add one with claude mcp add, or in .mcp.json in this workspace, then Reload.';
    } else {
      const skills = this.catalog?.skills ?? [];
      const loading = this.catalog?.loading ?? false;
      this.title.textContent = 'Skills';
      this.sub.textContent =
        skills.length === 0
          ? ''
          : this.filter
            ? `${this.matches.length} of ${plural(skills.length, 'skill')} match /${this.filter}. Enter attaches the picked one, ↑↓ move the pick.`
            : `${plural(skills.length, 'skill')} Claude Code offers here. Type / in the prompt to find one.`;
      for (const scope of SCOPES) {
        const count = skills.filter((skill) => skill.scope === scope).length;
        if (count > 0) this.keys.append(key(SCOPE_COLORS[scope], `${SCOPE_LABELS[scope]} ${count}`, `Skills from ${SCOPE_WHERE[scope]}`));
      }
      this.setRefresh('Refresh', undefined, loading);
      this.empty.textContent =
        skills.length > 0
          ? this.filter && this.matches.length === 0
            ? `No skill matches /${this.filter}. Enter sends the prompt as typed.`
            : ''
          : loading
            ? 'Asking Claude Code which skills it offers…'
            : this.catalog?.error
              ? `Claude Code could not be asked: ${this.catalog.error}`
              : 'No skills yet. Add one as .claude/skills/<name>/SKILL.md in this workspace, or in ~/.claude/skills for every workspace.';
    }
    this.empty.hidden = this.empty.textContent === '';
  }

  private setRefresh(label: string, title: string | undefined, busy: boolean): void {
    this.refreshButton.textContent = label;
    if (title) this.refreshButton.title = title;
    else this.refreshButton.removeAttribute('title');
    this.refreshButton.disabled = busy;
  }

  private renderDetail(): void {
    const item = this.drag?.item ?? this.hovered ?? (this.filter ? this.highlighted : undefined) ?? this.pinned ?? this.selected;
    this.detailOpen.hidden = !item?.skill?.file;
    let server: McpServerInfo | undefined;
    if (item?.skill) {
      const { skill } = item;
      this.detailTitle.textContent = `/${skill.name}`;
      this.detailMeta.textContent = [
        skill.plugin ? `${SCOPE_LABELS[skill.scope]} · ${skill.plugin}` : SCOPE_LABELS[skill.scope],
        skill.argumentHint ? `takes ${skill.argumentHint}` : '',
        skill.references.length > 0 ? `names ${skill.references.map((name) => `/${name}`).join(', ')}` : '',
        this.attached.has(skill.name) ? 'attached' : item === this.highlighted && this.filter ? 'Enter attaches it' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      this.detailText.textContent = skill.description || 'No description.';
    } else if (item?.conversation) {
      const { conversation } = item;
      this.detailTitle.textContent = conversation.title;
      this.detailMeta.textContent = [relativeTime(conversation.updatedAt), plural(conversation.promptCount, 'prompt'), conversation.model, conversation.branch, conversation.id === this.conversationId ? 'in Orbit now' : '']
        .filter(Boolean)
        .join(' · ');
      this.detailText.textContent = conversation.prompts[0] ?? '';
    } else if (item?.server) {
      // The catalog's latest word on it: a note or a pending action can change without a rebuild.
      server = this.catalog?.mcpServers.find((candidate) => candidate.name === item.server?.name) ?? item.server;
      this.detailTitle.textContent = server.name;
      this.detailMeta.textContent = [
        statusLabel(server.status),
        server.scope ? (MCP_SCOPES[server.scope] ?? server.scope) : '',
        server.transport ? (TRANSPORTS[server.transport] ?? server.transport) : '',
        server.version ? `v${server.version}` : '',
        server.tools > 0 ? plural(server.tools, 'tool') : '',
      ]
        .filter(Boolean)
        .join(' · ');
      this.detailText.textContent = server.note ?? server.error ?? hintFor(server);
    } else if (this.current === 'history') {
      this.detailTitle.textContent = 'Earlier conversations';
      this.detailMeta.textContent = '';
      this.detailText.textContent = 'Each gyroscope is a conversation Claude Code kept for this workspace, sized by its prompts. Click one to open it and continue it.';
    } else if (this.current === 'mcp') {
      this.detailTitle.textContent = 'MCP servers';
      this.detailMeta.textContent = '';
      this.detailText.textContent =
        'Each 16-cell is an MCP server, joined to Claude and coloured by how it connected; a connected one has its tools around it. Click one to reconnect it, sign in, or enable or disable it.';
    } else {
      this.detailTitle.textContent = 'Attach a skill';
      this.detailMeta.textContent = '';
      this.detailText.textContent = 'Each tesseract is a skill. Drag one onto the prompt, or click it: Claude Code loads its SKILL.md with what you send. Lines join skills whose instructions name each other.';
    }
    this.renderActions(server);
  }

  /** The buttons for the server the detail describes, replaced only when they change, so a click under way is not lost. */
  private renderActions(server: McpServerInfo | undefined): void {
    const actions = server ? mcpActionsFor(server) : [];
    const signature = server ? `${server.name}|${server.pending ?? ''}|${actions.join(',')}` : '';
    if (signature === this.actionsSignature) return;
    this.actionsSignature = signature;
    this.detailActions.replaceChildren(
      ...actions.map((action) => {
        const control = button(server?.pending === action ? ACTION_PENDING[action] : ACTION_LABELS[action], 'link-button cd-action', ACTION_TITLES[action]);
        control.dataset.action = action;
        control.disabled = server?.pending !== undefined;
        control.addEventListener('click', () => {
          if (server) this.events.mcpAction(server.name, action);
        });
        return control;
      }),
    );
    this.detailActions.hidden = actions.length === 0;
  }

  /** Circle clips centred on the toggle: its own size, and large enough to uncover the whole panel. */
  private clipFrom(from: DOMRect | undefined): { from: string; to: string } {
    const box = this.panel.getBoundingClientRect();
    const cx = from ? from.left + from.width / 2 - box.left : box.width / 2;
    const cy = from ? from.top + from.height / 2 - box.top : box.height;
    const radius = Math.hypot(Math.max(cx, box.width - cx), Math.max(cy, box.height - cy)) + 8;
    return { from: `circle(14px at ${cx}px ${cy}px)`, to: `circle(${radius}px at ${cx}px ${cy}px)` };
  }
}

function makeItem(spec: {
  key: string;
  kind: Item['kind'];
  color: Rgb;
  size: number;
  at: [number, number, number];
  anchor: [number, number, number];
  pull: [number, number, number];
  charge: number;
  phase?: number;
  ring?: number;
  target?: HTMLButtonElement;
  tag?: HTMLElement;
  skill?: SkillInfo;
  conversation?: ConversationSummary;
  server?: McpServerInfo;
  scope?: SkillScope;
}): Item {
  const [x, y, z] = spec.at;
  return {
    key: spec.key,
    kind: spec.kind,
    color: spec.color,
    size: spec.size,
    node: { x, y, z, vx: 0, vy: 0, vz: 0, anchor: spec.anchor, pull: spec.pull, charge: spec.charge, fixed: false },
    appearAt: 0,
    emphasis: 0,
    ring: spec.ring ?? 0,
    phase: spec.phase ?? 0,
    match: 1,
    dim: 1,
    target: spec.target,
    tag: spec.tag,
    skill: spec.skill,
    conversation: spec.conversation,
    server: spec.server,
    scope: spec.scope,
  };
}

/**
 * How well a skill answers what was typed after the slash: 4 for a name starting with it (the part after a plugin's
 * prefix counts too), 3 for a name containing it, 2 for a description containing it, 1 for the letters of the name in
 * order (`gp` finds graph-pipeline), 0 for none of these.
 */
export function skillMatch(skill: SkillInfo, filter: string): number {
  const name = skill.name.toLowerCase();
  const short = name.slice(name.indexOf(':') + 1);
  if (name.startsWith(filter) || short.startsWith(filter)) return 4;
  if (name.includes(filter)) return 3;
  if (skill.description.toLowerCase().includes(filter)) return 2;
  let at = 0;
  for (const letter of filter) {
    at = short.indexOf(letter, at);
    if (at < 0) return 0;
    at++;
  }
  return 1;
}

/** What the MCP view offers for a server, as `/mcp` would; sign-out only where the transport keeps a sign-in (HTTP, SSE). */
export function mcpActionsFor(server: McpServerInfo): McpAction[] {
  const remote = server.transport === 'http' || server.transport === 'sse';
  switch (server.status) {
    case 'connected':
      return remote ? ['reconnect', 'signOut', 'disable'] : ['reconnect', 'disable'];
    case 'needs-auth':
      return ['signIn', 'disable'];
    case 'failed':
      return ['reconnect', 'disable'];
    case 'pending':
      return ['disable'];
    case 'disabled':
      return ['enable'];
    default:
      return ['reconnect'];
  }
}

/** Needs sign-in or approval together, and any state Orbit does not know with the disabled ones. */
function groupOf(status: string): ServerGroup {
  if (status === 'connected' || status === 'pending' || status === 'failed' || status === 'disabled') return status;
  return status.startsWith('needs-') ? 'needs-auth' : 'disabled';
}

function statusLabel(status: string): string {
  return status === 'needs-auth' ? 'needs sign-in' : status === 'pending' ? 'connecting' : status.replace(/-/g, ' ');
}

/** The detail line for a server with no note or error: its tools, or what its state asks of the user. */
function hintFor(server: McpServerInfo): string {
  switch (groupOf(server.status)) {
    case 'connected': {
      const names = server.toolNames ?? [];
      if (names.length === 0) return server.tools > 0 ? `${plural(server.tools, 'tool')} Claude can use.` : 'Connected, with no tools.';
      const more = server.tools - names.length;
      return `Tools: ${names.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`;
    }
    case 'pending':
      return 'Still connecting. Reload asks every server again.';
    case 'needs-auth':
      return server.status === 'needs-auth' ? 'Claude cannot use it until you sign in.' : 'Waiting for your approval: run claude in a terminal in this workspace to approve it, then Reload.';
    case 'failed':
      return 'It could not connect.';
    case 'disabled':
      return server.status === 'disabled' ? 'Disabled in your Claude Code settings: Claude goes without it.' : `Claude Code says it is ${statusLabel(server.status)}.`;
  }
}

function key(color: Rgb, text: string, title?: string): HTMLLIElement {
  const item = el('li', 'constellation-key');
  const swatch = el('span', 'constellation-swatch');
  swatch.style.background = cssColor(color);
  item.append(swatch, text);
  if (title) item.title = title;
  return item;
}

/** Three numbers in [0, 1) from a string: the same name always starts in the same spot. */
function seeded(text: string): [number, number, number] {
  let hash = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) hash = Math.imul(hash ^ text.charCodeAt(k), 0x01000193);
  const next = () => {
    hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
    hash = Math.imul(hash ^ (hash >>> 12), 0x297a2d39);
    return ((hash ^ (hash >>> 15)) >>> 0) / 4294967296;
  };
  return [next(), next(), next()];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function ease(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : 1 - (1 - x) ** 3;
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
