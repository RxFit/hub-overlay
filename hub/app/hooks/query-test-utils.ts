import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// React 18 concurrent rendering requires an act environment flag.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Minimal renderHook for TanStack Query-backed hooks (NS-6 pattern, shared for
 * the NS-7 migration suites) — @testing-library/react is not a dependency, so
 * we drive the hook through a throwaway component with react-dom/client + act,
 * wrapped in a fresh QueryClientProvider (retries off, no gc) per render.
 */
export function renderQueryHook<T>(useHook: () => T) {
  const result: { current: T } = { current: undefined as unknown as T }
  const container = document.createElement('div')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  let root: Root

  function Probe() {
    result.current = useHook()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)))
  })

  return {
    result,
    unmount: () => act(() => { root.unmount() }),
  }
}

/** Let react-query's async queryFn settle. */
export const settleQueries = () => act(async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
})

export function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}
