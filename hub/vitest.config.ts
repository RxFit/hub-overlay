import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'tests/**/*.test.ts', 'app/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Text summary in CI logs; lcov for optional downstream tooling.
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: './coverage',
      // Measure the source we actually test. Broadening `include` beyond this
      // (e.g. all of app/**) would drag the baseline down with large untested
      // UI surfaces and defeat the ratchet — keep it to the covered code and
      // grow it deliberately as suites are added.
      include: ['lib/**/*.ts', 'app/api/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'lib/schema.ts',
        'lib/types/**',
        '**/__mocks__/**',
      ],
      // Ratchet floor — set a couple points below the current measured
      // NO-DB baseline (lines/statements 38.02%, branches 75.43%, functions
      // 61.97% as of NS-8). The no-DB run is the conservative lower bound:
      // locally the DB-backed suites skip; with a DB (CI) they run and
      // coverage lands higher (40.60/76.57/66.54 lines/branches/functions),
      // so a floor that clears the local run clears CI too. Raise these as
      // coverage improves; the run fails if any metric drops below. Never
      // lower them.
      thresholds: {
        lines: 36,
        functions: 60,
        branches: 73,
        statements: 36,
      },
    },
  },
  resolve: {
    // Mirror the tsconfig "@/*" → "./*" path alias.
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
})
