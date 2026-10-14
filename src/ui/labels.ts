import { PerspectiveCamera, Vector3 } from 'three';
import type { GridLabel } from '../render/overlays';

export interface LabelCandidate {
  /** Unique key, e.g. "r07:12". */
  key: string;
  /** World position. */
  pos: Vector3;
  text: string;
  /** Name rank (0 = IAU name … 7 = survey catalogue); 99 = catalogue designation only. */
  rank: number;
  logL: number;
  sun?: boolean;
}

interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}

// label priority bonus by name rank (see docs/DATA_FORMAT.md)
const RANK_BONUS = [4, 3.5, 3, 2.6, 2.3, 2.0, 1.6, 1.0];

/** 2-D canvas overlay that places non-overlapping star names. */
export class LabelLayer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private widthCache = new Map<string, number>();
  private dpr = 1;
  private readonly v = new Vector3();
  private readonly camPos = new Vector3();
  candidates: LabelCandidate[] = [];
  selectedKey: string | null = null;
  /** World positions of the stars that received a label in the last draw. */
  readonly labelledPositions: Vector3[] = [];

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'label-layer';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(w: number, h: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.widthCache.clear();
  }

  private measure(font: string, text: string): number {
    const k = font + '|' + text;
    let w = this.widthCache.get(k);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      if (this.widthCache.size > 20000) this.widthCache.clear();
      this.widthCache.set(k, w);
    }
    return w;
  }

  /** Projects p to CSS pixels; returns null if behind the camera or far off-screen. */
  private project(p: Vector3, camera: PerspectiveCamera, w: number, h: number): [number, number] | null {
    this.v.copy(p).project(camera);
    if (this.v.z < -1 || this.v.z > 1) return null;
    const x = (this.v.x + 1) * 0.5 * w;
    const y = (1 - this.v.y) * 0.5 * h;
    if (x < -50 || x > w + 50 || y < -20 || y > h + 20) return null;
    return [x, y];
  }

  draw(opts: {
    camera: PerspectiveCamera;
    target: Vector3;
    radius: number;
    maxLabels: number;
    enabled: boolean;
    grid: GridLabel[] | null;
    gridHighlight: string;
  }): void {
    const { camera, target, radius } = opts;
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.labelledPositions.length = 0;
    const placed: Placed[] = [];
    const overlaps = (r: Placed) => {
      for (const p of placed) {
        if (r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y) return true;
      }
      return false;
    };

    // Grid labels first (dim, do not count towards the label limit).
    if (opts.grid) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const gl of opts.grid) {
        const s = this.project(gl.position, camera, w, h);
        if (!s) continue;
        const text = gl.text;
        const tw = this.measure(ctx.font, text);
        const r = { x: s[0] - tw / 2 - 2, y: s[1] - 8, w: tw + 4, h: 16 };
        if (overlaps(r)) continue;
        placed.push(r);
        ctx.fillStyle = gl.highlight ? opts.gridHighlight : 'rgba(140, 170, 220, 0.6)';
        ctx.fillText(text, s[0] - tw / 2, s[1]);
      }
    }

    if (!opts.enabled && this.selectedKey === null) return;

    this.camPos.copy(camera.position);
    const scored: { c: LabelCandidate; score: number; x: number; y: number; fade: number }[] = [];
    for (const c of this.candidates) {
      const selected = c.key === this.selectedKey;
      if (!opts.enabled && !selected) continue;
      const dT = c.pos.distanceTo(target);
      const fade = c.sun || selected ? 1 : 1 - smoothstep(radius * 0.85, radius, dT);
      if (fade <= 0.02) continue;
      const s = this.project(c.pos, camera, w, h);
      if (!s) continue;
      const dC = Math.max(c.pos.distanceTo(this.camPos), 1e-3);
      let score = c.logL - 2 * Math.log10(dC);
      score += c.rank < RANK_BONUS.length ? RANK_BONUS[c.rank] : 0;
      if (c.sun) score += 100;
      if (selected) score += 1000;
      scored.push({ c, score, x: s[0], y: s[1], fade });
    }
    scored.sort((a, b) => b.score - a.score);

    let count = 0;
    let designationCount = 0;
    // catalogue designations get at most a third of the label budget
    const maxDesignations = Math.max(3, Math.floor(opts.maxLabels / 3));
    for (const it of scored) {
      const named = it.c.rank < 99;
      if (it.c.key !== this.selectedKey) {
        if (count >= opts.maxLabels) continue;
        if (!named && designationCount >= maxDesignations) continue;
      }
      const selected = it.c.key === this.selectedKey;
      const font = selected
        ? '600 13px system-ui, sans-serif'
        : named
          ? '12px system-ui, sans-serif'
          : '10.5px system-ui, sans-serif';
      const tw = this.measure(font, it.c.text);
      const r = { x: it.x + 6, y: it.y - 8, w: tw + 4, h: 15 };
      if (!selected && overlaps(r)) continue;
      placed.push(r);
      count++;
      if (!named) designationCount++;
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = it.fade;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(2, 4, 12, 0.85)';
      ctx.strokeText(it.c.text, it.x + 7, it.y);
      ctx.fillStyle = selected ? '#ffd27a' : it.c.sun ? '#fff1b8' : named ? 'rgba(232, 238, 250, 0.95)' : 'rgba(160, 178, 205, 0.85)';
      ctx.fillText(it.c.text, it.x + 7, it.y);
      ctx.globalAlpha = 1;
      if (!it.c.sun && named) this.labelledPositions.push(it.c.pos);
    }
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}
