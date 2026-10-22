// Regenerates the example factions (public/user/attributes.csv) from the star data in public/data.
// Usage: node tools/make-factions.mjs
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const { module } = await runnerImport(fileURLToPath(new URL('./factions.ts', import.meta.url)), { root, logLevel: 'warn' });
module.main(root);
