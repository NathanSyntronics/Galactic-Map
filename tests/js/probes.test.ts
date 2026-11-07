import { describe, expect, it } from 'vitest';
import { AU_PER_LY } from '../../src/data/planets';
import { decodeProbes, probeIndex, probePosition, probeSpeed, type ProbeFile } from '../../src/data/probes';

const FILE: ProbeFile = {
  format: 'galmap-probes',
  version: 1,
  probes: [
    {
      key: 'voyager1',
      name: 'Voyager 1',
      launch: '1977-09-05',
      // galactic AU: 10 AU along x at day 100, 20 AU at day 200, then 0.01 AU/day along y
      t: [0, 100, 200],
      p: [[0, 0, 0], [10, 0, 0], [20, 0, 0]],
      v: [0, 0.01, 0],
    },
  ],
  sources: [],
};

describe('probes', () => {
  const cat = decodeProbes(FILE);
  const probe = cat.probes[0];

  it('decodes the trajectory into the world frame (ly)', () => {
    expect(probe.p[3]).toBeCloseTo(10 / AU_PER_LY, 15);
    // galactic y -> world -z
    expect(probe.v.z).toBeCloseTo(-0.01 / AU_PER_LY, 15);
  });

  it('interpolates in time, continues in a straight line, and is absent before launch', () => {
    expect(probePosition(probe, -1)).toBeNull();
    expect(probeIndex(probe, 150)).toBe(1);
    expect(probePosition(probe, 150)!.x * AU_PER_LY).toBeCloseTo(15, 9);
    const later = probePosition(probe, 300)!;
    expect(later.x * AU_PER_LY).toBeCloseTo(20, 9);
    expect(-later.z * AU_PER_LY).toBeCloseTo(1, 9);
  });

  it('gives the speed relative to the Sun in km/s', () => {
    // 0.1 AU per day = 173.1 km/s
    expect(probeSpeed(probe, 150)).toBeCloseTo((0.1 * 149_597_870.7) / 86400, 0);
    expect(probeSpeed(probe, -10)).toBeNaN();
  });
});
