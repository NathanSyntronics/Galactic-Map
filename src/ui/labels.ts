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
  /** System id for members of multiple systems. */
  sys?: number;
  /** Name of that system in the current language, if it has one. */
  sysName?: string;
  /** Apparent visual magnitude as seen from the Sun, if known. */
  appMag?: number;
  /** Symbol radius of the star's sprite in light years (before the star size setting). */
  size?: number;
  /** Start or destination of the route: always labelled, wherever it is. */
  pinned?: boolean;
  /**
   * A waypoint of the route: a candidate wherever it is (the route is drawn whole), labelled ahead
   * of all other stars, but like them only where its label overlaps no other.
   */
  route?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A candidate projected onto the screen (CSS pixels), with its priority. */
export interface ScreenLabel {
  c: LabelCandidate;
  score: number;
  x: number;
  y: number;
  fade: number;
  /** Text to show (set by mergeSystems). */
  text: string;
  /** Own names of the components merged into this label, the label's own first. */
  merged?: string[];
  /** Extra distance (CSS px) of the label from the star, beside a large sprite. */
  gap?: number;
}

export interface PlacedLabel {
  item: ScreenLabel;
  /** Text start x and middle y. */
  tx: number;
  ty: number;
  font: string;
  rect: Rect;
}

// label priority bonus by name rank (see docs/DATA_FORMAT.md)
const RANK_BONUS = [4, 3.5, 3, 2.6, 2.3, 2.0, 1.6, 1.0];
// components of a system closer than this on screen share one label ("Sirius" for Sirius A + B)
const MERGE_PX = 18;
const SUB_COMPONENT = /(\s[A-H])[a-c]$/;
const COMPONENT = /\s[A-H][a-c]?$/;
const COMPONENT_PARTS = /^(.*\S)\s([A-H])[a-c]?$/;

/**
 * Label priority bonus of route waypoints (above the Sun's 100: waypoints come before all other
 * stars), the extra bonus of named waypoints (before catalogue designations), and the bonus of the
 * route's start and destination.
 */
export const ROUTE_BONUS = 200;
export const ROUTE_NAMED_BONUS = 50;
export const PINNED_BONUS = 500;

/** Text colour of the route's start and destination: a light tint of the route colour. */
const ROUTE_LABEL = '#ffa6ec';

const FONT_SELECTED = '600 13px system-ui, sans-serif';
const FONT_NAME = '12px system-ui, sans-serif';
const FONT_DESIGNATION = '10.5px system-ui, sans-serif';

/**
 * Common name of system components shown as one label: "Sirius A" + "Sirius B" -> "Sirius",
 * "Eps Indi Ba" + "Bb" -> "Eps Indi B". With `whole` false (other parts of the system have labels
 * of their own) only sub-component letters are dropped.
 */
export function sharedName(names: string[], whole = true): string | null {
  const strips = [(n: string) => n.replace(SUB_COMPONENT, '$1')];
  if (whole) strips.unshift((n: string) => n.replace(COMPONENT, ''));
  for (const strip of strips) {
    const base = strip(names[0]);
    if (names.every((n) => strip(n) === base)) return base;
  }
  return null;
}

/**
 * Joint name of components that share a base name: "Alpha Centauri A" + "Alpha Centauri B" ->
 * "Alpha Centauri AB", "Capella Aa" + "Capella Ab" + "Capella H" -> "Capella AH". Null if the names
 * do not all consist of the same base and a component letter.
 */
export function jointName(names: string[]): string | null {
  let base: string | null = null;
  const letters = new Set<string>();
  for (const n of names) {
    const m = COMPONENT_PARTS.exec(n);
    if (!m) return null;
    if (base === null) base = m[1];
    else if (m[1] !== base) return null;
    letters.add(m[2]);
  }
  return base === null ? null : `${base} ${[...letters].sort().join('')}`;
}

/**
 * Text of a label that stands for one or more components of a multiple system.
 * `names`: the components' own names, the label's leader first. `whole`: no other member of the
 * system has a label of its own, so the label stands for the whole system. `systemName`: the
 * system's name in the current language.
 *
 * A whole-system label whose members share no base name is named after the system ("Alpha
 * Centauri" for Alpha Centauri A, B and Proxima Centauri), unless the leader's own name is not a
 * component name: "Fomalhaut" (with TW Piscis Austrini) is what the system is called, rather than
 * its designation "Alpha Piscis Austrini".
 */
