import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  anchors,
  groupLabel,
  jointName,
  labelScore,
  mergeSystems,
  namedCandidateLimit,
  onScreen,
  placeLabels,
  starPriority,
  TopK,
  sharedName,
  skyBonus,
  spriteGap,
  ROUTE_BONUS,
  type LabelCandidate,
  type Rect,
  type ScreenLabel,
  milkyWayLabelPos,
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

  it('never merges a route end into another label, and keeps its own name', () => {
    const a = item('Alpha Centauri A', 100, 100, acen);
    const b = item('Alpha Centauri B', 101, 100, { ...acen, pinned: true });
    // A selected, B the route's destination: both labels stay
    expect(texts(mergeSystems([a, b], a.c.key))).toEqual(['Alpha Centauri A', 'Alpha Centauri B']);
    // nothing selected: B leads (pinned labels score highest) and keeps its own name
    expect(texts(mergeSystems([b, a], null))).toEqual(['Alpha Centauri B']);
    // a pinned designation-only star stays as it is
    const g = item('Gaia DR3 7', 100, 100, { rank: 99, sys: 3, pinned: true });
    expect(texts(mergeSystems([g], null))).toEqual(['Gaia DR3 7']);
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

  it('always places the route\'s start and destination, beyond the label limit', () => {
    const blocker: Rect = { x: 0, y: 0, w: 400, h: 400 };
    const pinned = item('Betelgeuse', 210, 210);
    pinned.c.pinned = true;
    const designation = item('Gaia DR3 1', 230, 230, 99);
    designation.c.pinned = true;
    const out = placeLabels([item('Vega', 200, 200), pinned, designation], {
      maxLabels: 0,
      selectedKey: null,
      measure,
      placed: [blocker],
    });
    expect(out.map((l) => l.item.text)).toEqual(['Betelgeuse', 'Gaia DR3 1']);
  });

  it('keeps labels inside the viewport', () => {
    // a star at the right edge: its label goes to the left
    const out = placeLabels([item('Procyon', 395, 100)], { maxLabels: 10, selectedKey: null, measure, placed: [], bounds: { w: 400, h: 300 } });
    expect(out).toHaveLength(1);
    expect(out[0].rect.x + out[0].rect.w).toBeLessThanOrEqual(400);
    expect(out[0].tx).toBeLessThan(395);
  });

  it('has twelve distinct anchors, the first one right of the star', () => {
    const a = anchors(100, 100, 30);
    expect(a).toHaveLength(12);
    expect(new Set(a.map((o) => `${o.tx},${o.ty}`)).size).toBe(12);
    expect(a[0].r.x).toBeGreaterThan(100);
    expect(a[1].r.x + a[1].r.w).toBeLessThan(100);
  });

  it('moves the anchors outwards beside a large sprite', () => {
    const near = anchors(100, 100, 30);
    const far = anchors(100, 100, 30, 20);
    expect(far[0].tx).toBe(near[0].tx + 20);
    expect(far[1].tx).toBe(near[1].tx - 20);
    expect(far[2].ty).toBe(near[2].ty - 20);
    expect(far[3].ty).toBe(near[3].ty + 20);
    for (let k = 0; k < 12; k++) {
      const dNear = Math.hypot(near[k].r.x + near[k].r.w / 2 - 100, near[k].r.y + near[k].r.h / 2 - 100);
      const dFar = Math.hypot(far[k].r.x + far[k].r.w / 2 - 100, far[k].r.y + far[k].r.h / 2 - 100);
      expect(dFar).toBeGreaterThan(dNear);
    }
  });

  it('keeps the usual distance from small sprites', () => {
    expect(spriteGap(3)).toBe(0);
    expect(spriteGap(20)).toBe(0);
    expect(spriteGap(64)).toBeCloseTo(9.08, 6);
    expect(spriteGap(192)).toBeGreaterThan(35);
  });
});

