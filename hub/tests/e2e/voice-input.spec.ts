import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — Voice input (mic) privilege friction + stress.

   Headless Chromium cannot run REAL speech recognition (the engine needs
   Google's speech service and a live microphone), so these tests inject a
   scriptable FakeSpeechRecognition via addInitScript BEFORE the app loads and
   drive the genuine UI through every privilege roadblock a browser can raise:

     - API absent entirely (Firefox)                    → mic hides itself
     - Permission denied ('not-allowed' /
       'service-not-allowed' — also what Brave and
       keyless Chromium builds raise)                   → actionable banner
     - No microphone attached ('audio-capture')         → actionable banner
     - Engine offline ('network' — Chrome's recognizer
       is cloud-backed)                                 → actionable banner
     - Silence timeout / user abort ('no-speech',
       'aborted')                                       → NO banner (benign)
     - Engine auto-ending the session (onend)           → button resets

   Plus dictation correctness (interim → final replacement, merging onto typed
   text, send-stops-mic) and a stress pass (rapid toggling, a 120-event result
   flood, long transcripts).

   Auth/mocks mirror chat-happy-path.spec.ts: genuine next-auth cookie, every
   backend mocked with page.route.
   ════════════════════════════════════════════════════════════════════════════ */

const SECRET = 'playwright-e2e-secret'

type Seg = { text: string; isFinal: boolean }

async function mockBackend(page: Page) {
  await page.route('**/api/**', route => route.fulfill({ json: {} }))
  await page.route('**/api/auth/session', route =>
    route.fulfill({
      json: {
        user: { name: 'Test User', email: 'danny@rxfitatx.com', role: 'admin', assignedProjects: ['*'] },
        expires: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }),
  )
  await page.route('**/api/kpis**', route => route.fulfill({ json: { kpis: [], projects: [] } }))
  await page.route('**/api/paperclip/**', route => route.fulfill({ status: 404, json: { error: 'not found' } }))
  await page.route('**/api/feed**', route => route.fulfill({ json: { feed: [] } }))
  await page.route('**/api/companies**', route => route.fulfill({ json: { companies: [] } }))
  await page.route('**/api/google/**', route => route.fulfill({ json: {} }))
  await page.route('**/api/tool-artifacts**', route => route.fulfill({ json: { artifacts: [] } }))
}

/**
 * Install a controllable SpeechRecognition double. Must run before page load
 * so the hook's feature-detect sees it. Exposes window.__voiceCtl for tests
 * to emit results/errors and inspect start/stop/abort counts.
 */
function installFakeSpeech(page: Page) {
  return page.addInitScript(() => {
    const ctl = {
      active: null as unknown,
      started: 0,
      stopped: 0,
      aborted: 0,
    }
    ;(window as unknown as Record<string, unknown>).__voiceCtl = ctl
    class FakeSpeechRecognition {
      continuous = false
      interimResults = false
      lang = ''
      onresult: ((e: unknown) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      onend: (() => void) | null = null
      start() { ctl.started++; ctl.active = this }
      stop() { ctl.stopped++; if (ctl.active === this) ctl.active = null; this.onend?.() }
      abort() { ctl.aborted++; if (ctl.active === this) ctl.active = null; this.onend?.() }
    }
    Object.defineProperty(window, 'SpeechRecognition', { value: FakeSpeechRecognition, configurable: true })
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: FakeSpeechRecognition, configurable: true })
  })
}

/** Simulate a browser with no Web Speech API at all (Firefox). */
function removeSpeechApi(page: Page) {
  return page.addInitScript(() => {
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true })
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true })
  })
}

/** Fire a recognition result event on the live session. */
function emitResults(page: Page, segments: Seg[]) {
  return page.evaluate((segs: Seg[]) => {
    const ctl = (window as unknown as Record<string, any>).__voiceCtl
    const results = segs.map(s => Object.assign([{ transcript: s.text }], { isFinal: s.isFinal }))
    ctl.active?.onresult?.({ results })
  }, segments)
}

/** Fire a recognition error (the engine also ends the session after these). */
function emitError(page: Page, code: string) {
  return page.evaluate((c: string) => {
    const ctl = (window as unknown as Record<string, any>).__voiceCtl
    const inst = ctl.active
    inst?.onerror?.({ error: c })
    ctl.active = null
    inst?.onend?.()
  }, code)
}

