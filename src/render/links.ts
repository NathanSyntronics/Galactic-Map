import { BufferAttribute, BufferGeometry, Group, LineSegments, ShaderMaterial, Vector3 } from 'three';
import type { JumpNetwork } from '../network/places';
import type { JumpColor } from '../settings';
import { paletteColor } from './style';

/** Line colour of the 'uniform' mode: a calm blue. */
export const JUMP_UNIFORM_RGB: [number, number, number] = [104, 150, 222];
/** Palette of the 'length' mode, short to long. */
export const JUMP_LENGTH_PALETTE = 'turbo';
/** Highlight of the selected star's links (the accent colour). */
export const JUMP_HIGHLIGHT_RGB: [number, number, number] = [255, 200, 97];

// Vertices are stored relative to the group's origin (near the view centre). The alpha fades
// towards the edge of the visible sphere per vertex, like the stars (see starfield.ts).
const vertexShader = /* glsl */ `
attribute vec4 aColor;
uniform vec3 uCentre;
uniform float uRadius;
uniform float uFade;
uniform float uOpacity;
varying vec4 vColor;
void main() {
  float d = distance(position, uCentre);
  float a = 1.0 - smoothstep(uRadius * uFade, uRadius, d);
  vColor = vec4(aColor.rgb, aColor.a * uOpacity * a);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
varying vec4 vColor;
void main() {
  if (vColor.a <= 0.003) discard;
  gl_FragColor = vColor;
}
`;

function lineMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uCentre: { value: new Vector3() },
      uRadius: { value: 50 },
      uFade: { value: 0.85 },
      uOpacity: { value: 0.6 },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

function segments(material: ShaderMaterial, renderOrder: number): LineSegments {
  const l = new LineSegments(new BufferGeometry(), material);
  l.frustumCulled = false;
  // before the stars (renderOrder >= 0), which are drawn additively on top
  l.renderOrder = renderOrder;
  l.visible = false;
  return l;
}

/** Draws the links of a jump network as thin lines. */
export class JumpLines {
  readonly group = new Group();
  private readonly material = lineMaterial();
  private readonly highlightMaterial = lineMaterial();
  private readonly lines = segments(this.material, -2);
  private readonly highlightLines = segments(this.highlightMaterial, -1);
  private net: JumpNetwork | null = null;
  /** Indices of the drawn links. */
  private drawn = new Uint32Array(0);
  private mode: JumpColor = 'stars';
  private highlighted = -1;
  private readonly tmp = new Vector3();

  constructor() {
    this.group.name = 'jump-links';
    this.group.matrixAutoUpdate = false;
    this.group.add(this.lines, this.highlightLines);
    this.highlightMaterial.uniforms.uOpacity.value = 1;
  }

  get network(): JumpNetwork | null {
    return this.net;
  }

  /**
   * Shows a network: the links with at least one end within `drawRadius` of its centre. The
   * vertices are stored relative to the computation centre (rounded), which becomes the origin.
   */
  set(net: JumpNetwork | null, drawRadius: number, mode: JumpColor): void {
    this.net = net;
    this.mode = mode;
    // place indices change with every network: the caller highlights again
    this.highlighted = -1;
    this.replace(this.highlightLines, null, null);
    if (!net || net.links.count === 0) {
      this.drawn = new Uint32Array(0);
      this.replace(this.lines, null, null);
      return;
    }
    const { links, places } = net;
    const pos = places.positions;
    const { x: cx, y: cy, z: cz } = net.centre;
    const r2 = drawRadius * drawRadius;
    const inside = (p: number) => {
      const dx = pos[3 * p] - cx;
      const dy = pos[3 * p + 1] - cy;
      const dz = pos[3 * p + 2] - cz;
      return dx * dx + dy * dy + dz * dz <= r2;
    };
    const drawn = new Uint32Array(links.count);
    let n = 0;
    for (let k = 0; k < links.count; k++) if (inside(links.a[k]) || inside(links.b[k])) drawn[n++] = k;
    this.drawn = drawn.slice(0, n);
    this.group.position.set(Math.fround(cx), Math.fround(cy), Math.fround(cz));
    this.group.updateMatrix();
    this.replace(this.lines, this.positions(this.drawn), this.colors(this.drawn, null));
  }

