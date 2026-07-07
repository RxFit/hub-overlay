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
      // baseline (lines/statements 29.98%, branches 71.87%, functions 54.19%)
      // so it passes today and never regresses. In CI the DB-backed suite runs
      // and coverage rises above these; locally it skips and still clears them.
      // Raise these as coverage improves; CI fails if any metric drops below.
      thresholds: {
        lines: 27,
        functions: 51,
        branches: 68,
        statements: 27,
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
