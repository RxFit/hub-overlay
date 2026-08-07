import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // tsconfig sets jsx:"preserve" for Next's compiler; esbuild's default
  // fallback is the CLASSIC transform, which requires `import React` in every
  // component under test. Use the automatic runtime, matching what Next
  // actually compiles, so .tsx components render in tests as they do in prod.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'tests/**/*.test.ts', 'app/**/*.test.ts', 'app/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      // Text summary in CI logs; lcov for optional downstream tooling.
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: './coverage',
      // Measure the source we actually test. NS-11 widened the scope to
      // app/hooks/** (genuinely tested territory since NS-5–NS-7). Broadening
      // further (e.g. all of app/**) would drag the baseline down with large
      // untested JSX surfaces and defeat the ratchet — keep it to the covered
      // code and grow it deliberately as suites are added.
      include: ['lib/**/*.ts', 'app/api/**/*.ts', 'app/hooks/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'lib/schema.ts',
        'lib/types/**',
        '**/__mocks__/**',
        // Shared render/harness helper for the hook suites — test
        // infrastructure, not product code.
        'app/hooks/query-test-utils.ts',
        // Streaming chat engine — exercised by e2e; unit-hostile (777+ lines of
        // SSE streaming, DOM refs and abort plumbing). The ONLY hook excluded;
        // every other hook is measured. Remove if it ever gets a unit seam.
        'app/hooks/useChatEngine.ts',
      ],
      // Ratchet floor — set a couple points below the current measured
      // NO-DB baseline (lines/statements 47.00%, branches 81.14%, functions
      // 69.29% as of NS-11, which widened the scope to app/hooks/** and added
      // the google-route / gemini-rotation / hook suites). The no-DB run is
      // the conservative lower bound: locally the DB-backed suites skip; with
      // a DB (CI) they run and coverage lands higher, so a floor that clears
      // the local run clears CI too. Raise these as coverage improves; the
      // run fails if any metric drops below. Never lower them.
      thresholds: {
        lines: 45,
        functions: 67,
        branches: 79,
        statements: 45,
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
