import { describe, expect, it } from 'vitest';
import { sharedName } from '../../src/ui/labels';

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