describe('label priority', () => {
  it('boosts stars that are bright in Earth\'s sky, moderately', () => {
    expect(skyBonus(undefined)).toBe(0);
    expect(skyBonus(10)).toBe(0);
    expect(skyBonus(-1.46)).toBe(4); // Sirius
    expect(skyBonus(0.34)).toBeGreaterThan(skyBonus(1.14)); // Procyon over Pollux
    expect(skyBonus(-30)).toBe(4);
    expect(skyBonus(4.5)).toBe(0);
  });

  it('ranks Sirius and Procyon above Pollux, which is more luminous but fainter in our sky', () => {
    // values of the real data set
    const sirius: LabelCandidate = { key: 's', pos: new Vector3(), text: 'Sirius', rank: 0, logL: 1.26, appMag: -1.08 };
    const procyon: LabelCandidate = { key: 'p', pos: new Vector3(), text: 'Procyon', rank: 0, logL: 0.81, appMag: 0.46 };
    const pollux: LabelCandidate = { key: 'x', pos: new Vector3(), text: 'Pollux', rank: 0, logL: 1.57, appMag: 1.23 };
    expect(labelScore(sirius, 110)).toBeGreaterThan(labelScore(pollux, 110));
    expect(labelScore(procyon, 110)).toBeGreaterThan(labelScore(pollux, 110));
  });

  it('labels the Milky Way at its centre, or towards it at the edge of the screen', () => {
    const cam = new PerspectiveCamera(55, 0.5, 1, 1e7);
    cam.position.set(0, 0, 50_000);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const vp = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
    const target = new Vector3(0, 0, 0);
    // centre on screen: there
    expect(milkyWayLabelPos(vp, target, new Vector3(5_000, 0, 0))!.x).toBe(5_000);
    // centre far off to the right: on the way to it, inside the screen
    const p = milkyWayLabelPos(vp, target, new Vector3(200_000, 0, 0))!;
    expect(p.x).toBeGreaterThan(5_000);
    expect(p.x).toBeLessThan(200_000);
    expect(p.clone().project(cam).x).toBeCloseTo(0.85, 2);
  });

  it('labels the Milky Way first, like the Sun', () => {
    const mw: LabelCandidate = { key: 'g:0', pos: new Vector3(), text: 'Milky Way', rank: 0, logL: 10.8, galaxy: 0, priority: true };
    const andromeda: LabelCandidate = { key: 'g:1', pos: new Vector3(), text: 'Andromeda Galaxy', rank: 0, logL: 10.7, galaxy: 1 };
    const sun: LabelCandidate = { key: 'r:0', pos: new Vector3(), text: 'Sun', rank: 0, logL: 0, sun: true, appMag: -26.7 };
    // far away, the Milky Way still beats a galaxy right in front of the camera
    expect(labelScore(mw, 1e7)).toBeGreaterThan(labelScore(andromeda, 1e3));
    expect(labelScore(mw, 1e7)).toBeGreaterThan(labelScore({ ...andromeda, priority: false }, 1));
    // as does the Sun
    expect(labelScore(sun, 1e7)).toBeGreaterThan(labelScore(andromeda, 1e3));
  });

  it('labels route waypoints before all other stars, named ones first, and the route\'s ends above everything', () => {
    const star: LabelCandidate = { key: 'a', pos: new Vector3(), text: 'A', rank: 99, logL: -1 };
    const waypoint: LabelCandidate = { ...star, key: 'w', route: true };
    const namedWaypoint: LabelCandidate = { ...waypoint, key: 'n', rank: 4 };
    const end: LabelCandidate = { ...star, key: 'e', pinned: true };
    const sun: LabelCandidate = { ...star, key: 's', rank: 0, logL: 0, sun: true };
    const bright: LabelCandidate = { ...star, key: 'b', rank: 0, logL: 4 };
    expect(labelScore(waypoint, 10) - labelScore(star, 10)).toBe(ROUTE_BONUS);
    // a faint, far waypoint without a name still comes before the Sun and bright named stars nearby
    expect(labelScore(waypoint, 1000)).toBeGreaterThan(labelScore(sun, 1));
    expect(labelScore(waypoint, 1000)).toBeGreaterThan(labelScore(bright, 1));
    expect(labelScore(namedWaypoint, 10)).toBeGreaterThan(labelScore(waypoint, 10));
    expect(labelScore(end, 1000)).toBeGreaterThan(labelScore(namedWaypoint, 1));
  });
});

describe('label candidates of large views', () => {
  // deterministic pseudo-random numbers
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  it('TopK keeps the k highest scores', () => {
    const r = rng(7);
    const scores = Array.from({ length: 5000 }, () => Math.round(r() * 1000) / 10);
    const top = new TopK<number>(50);
    scores.forEach((sc, k) => top.push(sc, k));
    const kept = top.items().map((k) => scores[k]).sort((a, b) => b - a);
    const best = [...scores].sort((a, b) => b - a).slice(0, 50);
    expect(kept).toEqual(best);
    expect(top.threshold).toBe(best[49]);
    const none = new TopK<number>(0);
    none.push(1, 1);
    expect(none.items()).toEqual([]);
  });

  it('starPriority is the label score without the route bonuses', () => {
    const c: LabelCandidate = { key: 'a', pos: new Vector3(), text: 'Vega', rank: 1, logL: 1.6, appMag: 0.03 };
    expect(starPriority(1.6, 25, 1, 0.03)).toBe(labelScore(c, 25));
    expect(starPriority(0, 1, 0, -26, true)).toBe(labelScore({ ...c, logL: 0, rank: 0, appMag: -26, sun: true }, 1));
  });

  it('onScreen accepts points in front of the camera within the screen and a margin', () => {
    const cam = new PerspectiveCamera(55, 1.6, 0.1, 1000);
    cam.position.set(0, 0, 10);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const m = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    expect(onScreen(m, 0, 0, 0)).toBe(true);
    expect(onScreen(m, 0, 0, 20)).toBe(false); // behind the camera
    // the half height at distance 10 is 10 tan(27.5°) = 5.2: 6 is beyond the edge but within the 25 % margin
    expect(onScreen(m, 0, 6, 0)).toBe(true);
    expect(onScreen(m, 0, 7, 0)).toBe(false);
    expect(onScreen(m, 0, 7, 0, 0.5)).toBe(true);
  });

  it('labels the same stars from the best candidates as from all of them', () => {
    const r = rng(11);
    const measure = (_f: string, text: string) => 6 * text.length;
    for (const maxLabels of [5, 30, 120]) {
      const all: ScreenLabel[] = Array.from({ length: 20000 }, (_, k) => {
        const c: LabelCandidate = { key: `n${k}`, pos: new Vector3(), text: `Star ${k}`, rank: Math.floor(r() * 8), logL: r() * 4 - 2 };
        return { c, score: r() * 10, x: r() * 1280, y: r() * 800, fade: 1, text: c.text };
      });
      const place = (items: ScreenLabel[]) =>
        placeLabels(
          [...items].sort((a, b) => b.score - a.score),
          { maxLabels, selectedKey: null, measure, placed: [], bounds: { w: 1280, h: 800 } },
        ).map((l) => l.item.c.key);
      const top = new TopK<ScreenLabel>(namedCandidateLimit(maxLabels));
      for (const it of all) top.push(it.score, it);
      const full = place(all);
      expect(full.length).toBe(maxLabels);
      expect(place([...top.items()])).toEqual(full);
    }
  });
});
