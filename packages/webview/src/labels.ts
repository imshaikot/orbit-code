import * as THREE from 'three';

export type LabelKind = 'cluster' | 'dir' | 'file' | 'read' | 'edit' | 'hover' | 'mcp';

export interface LabelSpec {
  /** Stable identity; includes the kind so a read label that becomes an edit label restyles. */
  key: string;
  kind: LabelKind;
  text: string;
  detail?: string;
  position: THREE.Vector3;
  /** World units to lift the anchor along the camera's up axis (to sit above a shell); negative lowers it. */
  lift?: number;
  /** Hangs below the anchor instead of standing on it: the Flat view names a file under its sphere. */
  below?: boolean;
  priority: number;
}

interface Item {
  element: HTMLDivElement;
  text: HTMLSpanElement;
  detail: HTMLSpanElement;
  key: string;
}

const MARGIN = 6;
const LINE_HEIGHT = 18;
const projected = new THREE.Vector3();
const cameraUp = new THREE.Vector3();

/**
 * A pool of absolutely positioned DOM labels. Re-rendered only when the camera,
 * focus or the set of active files changes; higher priority labels win overlaps.
 */
export class Labels {
  private readonly pool: Item[] = [];
  private readonly placed: number[] = [];

  constructor(private readonly container: HTMLElement) {}

  render(specs: LabelSpec[], camera: THREE.PerspectiveCamera, width: number, height: number): void {
    specs.sort((a, b) => b.priority - a.priority);
    cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.placed.length = 0;
    let used = 0;

    for (const spec of specs) {
      projected.copy(spec.position);
      if (spec.lift) projected.addScaledVector(cameraUp, spec.lift);
      projected.project(camera);
      if (projected.z < -1 || projected.z > 1) continue;

      const w = estimateWidth(spec);
      const left = (projected.x * 0.5 + 0.5) * width - w / 2;
      const anchor = (-projected.y * 0.5 + 0.5) * height;
      const top = spec.below ? anchor + 1 : anchor - LINE_HEIGHT - (spec.kind === 'cluster' || spec.kind === 'dir' ? 2 : 9);
      if (left < MARGIN || top < MARGIN || left + w > width - MARGIN || top + LINE_HEIGHT > height - MARGIN) continue;
      if (spec.kind !== 'hover' && this.overlaps(left, top, left + w, top + LINE_HEIGHT)) continue;
      this.placed.push(left, top, left + w, top + LINE_HEIGHT);

      const item = this.item(used++);
      if (item.key !== spec.key) {
        item.key = spec.key;
        item.element.className = `label label-${spec.kind}`;
        item.text.textContent = spec.text;
        item.detail.textContent = spec.detail ?? '';
      }
      item.element.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`;
      item.element.hidden = false;
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].element.hidden = true;
  }

  /** Hides every label and forgets what it showed: after a graph change the same key can name another file. */
  clear(): void {
    for (const item of this.pool) {
      item.element.hidden = true;
      item.key = '';
    }
  }

  private overlaps(left: number, top: number, right: number, bottom: number): boolean {
    for (let i = 0; i < this.placed.length; i += 4) {
      if (left < this.placed[i + 2] && right > this.placed[i] && top < this.placed[i + 3] && bottom > this.placed[i + 1]) return true;
    }
    return false;
  }

  private item(index: number): Item {
    let item = this.pool[index];
    if (!item) {
      const element = document.createElement('div');
      const text = document.createElement('span');
      const detail = document.createElement('span');
      text.className = 'label-text';
      detail.className = 'label-detail';
      element.append(text, detail);
      this.container.appendChild(element);
      item = { element, text, detail, key: '' };
      this.pool.push(item);
    }
    return item;
  }
}

function estimateWidth(spec: LabelSpec): number {
  const perChar = spec.kind === 'cluster' || spec.kind === 'dir' ? 6.9 : 6.7;
  return spec.text.length * perChar + (spec.detail ? spec.detail.length * 6.2 + 8 : 0) + 14;
}
