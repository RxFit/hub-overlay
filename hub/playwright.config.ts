import { defineConfig } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Locate a pre-provisioned Chromium (e.g. /opt/pw-browsers in sandboxed CI
 *  images) so tests run even when the pinned browser build isn't downloaded. */
function findChromium(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!root || !existsSync(root)) return undefined
  for (const dir of readdirSync(root)) {
    if (!/^chromium-\d+$/.test(dir)) continue
    const bin = join(root, dir, 'chrome-linux', 'chrome')
    if (existsSync(bin)) return bin
  }
  const wrapper = join(root, 'chromium')
  return existsSync(wrapper) ? wrapper : undefined
}

const chromiumPath = findChromium()

/**
 * Browser-level tests for the left panel → AI chat inject path.
 *
 * Runs the real Next dev server with a throwaway NEXTAUTH_SECRET; each test
 * mints a genuine next-auth session cookie (so middleware passes) and mocks
 * every /api/* backend at the browser layer with page.route — no Google
 * credentials, database, or model keys are needed. Tests click the real
 * rendered panel rows and assert the exact payloads the UI sends to /api/chat.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  // The panel tests share one dev server; run serially to keep compile-time
  // interference out of the timings.
  workers: 1,
  // In CI also write the HTML report (uploaded as an artifact on failure).
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://localhost:3100',
    // Pre-provisioned Chromium (PLAYWRIGHT_BROWSERS_PATH may point at a
    // different build than this @playwright/test version pins).
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : undefined,
  },
  webServer: {
    command: 'npx next dev -p 3100',
    // /login is outside the auth middleware matcher → 200 without a session.
    url: 'http://localhost:3100/login',
    reuseExistingServer: true,
    timeout: 180_000,
    env: {
      ...process.env,
      NEXTAUTH_SECRET: 'playwright-e2e-secret',
      NEXTAUTH_URL: 'http://localhost:3100',
      NODE_ENV: 'development',
    },
  },
})
