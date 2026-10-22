// Benchmark of the route planning core: a synthetic 500 ly corridor and the real Sun–Betelgeuse corridor.
// Usage: node tools/bench-route.mjs
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const { module } = await runnerImport(fileURLToPath(new URL('./route-bench.ts', import.meta.url)), { root, logLevel: 'warn' });
await module.main(root);