/** Simulate the engine ending the session on its own (silence timeout). */
function emitEnd(page: Page) {
  return page.evaluate(() => {
    const ctl = (window as unknown as Record<string, any>).__voiceCtl
    const inst = ctl.active
    ctl.active = null
    inst?.onend?.()
  })
}

function ctlCounts(page: Page) {
  return page.evaluate(() => {
    const ctl = (window as unknown as Record<string, any>).__voiceCtl
    return { started: ctl.started, stopped: ctl.stopped, aborted: ctl.aborted }
  })
}

async function gotoHub(page: Page) {
  await page.goto('/', { timeout: 80_000 })
  await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible({ timeout: 60_000 })
}

test.beforeEach(async ({ page, context, baseURL }) => {
  const sessionToken = await encode({
    token: {
      name: 'Test User', email: 'danny@rxfitatx.com', sub: 'test-user',
      role: 'admin', assignedProjects: ['*'], accessToken: 'fake-access-token',
    },
    secret: SECRET,
  })
  await context.addCookies([{
    name: 'next-auth.session-token', value: sessionToken, url: baseURL!,
    httpOnly: true, sameSite: 'Lax',
  }])
  await mockBackend(page)
  await page.addInitScript(() => localStorage.setItem('hub-onboarded', '1'))
})

/* ── Capability / privilege roadblocks per browser ── */

test('browser without the Web Speech API (Firefox): mic button is absent, composer still works', async ({ page }) => {
  await removeSpeechApi(page)
  await gotoHub(page)
  await expect(page.locator('.chat-mic-btn')).toHaveCount(0)
  // The rest of the composer is untouched by the missing API.
  await expect(page.getByLabel('Chat message input')).toBeVisible()
  await expect(page.getByLabel('Send message')).toBeVisible()
})

test('supported browser: mic button renders and toggles listening state', async ({ page }) => {
  await installFakeSpeech(page)
  await gotoHub(page)
  const mic = page.locator('.chat-mic-btn')
  await expect(mic).toBeVisible()
  await expect(mic).toHaveAttribute('aria-pressed', 'false')

  await mic.click()
  await expect(mic).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.voice-listening-banner')).toBeVisible()

  await mic.click() // toggle off
  await expect(mic).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.voice-listening-banner')).toHaveCount(0)
  const counts = await ctlCounts(page)
  expect(counts.started).toBe(1)
  expect(counts.stopped).toBeGreaterThanOrEqual(1)
})

test('microphone permission denied (not-allowed): actionable banner, listening state cleared', async ({ page }) => {
  await installFakeSpeech(page)
  await gotoHub(page)
  await page.locator('.chat-mic-btn').click()
  await emitError(page, 'not-allowed')
  await expect(page.locator('.voice-error-banner')).toContainText(/microphone access was blocked/i)
  await expect(page.locator('.chat-mic-btn')).toHaveAttribute('aria-pressed', 'false')
})

test('enterprise-policy / Brave-style block (service-not-allowed): same permission guidance', async ({ page }) => {
  await installFakeSpeech(page)
  await gotoHub(page)
  await page.locator('.chat-mic-btn').click()
  await emitError(page, 'service-not-allowed')
  await expect(page.locator('.voice-error-banner')).toContainText(/microphone access/i)
})

test('no microphone attached (audio-capture): actionable banner', async ({ page }) => {
  await installFakeSpeech(page)
  await gotoHub(page)
  await page.locator('.chat-mic-btn').click()
  await emitError(page, 'audio-capture')
  await expect(page.locator('.voice-error-banner')).toContainText(/no microphone was found/i)
})

test('recognizer offline (network): actionable banner', async ({ page }) => {
  await installFakeSpeech(page)
  await gotoHub(page)
  await page.locator('.chat-mic-btn').click()
  await emitError(page, 'network')
  await expect(page.locator('.voice-error-banner')).toContainText(/network connection/i)
})

test('benign endings (no-speech / aborted / engine auto-end): no error banner, button resets', async ({ page }) => {
  await installFakeSpeech(page)
  await gotoHub(page)
  const mic = page.locator('.chat-mic-btn')

  await mic.click()
  await emitError(page, 'no-speech')
  await expect(mic).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.voice-error-banner')).toHaveCount(0)

  await mic.click()
  await emitError(page, 'aborted')
  await expect(mic).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.voice-error-banner')).toHaveCount(0)

  // Engine ends the session itself (silence timeout) — no error event at all.
  await mic.click()
  await emitEnd(page)
  await expect(mic).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.voice-error-banner')).toHaveCount(0)
})

/* ── Dictation correctness ── */

