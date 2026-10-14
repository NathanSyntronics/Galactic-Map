import { defineConfig } from 'vitest/config';

// Relative base so the build works from any sub-path (GitHub Pages, previews).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['tests/js/**/*.test.ts'],
  },
});