  /** Changes the colour mode (no recomputation). */
  setMode(mode: JumpColor): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.recolor();
  }

  /** Reads the star colours again (after a restyle). */
  recolor(): void {
    const attr = this.lines.geometry.getAttribute('aColor') as BufferAttribute | undefined;
    if (!this.net || !attr || attr.count !== 2 * this.drawn.length) return;
    (attr.array as Uint8Array).set(this.colors(this.drawn, null));
    attr.needsUpdate = true;
  }

  /** Highlights the links of a place of the current network (-1: none). */
  highlight(place: number): void {
    if (place === this.highlighted) return;
    this.highlighted = place;
    const net = this.net;
    if (!net || place < 0 || place >= net.places.count) {
      this.replace(this.highlightLines, null, null);
      return;
    }
    const sel: number[] = [];
    for (let k = 0; k < net.links.count; k++) if (net.links.a[k] === place || net.links.b[k] === place) sel.push(k);
    const idx = Uint32Array.from(sel);
    this.replace(this.highlightLines, this.positions(idx), this.colors(idx, JUMP_HIGHLIGHT_RGB));
  }

  /** Per-frame view: centre of the visible sphere, its radius and the line opacity. */
  update(target: Vector3, radius: number, opacity: number): void {
    const u = this.material.uniforms;
    (u.uCentre.value as Vector3).copy(this.tmp.copy(target).sub(this.group.position));
    u.uRadius.value = radius;
    u.uOpacity.value = opacity;
    const h = this.highlightMaterial.uniforms;
    (h.uCentre.value as Vector3).copy(u.uCentre.value as Vector3);
    h.uRadius.value = radius;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  /** Releases the geometry (network switched off). */
  clear(): void {
    this.set(null, 0, this.mode);
  }

  private positions(idx: Uint32Array): Float32Array {
    const net = this.net!;
    const pos = net.places.positions;
    const o = this.group.position;
    const out = new Float32Array(idx.length * 6);
    for (let j = 0; j < idx.length; j++) {
      const k = idx[j];
      const a = net.links.a[k];
      const b = net.links.b[k];
      out[6 * j] = pos[3 * a] - o.x;
      out[6 * j + 1] = pos[3 * a + 1] - o.y;
      out[6 * j + 2] = pos[3 * a + 2] - o.z;
      out[6 * j + 3] = pos[3 * b] - o.x;
      out[6 * j + 4] = pos[3 * b + 1] - o.y;
      out[6 * j + 5] = pos[3 * b + 2] - o.z;
    }
    return out;
  }

  /** RGBA per vertex; `fixed` colours every vertex the same. */
  private colors(idx: Uint32Array, fixed: [number, number, number] | null): Uint8Array {
    const net = this.net!;
    const { links, places } = net;
    const out = new Uint8Array(idx.length * 8);
    const end = (p: number, o: number) => {
      const src = places.sources[places.repSource[p]];
      const i = places.repIndex[p];
      out[o] = src.colors[3 * i];
      out[o + 1] = src.colors[3 * i + 1];
      out[o + 2] = src.colors[3 * i + 2];
    };
    for (let j = 0; j < idx.length; j++) {
      const k = idx[j];
      const o = 8 * j;
      if (fixed) {
        out.set(fixed, o);
        out.set(fixed, o + 4);
      } else if (this.mode === 'stars') {
        end(links.a[k], o);
        end(links.b[k], o + 4);
      } else if (this.mode === 'length') {
        paletteColor(JUMP_LENGTH_PALETTE, links.length[k] / net.range, out, o);
        out.copyWithin(o + 4, o, o + 3);
      } else {
        out.set(JUMP_UNIFORM_RGB, o);
        out.set(JUMP_UNIFORM_RGB, o + 4);
      }
      out[o + 3] = 255;
      out[o + 7] = 255;
    }
    return out;
  }

  private replace(lines: LineSegments, positions: Float32Array | null, colors: Uint8Array | null): void {
    lines.geometry.dispose();
    const g = new BufferGeometry();
    if (positions && colors && positions.length > 0) {
      g.setAttribute('position', new BufferAttribute(positions, 3));
      g.setAttribute('aColor', new BufferAttribute(colors, 4, true));
    }
    lines.geometry = g;
    lines.visible = !!positions && positions.length > 0;
  }
}
