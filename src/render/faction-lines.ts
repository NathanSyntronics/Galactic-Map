import { BufferAttribute, BufferGeometry, Group, Vector3 } from 'three';
import { lineMaterial, segments } from './links';

/** Draws the jumps by which the factions reached their systems (docs/FACTIONS.md). */
export class FactionLines {
  readonly group = new Group();
  private readonly material = lineMaterial();
  private readonly lines = segments(this.material, -1);
  private readonly tmp = new Vector3();
  /** Two vertices per jump, relative to the group's position; RGBA per vertex. */
  private pos = new Float32Array(0);
  private col = new Uint8Array(0);
  private count = 0;
  /** Jumps already in the geometry's buffers, and whether the buffers must be made anew. */
  private flushed = 0;
  private rebuild = true;

  constructor() {
    this.group.name = 'faction-links';
    this.group.matrixAutoUpdate = false;
    this.group.add(this.lines);
    this.material.uniforms.uOpacity.value = 0.9;
  }

  /** No jumps; those added next are drawn relative to `origin` (near the home stars). */
  clear(origin: { x: number; y: number; z: number }): void {
    this.group.position.set(Math.fround(origin.x), Math.fround(origin.y), Math.fround(origin.z));
    this.group.updateMatrix();
    this.count = 0;
    this.flushed = 0;
    this.rebuild = true;
  }

  /** One jump from (ax, ay, az) to (bx, by, bz) in a colour (RGB 0..255); a station's is fainter. Drawn after flush(). */
  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, rgb: readonly number[], faint: boolean): void {
    if (this.count * 6 >= this.pos.length) {
      const size = Math.max(1024, 2 * this.count);
      const pos = new Float32Array(size * 6);
      pos.set(this.pos.subarray(0, this.count * 6));
      const col = new Uint8Array(size * 8);
      col.set(this.col.subarray(0, this.count * 8));
      this.pos = pos;
      this.col = col;
      this.rebuild = true;
    }
    const o = this.group.position;
    const p = this.count * 6;
    this.pos[p] = ax - o.x;
    this.pos[p + 1] = ay - o.y;
    this.pos[p + 2] = az - o.z;
    this.pos[p + 3] = bx - o.x;
    this.pos[p + 4] = by - o.y;
    this.pos[p + 5] = bz - o.z;
    const c = this.count * 8;
    const alpha = faint ? 150 : 255;
    for (let v = 0; v < 2; v++) {
      this.col[c + 4 * v] = rgb[0];
      this.col[c + 4 * v + 1] = rgb[1];
      this.col[c + 4 * v + 2] = rgb[2];
      this.col[c + 4 * v + 3] = alpha;
    }
    this.count++;
  }

  /** The jumps added so far drawn (only the new ones are uploaded, unless the buffers grew). */
  flush(): void {
    if (this.rebuild) {
      this.lines.geometry.dispose();
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(this.pos, 3));
      g.setAttribute('aColor', new BufferAttribute(this.col, 4, true));
      this.lines.geometry = g;
      this.rebuild = false;
    } else if (this.count > this.flushed) {
      const g = this.lines.geometry;
      const pos = g.getAttribute('position') as BufferAttribute;
      const col = g.getAttribute('aColor') as BufferAttribute;
      pos.addUpdateRange(this.flushed * 6, (this.count - this.flushed) * 6);
      pos.needsUpdate = true;
      col.addUpdateRange(this.flushed * 8, (this.count - this.flushed) * 8);
      col.needsUpdate = true;
    }
    this.flushed = this.count;
    this.lines.geometry.setDrawRange(0, 2 * this.count);
    this.lines.visible = this.count > 0;
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
