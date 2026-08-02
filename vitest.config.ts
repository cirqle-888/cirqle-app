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
    // figma-plugin/ holds self-contained plugin projects with their own module
    // resolution (e.g. '@shared/types'), which this config does not provide —
    // their suites fail on import here without saying anything about the app.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', '_archive/**', 'figma-plugin/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
