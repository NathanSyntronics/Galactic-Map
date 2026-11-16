import { BufferAttribute, BufferGeometry, Group, Vector3 } from 'three';
import { hexToRgb } from './style';
import { lineMaterial, segments } from './links';

/** One jump of a faction: from one place's position to another's, in the faction's colour. */
export interface FactionJump {
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
  color: string;
  /** A station's jump is drawn fainter than a colony's. */
  faint: boolean;
}

/** Draws the jumps by which the factions reached their systems (docs/FACTIONS.md). */
export class FactionLines {
  readonly group = new Group();
  private readonly material = lineMaterial();
  private readonly lines = segments(this.material, -1);
  private readonly tmp = new Vector3();

  constructor() {
    this.group.name = 'faction-links';
    this.group.matrixAutoUpdate = false;
    this.group.add(this.lines);
    this.material.uniforms.uOpacity.value = 0.9;
  }

  /** The jumps drawn; vertices relative to `origin` (near the home stars). */
  set(jumps: FactionJump[], origin: { x: number; y: number; z: number }): void {
    this.lines.geometry.dispose();
    const g = new BufferGeometry();
    if (jumps.length) {
      this.group.position.set(Math.fround(origin.x), Math.fround(origin.y), Math.fround(origin.z));
      this.group.updateMatrix();
      const o = this.group.position;
      const pos = new Float32Array(jumps.length * 6);
      const col = new Uint8Array(jumps.length * 8);
      jumps.forEach((j, k) => {
        pos.set([j.a.x - o.x, j.a.y - o.y, j.a.z - o.z, j.b.x - o.x, j.b.y - o.y, j.b.z - o.z], 6 * k);
        const [r, gr, b] = hexToRgb(j.color);
        const alpha = j.faint ? 150 : 255;
        col.set([r, gr, b, alpha, r, gr, b, alpha], 8 * k);
      });
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('aColor', new BufferAttribute(col, 4, true));
    }
    this.lines.geometry = g;
    this.lines.visible = jumps.length > 0;
  }

  /** Per frame: the visible sphere (the lines fade at its edge like the stars). */
  update(target: Vector3, radius: number): void {
    const u = this.material.uniforms;
    (u.uCentre.value as Vector3).copy(this.tmp.copy(target).sub(this.group.position));
    u.uRadius.value = radius;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }
}
