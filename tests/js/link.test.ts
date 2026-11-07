import { describe, expect, it } from 'vitest';
import { hasLinkState, linkParams, readLink, type LinkState } from '../../src/data/link';

const params = (hash: string) => new URLSearchParams(hash.replace(/^[#&]/, ''));

describe('shared links', () => {
  it('carries a selected star by designation and node', () => {
    const s: LinkState = { star: { designation: 'HIP 27989', path: 'r5222', index: 17 } };
    const q = linkParams(s);
    expect(q).toBe('&s=HIP+27989&sk=r5222:17');
    expect(readLink(params(`c=1,2,3${q}`))).toEqual(s);
  });

  it('carries a planet by name and a galaxy by designation and index', () => {
    expect(readLink(params(linkParams({ planet: 'TRAPPIST-1 e' })))).toEqual({ planet: 'TRAPPIST-1 e' });
    const g: LinkState = { galaxy: { designation: 'PGC 2557', index: 41 } };
    expect(linkParams(g)).toBe('&g=PGC+2557&gi=41');
    expect(readLink(params(linkParams(g)))).toEqual(g);
  });

  it('carries a route with both ends and the mode', () => {
    const s: LinkState = {
      route: {
        from: { designation: 'Sun', path: 'r', index: 0, pos: [0, 0, 0] },
        to: { designation: 'HIP 27989', path: 'r52', index: 3, pos: [-462.8301234567, -77.54, 166.51] },
        mode: 'distance',
      },
    };
    const q = linkParams(s);
    expect(q).toContain('&rm=d');
    const back = readLink(params(q));
    expect(back.route?.mode).toBe('distance');
    expect(back.route?.from).toEqual(s.route!.from);
    expect(back.route?.to?.pos[0]).toBeCloseTo(-462.8301234567, 6);
    expect(back.route?.to?.designation).toBe('HIP 27989');
  });

  it('keeps designations with special characters intact', () => {
    const d = 'BD+20 2457 & Co./ä';
    expect(readLink(params(linkParams({ star: { designation: d, path: 'r1', index: 2 } }))).star?.designation).toBe(d);
  });

  it('leaves malformed parts out and reports whether there is anything', () => {
    expect(readLink(params('s=X&sk=bad key'))).toEqual({});
    expect(readLink(params('rf=X&rfk=r:1&rfp=1,2'))).toEqual({});
    expect(hasLinkState(readLink(params('c=1,2,3&o=4,5,6&r=20')))).toBe(false);
    expect(linkParams({})).toBe('');
    expect(hasLinkState({ planet: 'Earth' })).toBe(true);
  });
});
