import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { displayVersion, VERSION } from '../../src/version';

describe('version', () => {
  it('shows the semver of package.json as 1.00, 1.01, ...', () => {
    expect(displayVersion('1.0.0')).toBe('1.00');
    expect(displayVersion('1.1.0')).toBe('1.01');
    expect(displayVersion('1.12.0')).toBe('1.12');
    expect(displayVersion('2.3.0')).toBe('2.03');
  });

  it('is the version of package.json, two digits after the point', () => {
    expect(VERSION).toBe(displayVersion(pkg.version));
    expect(VERSION).toMatch(/^\d+\.\d\d$/);
  });
});
