import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  anchors,
  groupLabel,
  jointName,
  labelScore,
  mergeSystems,
  placeLabels,
  sharedName,
  skyBonus,
  type LabelCandidate,
  type Rect,
  type ScreenLabel,
} from '../../src/ui/labels';

describe('sharedName', () => {
  it('drops component letters shared by all members', () => {
    expect(sharedName(['Sirius A', 'Sirius B'])).toBe('Sirius');
    expect(sharedName(['Capella Aa', 'Capella Ab', 'Capella H'])).toBe('Capella');
    expect(sharedName(['Epsilon Indi Ba', 'Epsilon Indi Bb'])).toBe('Epsilon Indi');
    expect(sharedName(['Epsilon Indi Ba', 'Epsilon Indi Bb'], false)).toBe('Epsilon Indi B');
    expect(sharedName(['GJ 1245 Ab', 'V1581 Cygni'])).toBeNull();
    expect(sharedName(['Alpha Centauri A'])).toBe('Alpha Centauri');
    expect(sharedName(['Capella Aa', 'Capella Ab'], false)).toBe('Capella A');
    expect(sharedName(['Capella H', 'Capella L'], false)).toBeNull();
  });
});

describe('jointName', () => {
  it('joins the component letters of names with a common base', () => {
    expect(jointName(['Alpha Centauri A', 'Alpha Centauri B'])).toBe('Alpha Centauri AB');
    expect(jointName(['Alpha Centauri B', 'Alpha Centauri A'])).toBe('Alpha Centauri AB');
    expect(jointName(['Capella Aa', 'Capella Ab', 'Capella H'])).toBe('Capella AH');
    expect(jointName(['Gliese 105 C', 'Gliese 105 A'])).toBe('Gliese 105 AC');
    expect(jointName(['Capella H', 'Capella L'])).toBeNull(); // L is not a component letter
  });

  it('gives up when the bases differ or a name has no component letter', () => {
    expect(jointName(['Alpha Centauri A', 'Proxima Centauri'])).toBeNull();
    expect(jointName(['GJ 1245 Ab', 'V1581 Cygni'])).toBeNull();
    expect(jointName(['Sirius', 'Sirius B'])).toBeNull();
  });
});

describe('groupLabel', () => {
  it('names a label that stands for the whole system after the system', () => {
    expect(groupLabel(['Sirius A', 'Sirius B'], true, 'Sirius')).toBe('Sirius');
    // members without a common base: the system name instead of the leader's own name
    expect(groupLabel(['Alpha Centauri A', 'Alpha Centauri B', 'Proxima Centauri'], true, 'Alpha Centauri')).toBe(
      'Alpha Centauri',
    );
    expect(groupLabel(['GJ 1245 Ab', 'V1581 Cygni'], true, 'GJ 1245')).toBe('GJ 1245');
    // a lone companion with a name of its own keeps it
    expect(groupLabel(['Proxima Centauri'], true, 'Alpha Centauri')).toBe('Proxima Centauri');
    // a leader with a name of its own (not a component name) is what the system is called
    expect(groupLabel(['Fomalhaut', 'TW Piscis Austrini', 'Fomalhaut C'], true, 'Alpha Piscis Austrini')).toBe(
      'Fomalhaut',
    );
    expect(groupLabel(['VV Lyncis Aa', 'Ross 989', 'VV Lyncis Ab'], true, 'VV Lyncis')).toBe('VV Lyncis');
    // no system name: the leader's name
    expect(groupLabel(['GJ 1245 Ab', 'V1581 Cygni'], true, undefined)).toBe('GJ 1245 Ab');
  });

  it('joins component letters when other members have labels of their own', () => {
    expect(groupLabel(['Alpha Centauri A', 'Alpha Centauri B'], false, 'Alpha Centauri')).toBe('Alpha Centauri AB');
    expect(groupLabel(['Epsilon Indi Ba', 'Epsilon Indi Bb'], false, 'Epsilon Indi')).toBe('Epsilon Indi B');
    expect(groupLabel(['61 Cygni B'], false, '61 Cygni')).toBe('61 Cygni B');
    expect(groupLabel(['Epsilon Indi Ba'], false, 'Epsilon Indi')).toBe('Epsilon Indi Ba');
  });
});

