import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Separate from vite.config.ts / vite.main.config.ts on purpose — those are
// build configs (one has vite-plugin-singlefile, which has no business
// running during tests). Pure-logic tests only need the path aliases and a
// plain Node environment (no DOM needed — nothing under test touches figma
// or the browser; see docs/ARCHITECTURE.md's "pure function" pattern).
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@ui': path.resolve(__dirname, 'src/ui'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
