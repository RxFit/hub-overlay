// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ToolArtifactRecord } from '@/types'
import { ArtifactViewer, artifactToolName, formatArtifactDate } from './ArtifactViewer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* ════════════════════════════════════════════════════════════════════════════
   ArtifactViewer — a saved artifact is readable again, and discussable.
   ════════════════════════════════════════════════════════════════════════════ */

const ARTIFACT: ToolArtifactRecord = {
  id: 'art-1',
  toolId: 'deep-research',
  title: 'Deep Research: Churn drivers',
  content: {
    toolId: 'deep-research',
    title: 'Churn drivers',
    sections: [
      { id: 's1', type: 'recommendation', title: 'Summary', content: 'Price is the driver.' },
      {
        id: 's2', type: 'insight', title: 'Evidence', content: 'Three of four cohorts cite price.',
        children: [{ id: 's2a', type: 'generic', title: 'Cohort A', content: 'cites price first' }],
      },
      { id: 's3', type: 'generic', title: 'Sources', content: '[1] Cohort export — https://example.com/cohorts' },
    ],
    metadata: { deepRunId: 'run-1', brief: 'Why are customers churning?' },
  },
  contextSummary: null,
  status: 'active',
  createdBy: 'danny@rxfitatx.com',
  createdAt: '2026-09-01T15:30:00.000Z',
  updatedAt: '2026-09-01T15:30:00.000Z',
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(props: Partial<Parameters<typeof ArtifactViewer>[0]> = {}) {
  const onClose = vi.fn()
  const onDiscuss = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(createElement(ArtifactViewer, { artifact: ARTIFACT, onClose, onDiscuss, ...props }))
  })
  return { onClose, onDiscuss }
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

describe('ArtifactViewer', () => {
  it('renders the artifact as a labelled dialog: tool, title, brief, every section, nested children, linked sources', () => {
    render()
    const dialog = container!.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('artifact-viewer-title')
    expect(container!.querySelector('#artifact-viewer-title')!.textContent).toBe('Deep Research: Churn drivers')

    const text = container!.textContent!
    expect(text).toContain('Saved artifact · Deep Research')
    expect(text).toContain('Why are customers churning?')
    expect(text).toContain('Summary')
    expect(text).toContain('Price is the driver.')
    expect(text).toContain('Evidence')
    expect(text).toContain('Cohort A')
    expect(text).toContain('cites price first')
    expect(text).toContain('danny@rxfitatx.com')
    // The bare URL in Sources becomes a real link (MessageContent linkifies).
    const link = container!.querySelector('a[href="https://example.com/cohorts"]')
    expect(link).toBeTruthy()
    expect(link!.getAttribute('target')).toBe('_blank')
    // The summary card carries the accent treatment.
    expect(container!.querySelector('.artifact-viewer__section--recommendation')!.textContent).toContain('Price is the driver.')
  })

  it('"Discuss in chat" injects the message AND the real content behind the [artifact:id] marker', () => {
    const { onDiscuss } = render()
    const discuss = Array.from(container!.querySelectorAll('button')).find(b => b.textContent === 'Discuss in chat')!
    act(() => { discuss.click() })
    expect(onDiscuss).toHaveBeenCalledTimes(1)
    const [message, attachments] = onDiscuss.mock.calls[0] as [string, { id: string; type: string; content?: string }[]]
    expect(message).toContain('saved Deep Research artifact "Deep Research: Churn drivers"')
    expect(attachments).toHaveLength(1)
    expect(attachments[0].id).toBe('art-1')
    expect(attachments[0].type).toBe('text')
    expect(attachments[0].content!.startsWith('[artifact:art-1] toolId=deep-research')).toBe(true)
    expect(attachments[0].content).toContain('## Summary\nPrice is the driver.')
    expect(attachments[0].content).toContain('### Cohort A\ncites price first')
  })

  it('closes from the ✕, the Close button, the backdrop, and Escape', () => {
    const { onClose } = render()
    act(() => { (container!.querySelector('button[aria-label="Close artifact"]') as HTMLButtonElement).click() })
    act(() => { (Array.from(container!.querySelectorAll('button')).find(b => b.textContent === 'Close') as HTMLButtonElement).click() })
    act(() => { (container!.querySelector('.artifact-viewer__backdrop') as HTMLElement).click() })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(4)
  })

  it('degrades honestly on an artifact with no sections', () => {
    render({ artifact: { ...ARTIFACT, content: { toolId: 'issue-tree', title: 'x', sections: [] } } })
    expect(container!.textContent).toContain('This artifact has no saved sections.')
  })
})

describe('helpers', () => {
  it('artifactToolName maps catalog ids to display names and passes unknown ids through', () => {
    expect(artifactToolName('deep-research')).toBe('Deep Research')
    expect(artifactToolName('deep-think')).toBe('Deep Think')
    expect(artifactToolName('decision-memo')).toBe('Decision Memo')
    expect(artifactToolName('mystery')).toBe('mystery')
  })

  it('formatArtifactDate never throws and echoes garbage input', () => {
    expect(formatArtifactDate('not-a-date')).toBe('not-a-date')
    expect(typeof formatArtifactDate('2026-09-01T15:30:00.000Z')).toBe('string')
  })
})
