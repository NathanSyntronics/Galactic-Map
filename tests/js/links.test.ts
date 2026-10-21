import { Vector3, type BufferAttribute, type ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { computeNetwork, placeOfStar, type NetworkOptions } from '../../src/network/places';
import { JUMP_DIM, JUMP_HIGHLIGHT_RGB, JUMP_LENGTH_PALETTE, JUMP_UNIFORM_RGB, JumpLines } from '../../src/render/links';
import { paletteColor } from '../../src/render/style';
import { source } from './fixtures/stars';

const options: NetworkOptions = {
  centre: { x: 1000, y: 0, z: 0 },
  radius: 100,
  capacity: { by: 'luminosity', faint: 3, sun: 7, bright: 12 },
  nodeKey: () => 0,
  range: 10,
  hub: 1,
  kSun: 7,
  connect: true,
};

/** A chain of stars along x around x = 1000: 990, 996, 1002, 1008, 1014, 1030 (far from the Sun). */
function chain() {
  const src = source(
    'r',
    [990, 996, 1002, 1008, 1014, 1030].map((x) => ({ x, logL: 0 })),
  );
  src.colors.set([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180]);
  return src;
}

function attrs(lines: JumpLines) {
  const [main, highlight] = lines.group.children as unknown as { geometry: { getAttribute(n: string): BufferAttribute | undefined }; visible: boolean }[];
  return { main, highlight };
}

describe('jump lines', () => {
  it('draws the links with an end inside the radius, relative to an origin at the centre', () => {
    const src = chain();
    const net = computeNetwork([src], options);
    // the chain links neighbours 6 ly apart; 1030 is 16 ly from 1014 and stays alone
    expect(net.links.count).toBe(4);
    const lines = new JumpLines();
    lines.set(net, 5, 'stars');
    expect(lines.group.position.x).toBe(1000);
    const { main } = attrs(lines);
    const pos = main.geometry.getAttribute('position')!;
    // 996 and 1002 are within 5 ly of 1000: 990-996, 996-1002 and 1002-1008 are drawn, 1008-1014 not
    expect(pos.count).toBe(6);
    const xs = [...(pos.array as Float32Array)].filter((_, i) => i % 3 === 0).sort((a, b) => a - b);
    expect(xs).toEqual([-10, -4, -4, 2, 2, 8]);
    expect(main.visible).toBe(true);
  });

  it('colours the ends by their stars, uniformly or by length, and follows restyles', () => {
    const src = chain();
    const net = computeNetwork([src], options);
    const lines = new JumpLines();
    lines.set(net, 100, 'stars');
    const col = () => attrs(lines).main.geometry.getAttribute('aColor')!;
    expect(col().itemSize).toBe(4);
    expect(col().normalized).toBe(true);
    const a = net.links.a[0];
    const b = net.links.b[0];
    const rgba = (k: number) => [...(col().array as Uint8Array).subarray(4 * k, 4 * k + 4)];
    const star = (p: number) => {
      const i = net.places.repIndex[p];
      return [...src.colors.subarray(3 * i, 3 * i + 3), 255];
    };
    expect(rgba(0)).toEqual(star(a));
    expect(rgba(1)).toEqual(star(b));

    src.colors.fill(77);
    lines.recolor();
    expect(rgba(0)).toEqual([77, 77, 77, 255]);

    lines.setMode('uniform');
    expect(rgba(0)).toEqual([...JUMP_UNIFORM_RGB, 255]);
    lines.setMode('length');
    const expected = new Uint8Array(3);
    paletteColor(JUMP_LENGTH_PALETTE, net.links.length[0] / 10, expected, 0);
    expect(rgba(0)).toEqual([...expected, 255]);
    expect(rgba(1)).toEqual([...expected, 255]);
  });

  it('highlights the links of a place and forgets it with a new network', () => {
    const src = chain();
    const net = computeNetwork([src], options);
    const lines = new JumpLines();
    lines.set(net, 100, 'stars');
    const place = placeOfStar(net.places, 'r', 2);
    lines.highlight(place);
    const { highlight } = attrs(lines);
    expect(highlight.visible).toBe(true);
    const hc = highlight.geometry.getAttribute('aColor')!;
    expect(hc.count).toBe(4);
    expect([...(hc.array as Uint8Array).subarray(0, 4)]).toEqual([...JUMP_HIGHLIGHT_RGB, 255]);
    lines.set(computeNetwork([src], options), 100, 'stars');
    expect(attrs(lines).highlight.visible).toBe(false);
    lines.highlight(-1);
    expect(attrs(lines).highlight.visible).toBe(false);
    lines.clear();
    expect(attrs(lines).main.visible).toBe(false);
    expect(lines.network).toBe(null);
  });

  it('dims the other links while a place is highlighted', () => {
    const src = chain();
    const net = computeNetwork([src], options);
    const lines = new JumpLines();
    lines.set(net, 100, 'stars');
    const opacity = () => ((attrs(lines).main as unknown as { material: ShaderMaterial }).material.uniforms.uOpacity.value as number);
    lines.update(new Vector3(1000, 0, 0), 20, 0.6);
    expect(opacity()).toBeCloseTo(0.6);
    lines.highlight(placeOfStar(net.places, 'r', 2));
    lines.update(new Vector3(1000, 0, 0), 20, 0.6);
    expect(opacity()).toBeCloseTo(0.6 * JUMP_DIM);
    // a place without links highlights nothing and dims nothing
    lines.highlight(placeOfStar(net.places, 'r', 5));
    lines.update(new Vector3(1000, 0, 0), 20, 0.6);
    expect(opacity()).toBeCloseTo(0.6);
  });
});
