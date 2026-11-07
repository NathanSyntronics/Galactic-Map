import { version } from '../package.json';

/**
 * The version as shown in the app: 1.00, 1.01, 1.02, ... (README "Versions"). package.json holds
 * it in the semver form npm needs, the minor number counting the steps: 1.0.0 is 1.00, 1.1.0 is
 * 1.01, 1.12.0 is 1.12.
 */
export function displayVersion(semver: string): string {
  const [major, minor] = semver.split('.').map(Number);
  return `${major}.${String(minor).padStart(2, '0')}`;
}

export const VERSION = displayVersion(version);