describe('mergeSystems', () => {
  let n = 0;
  const item = (text: string, x: number, y: number, extra: Partial<LabelCandidate> = {}): ScreenLabel => {
    const c: LabelCandidate = { key: `k${n++}:${text}`, pos: new Vector3(), text, rank: 0, logL: 0, ...extra };
    return { c, score: 0, x, y, fade: 1, text };
  };
  const acen = { sys: 9135, sysName: 'Alpha Centauri' };
  const texts = (v: ScreenLabel[]) => v.map((it) => it.text);

  it('names a merged Alpha Centauri triple after the system', () => {
    const v = mergeSystems(
      [item('Alpha Centauri A', 100, 100, acen), item('Alpha Centauri B', 100, 100, acen), item('Proxima Centauri', 105, 103, acen)],
      null,
    );
    expect(texts(v)).toEqual(['Alpha Centauri']);
  });

  it('joins A and B when Proxima has its own label', () => {
    const v = mergeSystems(
      [item('Alpha Centauri A', 100, 100, acen), item('Alpha Centauri B', 100, 100, acen), item('Proxima Centauri', 300, 200, acen)],
      null,
    );
    expect(texts(v)).toEqual(['Alpha Centauri AB', 'Proxima Centauri']);
  });

  it('counts the selected star as a separately labelled member (61 Cygni)', () => {
    const cyg = { sys: 13549, sysName: '61 Cygni' };
    const a = item('61 Cygni A', 100, 100, cyg);
    const b = item('61 Cygni B', 160, 120, cyg);
    expect(texts(mergeSystems([a, b], null))).toEqual(['61 Cygni A', '61 Cygni B']);
    // A selected: B must not become "61 Cygni"
    expect(texts(mergeSystems([a, b], a.c.key))).toEqual(['61 Cygni A', '61 Cygni B']);
    // B selected while both coincide: the selected label keeps its own name, A joins it
    const a2 = item('61 Cygni A', 100, 100, cyg);
    const b2 = item('61 Cygni B', 101, 100, cyg);
    expect(texts(mergeSystems([b2, a2], b2.c.key))).toEqual(['61 Cygni B']);
    // nothing selected and coinciding: the whole system
    expect(texts(mergeSystems([a2, b2], null))).toEqual(['61 Cygni']);
  });

  it('leaves single stars and catalogue designations alone', () => {
    const v = mergeSystems([item('Vega', 10, 10), item('Gaia DR3 1', 10, 10, { rank: 99, sys: 5 }), item('Gaia DR3 2', 10, 10, { rank: 99, sys: 5 })], null);
    expect(texts(v)).toEqual(['Vega', 'Gaia DR3 1', 'Gaia DR3 2']);
  });
});

describe('label placement', () => {
  const measure = (_font: string, text: string) => text.length * 6;
  const item = (text: string, x: number, y: number, rank = 0): ScreenLabel => ({
    c: { key: text, pos: new Vector3(), text, rank, logL: 0 },
    score: 0,
    x,
    y,
    fade: 1,
    text,
  });
  const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  it('tries the other anchors before dropping a label', () => {
    // three stars close together: each gets a label at a different anchor
    const placed: Rect[] = [];
    const out = placeLabels([item('Sun', 100, 100), item('Sirius', 104, 102), item('Procyon', 98, 96)], {
      maxLabels: 10,
      selectedKey: null,
      measure,
      placed,
    });
    expect(out.map((l) => l.item.text)).toEqual(['Sun', 'Sirius', 'Procyon']);
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) expect(overlap(out[i].rect, out[j].rect)).toBe(false);
    expect(out[0].tx).toBeGreaterThan(100); // first choice: right of the star
    expect(out[1].tx).toBeLessThan(104); // right side taken
  });

  it('drops a label only when all anchors are taken, but never the selected one', () => {
    const blocker: Rect = { x: 0, y: 0, w: 400, h: 400 };
    const out = placeLabels([item('Vega', 200, 200), item('Altair', 220, 220)], {
      maxLabels: 10,
      selectedKey: 'Altair',
      measure,
      placed: [blocker],
    });
    expect(out.map((l) => l.item.text)).toEqual(['Altair']);
  });

  it('has eight distinct anchors, the first one right of the star', () => {
    const a = anchors(100, 100, 30);
    expect(a).toHaveLength(8);
    expect(new Set(a.map((o) => `${o.tx},${o.ty}`)).size).toBe(8);
    expect(a[0].r.x).toBeGreaterThan(100);
    expect(a[1].r.x + a[1].r.w).toBeLessThan(100);
  });
});

describe('label priority', () => {
  it('boosts stars that are bright in Earth\'s sky, moderately', () => {
    expect(skyBonus(undefined)).toBe(0);
    expect(skyBonus(10)).toBe(0);
    expect(skyBonus(-1.46)).toBe(2.5); // Sirius
    expect(skyBonus(0.34)).toBeGreaterThan(skyBonus(1.14)); // Procyon over Pollux
    expect(skyBonus(-30)).toBe(2.5);
  });

  it('ranks Sirius above a fainter, equally distant named star', () => {
    const sirius: LabelCandidate = { key: 's', pos: new Vector3(), text: 'Sirius', rank: 0, logL: 1.4, appMag: -1.46 };
    const pollux: LabelCandidate = { key: 'p', pos: new Vector3(), text: 'Pollux', rank: 0, logL: 1.6, appMag: 1.14 };
    expect(labelScore(sirius, 110)).toBeGreaterThan(labelScore(pollux, 110));
  });
});
