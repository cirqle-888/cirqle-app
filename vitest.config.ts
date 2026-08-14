import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // TZ is deliberately NOT pinned here. Calendar dates resolve in
    // Asia/Kolkata explicitly (src/lib/utils/local-date.ts), so the suite must
    // pass whatever clock the machine is on — CI, a laptop, or Vercel's UTC.
    // Pinning it would hide exactly the process-timezone dependence the date
    // work removed. See src/lib/utils/ist-business-dates.test.ts.
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
