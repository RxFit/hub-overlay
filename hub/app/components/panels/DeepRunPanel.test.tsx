// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import DeepRunPanel from './DeepRunPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* ════════════════════════════════════════════════════════════════════════════
   DeepRunPanel — the landed report is an artifact, automatically.

   The old contract fed the report into the tool panel's manual Save & Close;
   a user who navigated away kept nothing. Now adopting a finished run asks the
   idempotent `save_artifact` action for the artifact id and shows the truth:
   Saving… → Saved to Artifacts, or Couldn't save + Retry. These lock that
   contract at the component boundary with fetch mocked.
   ════════════════════════════════════════════════════════════════════════════ */

const REPORT = [
  '# Churn drivers', '', 'Price is the driver.', '',
  '```json',
  JSON.stringify({ title: 'Churn drivers', summary: 'Price is the driver.', sections: [{ heading: 'Evidence', body: 'cohorts' }], sources: [] }),
  '```',
].join('\n')

const LANDED_RUN = {
  id: 'run-1', tool: 'deep-research', status: 'succeeded', liveStatus: 'succeeded',
  brief: 'Why are customers churning?', resultMd: REPORT, errorClass: null, error: null,
  createdAt: new Date(Date.now() - 300_000).toISOString(), finishedAt: new Date().toISOString(),
}

type FetchCall = { url: string; method: string; body: unknown }

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response
}

/** Mock fetch: the mount reattach finds a landed run; save_artifact answers
 *  per `saveResponses` (a queue — one entry per call, last one repeats). */
function installFetch(saveResponses: Array<() => Response>) {
  const calls: FetchCall[] = []
  const queue = [...saveResponses]
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.startsWith('/api/deep-runs?')) return jsonResponse({ runs: [LANDED_RUN] })
    if (url === '/api/deep-runs/run-1' && method === 'POST') {
      const next = queue.length > 1 ? queue.shift()! : queue[0]
      return next()
    }
    if (url === '/api/deep-runs/run-1') return jsonResponse({ run: LANDED_RUN })
    return jsonResponse({})
  }))
  return calls
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let queryClient: QueryClient

function renderPanel(props: Partial<Parameters<typeof DeepRunPanel>[0]> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  queryClient = new QueryClient()
  const onArtifactUpdate = vi.fn()
  act(() => {
    root = createRoot(container!)
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(DeepRunPanel, {
          toolId: 'deep-research',
          contextSummary: null,
          messages: [],
          onInjectChat: vi.fn(),
          onArtifactUpdate,
          artifacts: null,
          chatId: 'chat-1',
          ...props,
        }),
      ),
    )
  })
  return { onArtifactUpdate }
}

/** Let the mount fetch → adopt → save chain settle. */
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

const saveCalls = (calls: FetchCall[]) => calls.filter(c => c.method === 'POST' && c.url === '/api/deep-runs/run-1')

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

describe('DeepRunPanel — landed report auto-save', () => {
  it('reattaches to the landed run, asks save_artifact exactly once, and shows "Saved to Artifacts"', async () => {
    const calls = installFetch([() => jsonResponse({ artifact: { id: 'art-1', title: 'Deep Research: Churn drivers', created: true } })])
    const invalidate = vi.fn()
    const { onArtifactUpdate } = renderPanel()
    queryClient.invalidateQueries = invalidate as unknown as QueryClient['invalidateQueries']
    await settle()

    expect(container!.textContent).toContain('Churn drivers')
    expect(container!.textContent).toContain('Saved to Artifacts')
    expect(saveCalls(calls)).toEqual([{ url: '/api/deep-runs/run-1', method: 'POST', body: { action: 'save_artifact' } }])
    // The Documents › Artifacts list refreshes without a reload.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tool-artifacts'] })
    // The manual Save & Close path is no longer fed — no double save on close.
    expect(onArtifactUpdate).not.toHaveBeenCalled()
  })

  it('a failed save is shown honestly with a Retry that asks again', async () => {
    const calls = installFetch([
      () => jsonResponse({ error: 'Failed to save the report as an artifact' }, 500),
      () => jsonResponse({ artifact: { id: 'art-1', title: 'Deep Research: Churn drivers', created: false } }),
    ])
    renderPanel()
    await settle()

    expect(container!.textContent).toContain("Couldn't save to Artifacts")
    const retry = Array.from(container!.querySelectorAll('button')).find(b => b.textContent === 'Retry')
    expect(retry).toBeTruthy()

    await act(async () => { retry!.click() })
    await settle()

    expect(saveCalls(calls)).toHaveLength(2)
    expect(container!.textContent).toContain('Saved to Artifacts')
    expect(container!.textContent).not.toContain("Couldn't save")
  })

  it('a network failure on save degrades to the retry state, never an unhandled rejection', async () => {
    installFetch([() => { throw new Error('offline') }])
    renderPanel()
    await settle()
    expect(container!.textContent).toContain("Couldn't save to Artifacts")
  })

  it('no longer tells the user to Save & Close — the report stays in Artifacts across a New run', async () => {
    installFetch([() => jsonResponse({ artifact: { id: 'art-1', title: 't', created: true } })])
    renderPanel()
    await settle()
    expect(container!.textContent).not.toContain('Save & Close')
    expect(container!.textContent).toContain('stays in your Artifacts')
  })
})