export function groupLabel(names: string[], whole: boolean, systemName?: string | null): string {
  if (whole) {
    const shared = sharedName(names, true);
    if (shared !== null) return shared;
    if (!COMPONENT.test(names[0])) return names[0];
    return systemName ?? jointName(names) ?? names[0];
  }
  if (names.length === 1) return names[0];
  return sharedName(names, false) ?? jointName(names) ?? names[0];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/**
 * Label priority bonus of a star that is prominent in the sky as seen from Earth: it grows for
 * stars brighter than apparent magnitude 4.5, and more steeply for the ~20 brightest stars of the
 * night sky (brighter than magnitude 1.5), so that around the Sun Sirius, Alpha Centauri and
 * Procyon win against stars that are more luminous but much less known, such as Pollux. At most 4,
 * as much as the bonus of an IAU name.
 */
export function skyBonus(appMag: number | undefined): number {
  if (appMag === undefined || !Number.isFinite(appMag)) return 0;
  return clamp(0.5 * (4.5 - appMag), 0, 2.5) + clamp(1.5 * (1.5 - appMag), 0, 1.5);
}

/** Label priority of a star: luminosity, distance from the camera, name rank, brightness in Earth's sky. */
export function starPriority(logL: number, distToCamera: number, rank: number, appMag: number | undefined, sun = false): number {
  let score = logL - 2 * Math.log10(Math.max(distToCamera, 1e-3));
  score += rank < RANK_BONUS.length ? RANK_BONUS[rank] : 0;
  score += skyBonus(appMag);
  if (sun) score += 100;
  return score;
}

/** Label priority of a candidate: the star's, plus the route bonuses. */
export function labelScore(c: LabelCandidate, distToCamera: number): number {
  let score = starPriority(c.logL, distToCamera, c.rank, c.appMag, c.sun);
  if (c.route) score += ROUTE_BONUS + (c.rank < 99 ? ROUTE_NAMED_BONUS : 0);
  if (c.pinned) score += PINNED_BONUS;
  return score;
}

/**
 * The `k` items with the highest scores (a min-heap; on equal scores the earlier item stays).
 * Large views hold tens of thousands of named stars, but a frame labels a few hundred at most.
 */
export class TopK<T> {
  private readonly scores: number[] = [];
  private readonly entries: T[] = [];

  constructor(readonly k: number) {}

  /** Lowest score kept once full (items at or below it are not taken). */
  get threshold(): number {
    return this.entries.length < this.k ? -Infinity : this.scores[0];
  }

  push(score: number, item: T): void {
    const s = this.scores;
    const e = this.entries;
    if (this.k <= 0) return;
    if (e.length < this.k) {
      s.push(score);
      e.push(item);
      let i = e.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (s[p] <= s[i]) break;
        this.swap(i, p);
        i = p;
      }
      return;
    }
    if (score <= s[0]) return;
    s[0] = score;
    e[0] = item;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < e.length && s[l] < s[m]) m = l;
      if (r < e.length && s[r] < s[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }

  /** The kept items, in no particular order. */
  items(): readonly T[] {
    return this.entries;
  }

  private swap(a: number, b: number): void {
    const s = this.scores;
    const e = this.entries;
    [s[a], s[b]] = [s[b], s[a]];
    [e[a], e[b]] = [e[b], e[a]];
  }
}

/**
 * Whether a point can be labelled: in front of the camera and within the screen plus a margin
 * (`m`: elements of the view-projection matrix; `margin`: fraction of the half screen).
 */
export function onScreen(m: ArrayLike<number>, x: number, y: number, z: number, margin = 0.25): boolean {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (w <= 0) return false;
  const lim = (1 + margin) * w;
  const px = m[0] * x + m[4] * y + m[8] * z + m[12];
  const py = m[1] * x + m[5] * y + m[9] * z + m[13];
  return px >= -lim && px <= lim && py >= -lim && py <= lim;
}

/** Named stars kept as label candidates (the best by priority): plenty for `maxLabels` labels. */
export function namedCandidateLimit(maxLabels: number): number {
  return Math.max(500, 8 * maxLabels);
}

/**
 * Merges the labels of system components that coincide on screen and names the resulting labels.
 * `items` must be sorted by descending score; the result keeps that order. The selected star
 * leads its group and keeps its own name, and it counts as a separately labelled member of its
 * system, so its siblings' labels never claim the whole system's name. A route's start and
 * destination (pinned) are treated alike: never merged into another label, always their own name.
 */
export function mergeSystems(items: ScreenLabel[], selectedKey: string | null): ScreenLabel[] {
  const leaders = new Map<number, ScreenLabel[]>();
  const visible: ScreenLabel[] = [];
  for (const it of items) {
    const sys = it.c.sys;
    const selected = it.c.key === selectedKey || !!it.c.pinned;
    it.text = it.c.text;
    it.merged = undefined;
    if (sys === undefined || (it.c.rank >= 99 && !selected)) {
      visible.push(it);
      continue;
    }
    const group = leaders.get(sys) ?? [];
    const leader = group.find((l) => Math.abs(l.x - it.x) < MERGE_PX && Math.abs(l.y - it.y) < MERGE_PX);
    if (leader && !selected) {
      (leader.merged ??= [leader.c.text]).push(it.c.text);
      continue;
    }
    group.push(it);
    leaders.set(sys, group);
    visible.push(it);
  }
  // A label that stands for its whole system drops the component letter ("Alpha Centauri"),
  // one that stands for some of the components joins their letters ("Alpha Centauri AB").
  for (const it of visible) {
    const sys = it.c.sys;
    if (sys === undefined || it.c.rank >= 99 || it.c.key === selectedKey || it.c.pinned) continue;
    const whole = leaders.get(sys)!.length === 1;
    it.text = groupLabel(it.merged ?? [it.c.text], whole, it.c.sysName);
  }
  return visible;
}

const overlapsAny = (r: Rect, placed: Rect[]) => {
  for (const p of placed) {
    if (r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y) return true;
  }
  return false;
};

/**
 * Candidate positions of a star label, in order of preference (text start x, text middle y, box):
 * right of the star, left, above, below, the four diagonals, then the four diagonals a little
 * further out (for crowded regions such as the Sun's neighbourhood seen from afar).
 */
export function anchors(x: number, y: number, tw: number, gap = 0): { tx: number; ty: number; r: Rect }[] {
  const at = (tx: number, ty: number) => ({ tx, ty, r: { x: tx - 1, y: ty - 8, w: tw + 4, h: 15 } });
  // `gap` moves every anchor outwards, away from a large sprite
  const g = gap;
  const d = gap * 0.7;
  return [
    at(x + 7 + g, y),
    at(x - 10 - tw - g, y),
    at(x - tw / 2 - 1, y - 13 - g),
    at(x - tw / 2 - 1, y + 13 + g),
    at(x + 4 + d, y - 11 - d),
    at(x + 4 + d, y + 11 + d),
    at(x - 7 - tw - d, y - 11 - d),
    at(x - 7 - tw - d, y + 11 + d),
    at(x + 6 + d, y - 17 - d),
    at(x + 6 + d, y + 17 + d),
    at(x - 9 - tw - d, y - 17 - d),
    at(x - 9 - tw - d, y + 17 + d),
  ];
}

/**
 * Extra label distance beside a sprite of `px` CSS pixels: the anchors suit sprites up to about
 * 25 px; the bright core and inner glow of a larger one cover about 0.22 of its width around the
 * centre.
 */
export function spriteGap(px: number): number {
  return Math.max(0, 0.22 * px - 5);
}

const inside = (r: Rect, b: { w: number; h: number }) => r.x >= 0 && r.y >= 0 && r.x + r.w <= b.w && r.y + r.h <= b.h;

/**
 * Places labels in the given (priority) order, each at the first of its anchors that does not
 * overlap a box in `placed` and lies within `bounds` (the viewport, if given); labels without a
 * free anchor are dropped (the labels of the selected star and of pinned stars are always shown).
 * At most `maxLabels` labels, a third of them catalogue designations (the always shown ones
 * included, but never dropped; route waypoints count, but are not limited to the third). Adds the
 * boxes of the placed labels to `placed`.
 */
export function placeLabels(
  items: ScreenLabel[],
  opts: {
    maxLabels: number;
    selectedKey: string | null;
    measure: (font: string, text: string) => number;
    placed: Rect[];
    bounds?: { w: number; h: number };
  },
): PlacedLabel[] {
  const out: PlacedLabel[] = [];
  let count = 0;
  let designationCount = 0;
  const maxDesignations = Math.max(3, Math.floor(opts.maxLabels / 3));
  for (const it of items) {
    const named = it.c.rank < 99;
    const selected = it.c.key === opts.selectedKey;
    const always = selected || !!it.c.pinned;
    if (!always) {
      if (count >= opts.maxLabels) continue;
      if (!named && !it.c.route && designationCount >= maxDesignations) continue;
    }
    const font = selected ? FONT_SELECTED : named || it.c.pinned ? FONT_NAME : FONT_DESIGNATION;
    const tw = opts.measure(font, it.text);
    const options = anchors(it.x, it.y, tw, it.gap ?? 0);
    const bounds = opts.bounds;
    let a = options.find((o) => (!bounds || inside(o.r, bounds)) && !overlapsAny(o.r, opts.placed));
    if (!a) {
      if (!always) continue;
      a = options[0];
    }
    opts.placed.push(a.r);
    count++;
    if (!named) designationCount++;
    out.push({ item: it, tx: a.tx, ty: a.ty, font, rect: a.r });
  }
  return out;
}

/** 2-D canvas overlay that places non-overlapping star names. */
export class LabelLayer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private widthCache = new Map<string, number>();
  private dpr = 1;
  private readonly v = new Vector3();
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

  private measure = (font: string, text: string): number => {
    const k = font + '|' + text;
    let w = this.widthCache.get(k);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      if (this.widthCache.size > 20000) this.widthCache.clear();
      this.widthCache.set(k, w);
    }
    return w;
  };

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
    /** Sprite size in CSS px = min(2 · size · scale / distance, max), as in the star shader. */
    sprite?: { scale: number; max: number };
  }): void {
    const { camera, target, radius } = opts;
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.labelledPositions.length = 0;
    const placed: Rect[] = [];

    // Star labels are placed first; grid labels only take the space that is left.
    let stars: PlacedLabel[] = [];
    if (opts.enabled || this.selectedKey !== null || this.candidates.some((c) => c.pinned)) {
      const scored: ScreenLabel[] = [];
      for (const c of this.candidates) {
        const selected = c.key === this.selectedKey;
        if (!opts.enabled && !selected && !c.pinned) continue;
        // the route is drawn whole: its labels do not fade at the edge of the sphere
        const fade = c.sun || selected || c.pinned || c.route ? 1 : 1 - smoothstep(radius * 0.85, radius, c.pos.distanceTo(target));
        if (fade <= 0.02) continue;
        const s = this.project(c.pos, camera, w, h);
        if (!s) continue;
        const dist = c.pos.distanceTo(camera.position);
        const score = labelScore(c, dist) + (selected ? 1000 : 0);
        const sp = opts.sprite;
        const gap = sp && c.size ? spriteGap(Math.min((2 * c.size * sp.scale) / Math.max(dist, 1e-6), sp.max)) : 0;
        scored.push({ c, score, x: s[0], y: s[1], fade, text: c.text, gap });
      }
      scored.sort((a, b) => b.score - a.score);
      const visible = mergeSystems(scored, this.selectedKey);
      stars = placeLabels(visible, {
        maxLabels: opts.maxLabels,
        selectedKey: this.selectedKey,
        measure: this.measure,
        placed,
        bounds: { w, h },
      });
    }

    if (opts.grid) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const gl of opts.grid) {
        const s = this.project(gl.position, camera, w, h);
        if (!s) continue;
        const text = gl.text;
        const tw = this.measure(ctx.font, text);
        const r = { x: s[0] - tw / 2 - 2, y: s[1] - 8, w: tw + 4, h: 16 };
        if (overlapsAny(r, placed)) continue;
        placed.push(r);
        ctx.fillStyle = gl.highlight ? opts.gridHighlight : 'rgba(140, 170, 220, 0.6)';
        ctx.fillText(text, s[0] - tw / 2, s[1]);
      }
    }

    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(2, 4, 12, 0.85)';
    for (const l of stars) {
      const it = l.item;
      const named = it.c.rank < 99;
      const selected = it.c.key === this.selectedKey;
      ctx.font = l.font;
      ctx.globalAlpha = it.fade;
      ctx.strokeText(it.text, l.tx, l.ty);
      ctx.fillStyle = selected
        ? '#ffd27a'
        : it.c.pinned
          ? ROUTE_LABEL
          : it.c.sun
            ? '#fff1b8'
            : named
              ? 'rgba(232, 238, 250, 0.95)'
              : 'rgba(160, 178, 205, 0.85)';
      ctx.fillText(it.text, l.tx, l.ty);
      // height lines only inside the visible sphere (route stars may lie far outside)
      const outside = (it.c.pinned || it.c.route) && it.c.pos.distanceTo(opts.target) > radius;
      if (!it.c.sun && named && !outside) this.labelledPositions.push(it.c.pos);
    }
    ctx.globalAlpha = 1;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}
