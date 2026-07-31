import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Agent worktrees under .claude/ contain full copies of src, so vitest was
    // discovering and running the same suites two or three times over (118 test
    // files for ~45 real ones). Excluding them roughly halves the run without
    // losing any coverage — the real suite still lives in src/.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', '_archive/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