test('interim words render live and are replaced when finalized; dictation appends to typed text', async ({ page }) => {
  await installFakeSpeech(page)
  await gotoHub(page)
  const input = page.getByLabel('Chat message input')

  await input.fill('Reminder:')
  await page.locator('.chat-mic-btn').click()

  await emitResults(page, [{ text: 'call the', isFinal: false }])
  await expect(input).toHaveValue('Reminder: call the')

  // Engine revises the interim as it finalizes — the interim must be REPLACED.
  await emitResults(page, [{ text: 'call the vendor ', isFinal: true }])
  await expect(input).toHaveValue('Reminder: call the vendor')

  await emitResults(page, [
    { text: 'call the vendor ', isFinal: true },
    { text: 'tomorrow morning', isFinal: false },
  ])
  await expect(input).toHaveValue('Reminder: call the vendor tomorrow morning')
})

test('sending stops the mic and posts the dictated text to /api/chat', async ({ page }) => {
  await installFakeSpeech(page)
  let postedBody = ''
  await page.route('**/api/chat', route => {
    postedBody = route.request().postData() ?? ''
    return route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"text":"Got it"}\n\ndata: [DONE]\n\n',
    })
  })
  await gotoHub(page)

  await page.locator('.chat-mic-btn').click()
  await emitResults(page, [{ text: 'what projects need attention today', isFinal: true }])
  await expect(page.getByLabel('Chat message input')).toHaveValue('what projects need attention today')

  await page.getByLabel('Send message').click()

  // The reply renders, the dictated sentence went over the wire, and the mic session ended.
  await expect(page.locator('.chat-bubble-ai').last()).toContainText('Got it', { timeout: 15_000 })
  expect(postedBody).toContain('what projects need attention today')
  await expect(page.locator('.chat-mic-btn')).toHaveAttribute('aria-pressed', 'false')
  const counts = await ctlCounts(page)
  expect(counts.stopped + counts.aborted).toBeGreaterThanOrEqual(1)
})

/* ── Stress ── */

test('stress: rapid mic toggling never wedges the button or leaks sessions', async ({ page }) => {
  await installFakeSpeech(page)
  await gotoHub(page)
  const mic = page.locator('.chat-mic-btn')

  for (let i = 0; i < 10; i++) {
    await mic.click() // on
    await mic.click() // off
  }
  await expect(mic).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.voice-error-banner')).toHaveCount(0)

  const counts = await ctlCounts(page)
  expect(counts.started).toBe(10)
  // Every started session was ended (stop or abort) — nothing left running.
  expect(counts.stopped + counts.aborted).toBeGreaterThanOrEqual(10)

  // The button still works after the churn.
  await mic.click()
  await emitResults(page, [{ text: 'still alive', isFinal: true }])
  await expect(page.getByLabel('Chat message input')).toHaveValue('still alive')
})

test('stress: a 120-event result flood with a long transcript stays correct and responsive', async ({ page }) => {
  await installFakeSpeech(page)
  await gotoHub(page)
  const input = page.getByLabel('Chat message input')
  await page.locator('.chat-mic-btn').click()

  // Simulate a long dictation: 120 rapid-fire onresult events, each growing
  // the finalized list by one segment plus a churning interim tail — the
  // worst-case event pattern Chrome produces on continuous dictation.
  await page.evaluate(() => {
    const ctl = (window as unknown as Record<string, any>).__voiceCtl
    const finals: unknown[] = []
    for (let i = 1; i <= 120; i++) {
      finals.push(Object.assign([{ transcript: `word${i} ` }], { isFinal: true }))
      const interim = Object.assign([{ transcript: 'partial tail' }], { isFinal: false })
      ctl.active?.onresult?.({ results: [...finals, interim] })
    }
    // Final event: everything finalized, tail resolved.
    finals.push(Object.assign([{ transcript: 'the end' }], { isFinal: true }))
    ctl.active?.onresult?.({ results: finals })
  })

  const value = await input.inputValue()
  expect(value.startsWith('word1 word2 ')).toBe(true)
  expect(value.endsWith('word120 the end')).toBe(true)
  expect(value).not.toContain('partial tail') // no stale interim left behind

  // UI is still responsive: stop the mic and type normally.
  await page.locator('.chat-mic-btn').click()
  await expect(page.locator('.chat-mic-btn')).toHaveAttribute('aria-pressed', 'false')
  await input.fill('typed after flood')
  await expect(input).toHaveValue('typed after flood')
})
