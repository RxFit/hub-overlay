// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ProjectHealthSection } from './ProjectHealthSection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root
  act(() => {
    root = createRoot(container)
    root.render(element)
  })
  return { container, root: root! }
}

let mounted: ReturnType<typeof render> | undefined

afterEach(() => {
  if (!mounted) return
  act(() => mounted!.root.unmount())
  mounted.container.remove()
  mounted = undefined
})

describe('ProjectHealthSection degraded state', () => {
  it('shows partial-source failure instead of the healthy empty-state copy', () => {
    mounted = render(createElement(ProjectHealthSection, {
      projects: [],
      degraded: true,
      onInjectChat: () => {},
    }))

    expect(mounted.container.textContent).toContain('Operational project data is temporarily unavailable')
    expect(mounted.container.textContent).not.toContain('No companies in Paperclip yet')
    expect(mounted.container.querySelector('[role="status"]')).not.toBeNull()
  })
})
