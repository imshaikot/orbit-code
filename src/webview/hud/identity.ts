import type { IndexStats } from '../../shared/protocol';
import { type Rgb, cssColor } from '../palette';
import { button, el } from './dom';

/** Legend entries past this fold into one "+N more". */
const LEGEND_ENTRIES = 8;

/** Files of the kinds that share one colour. */
export interface KindGroup {
  /** Kind names, in FILE_KINDS order: "Rust", or "Rust · Swift". */
  labels: string[];
  color: Rgb;
  count: number;
}

export interface GraphSummary {
  root: string;
  files: number;
  imports: number;
  directories: number;
  stats: IndexStats;
  indexedAt: number;
  cached: boolean;
  /** Where the frozen layout came from: the cache, the layout worker, or a live update extending it. */
  layout: 'reused' | 'computed' | 'extended';
  /** What the colours mean: file counts per colour, most files first. */
  kinds: KindGroup[];
}

/** One directory on the path to the one in view. */
export interface Crumb {
  cluster: number;
  /** As shown: the workspace name for the root, else the name inside its parent ("hud", "main/java"). */
  name: string;
  /** Workspace-relative path. */
  path: string;
}

export interface IdentityActions {
  goTo(cluster: number): void;
  reindex(): void;
}

/** Top left: workspace name, counts, the file type colours, where the index came from, and the path of directories being looked into. */
export class Identity {
  private readonly workspace = el('span', 'workspace');
  private readonly counts = { files: el('b', undefined, '0'), imports: el('b', undefined, '0'), directories: el('b', undefined, '0') };
  private readonly legend = el('ul', 'legend');
  private readonly provenance = el('span', 'provenance-text');
  private readonly crumbs = el('nav', 'crumbs');
  private summary: GraphSummary | undefined;
  private provenanceTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    host: HTMLElement,
    private readonly actions: IdentityActions,
  ) {
    const root = el('section', 'identity');
    const title = el('h1', 'title');
    title.append(el('span', 'wordmark', 'orbit'), this.workspace);

    const counts = el('p', 'counts');
    for (const key of ['files', 'imports', 'directories'] as const) {
      const count = el('span', 'count');
      count.append(this.counts[key], ` ${key}`);
      counts.append(count);
    }

    const provenance = el('p', 'provenance');
    const reindex = button('Reindex', 'link-button', 'Start over: index every file again and lay the graph out from scratch. File changes update the graph without this.');
    reindex.addEventListener('click', () => actions.reindex());
    provenance.append(this.provenance, ' ', reindex);

    this.crumbs.setAttribute('aria-label', 'Location');
    this.setLocation(undefined);
    this.legend.setAttribute('aria-label', 'File types');

    root.append(title, counts, this.legend, provenance, this.crumbs);
    host.append(root);
  }

  setGraph(summary: GraphSummary): void {
    this.summary = summary;
    this.workspace.textContent = summary.root;
    for (const key of ['files', 'imports', 'directories'] as const) this.counts[key].textContent = summary[key].toLocaleString('en-US');
    this.renderLegend(summary.kinds);
    this.renderProvenance();
    clearInterval(this.provenanceTimer);
    this.provenanceTimer = setInterval(() => this.renderProvenance(), 60_000);
  }

  /** Ancestors are links back up; the directory in view comes last. */
  setLocation(path: readonly Crumb[] | undefined): void {
    this.crumbs.replaceChildren();
    this.crumbs.dataset.depth = String(Math.max(0, (path?.length ?? 1) - 1));
    path?.forEach((crumb, k) => {
      if (k > 0) {
        const separator = el('span', 'crumb-sep', '/');
        separator.setAttribute('aria-hidden', 'true');
        this.crumbs.append(separator);
      }
      if (k === path.length - 1) {
        const current = el('span', k === 0 ? 'crumb-current crumb-root' : 'crumb-current', crumb.name);
        current.dataset.path = crumb.path;
        current.setAttribute('aria-current', 'location');
        this.crumbs.append(current);
        return;
      }
      const link = button(crumb.name, k === 0 ? 'link-button crumb-root' : 'link-button crumb-link', `Back to ${crumb.path}`);
      link.addEventListener('click', () => this.actions.goTo(crumb.cluster));
      this.crumbs.append(link);
    });
  }

  /** A swatch, the kinds that wear it, and how many files they are. */
  private renderLegend(kinds: readonly KindGroup[]): void {
    const shown = kinds.length > LEGEND_ENTRIES ? kinds.slice(0, LEGEND_ENTRIES - 1) : kinds;
    this.legend.replaceChildren(
      ...shown.map((kind) => {
        const swatch = el('span', 'legend-swatch');
        swatch.style.background = cssColor(kind.color);
        swatch.setAttribute('aria-hidden', 'true');
        const item = el('li', 'legend-item');
        item.append(swatch, el('span', 'legend-label', kind.labels.join(' · ')), el('span', 'legend-count', kind.count.toLocaleString('en-US')));
        return item;
      }),
    );
    const rest = kinds.slice(shown.length);
    if (rest.length > 0) {
      const more = el('li', 'legend-item legend-more', `+${rest.length} more`);
      more.title = rest.map((kind) => `${kind.labels.join(' · ')}: ${kind.count.toLocaleString('en-US')}`).join('\n');
      this.legend.append(more);
    }
  }

  private renderProvenance(): void {
    const s = this.summary;
    if (!s) return;
    const changes = s.stats.changes;
    const when = changes
      ? `Updated ${relativeTime(s.indexedAt)}: +${changes.added} −${changes.removed} ~${changes.changed} files`
      : s.cached
        ? `Index from ${relativeTime(s.indexedAt)}, reused`
        : `Indexed ${relativeTime(s.indexedAt)} in ${s.stats.ms.toLocaleString('en-US')} ms`;
    const layout = `layout ${s.layout}`;
    const extractors = `dependency-cruiser read ${s.stats.depcruiseFiles.toLocaleString('en-US')} files, the regex scan ${s.stats.regexFiles.toLocaleString('en-US')}`;
    const truncated = s.stats.truncated ? ' Truncated at orbit.maxFiles.' : '';
    this.provenance.textContent = `${when}, ${layout}. ${extractors}.${truncated}`;
  }
}

function relativeTime(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
