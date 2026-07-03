import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildDocumentInject, buildArtifactInject, buildTaskInjectMessage } from '@/lib/panel-inject'

/* ════════════════════════════════════════════════════════════════════════════
   WIRING GUARD — left panel sections → lib/panel-inject
   The 53KB-monolith extraction (#31) silently dropped the tested inject
   builders: panel-inject.test.ts kept passing while the components rebuilt
   weaker inline strings and stopped attaching Drive fileIds / artifact ids,
   which killed document resolution in the chat route. Builder unit tests
   cannot catch that class of regression — only an assertion that the
   components actually USE the builders can. These are source-level fitness
   checks (no React renderer in this repo), deliberately loose on formatting.
   ════════════════════════════════════════════════════════════════════════════ */

function componentSource(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../app/components/${name}`, import.meta.url)),
    'utf8',
  )
}

describe('TasksSection → chat wiring', () => {
  const src = componentSource('TasksSection.tsx')

  it('routes task taps through buildTaskInjectMessage', () => {
    expect(src).toMatch(/from '@\/lib\/panel-inject'/)
    expect(src).toMatch(/buildTaskInjectMessage\(task,\s*activeListName\)/)
  })

  it('renders due dates with the future-aware formatDueDate, not a hardcoded timezone', () => {
    expect(src).toMatch(/formatDueDate\(task\.due\)/)
    // The regressed inline path pinned every user to America/Chicago and used
    // the past-only relative formatter ("Due just now" for a task due tomorrow).
    expect(src).not.toContain('America/Chicago')
    expect(src).not.toMatch(/formatRelativeDate\(task\.due\)/)
  })
})

describe('CalendarSection → chat wiring', () => {
  const src = componentSource('CalendarSection.tsx')

  it('routes event taps through buildEventInjectMessage', () => {
    expect(src).toMatch(/onInjectChat\(buildEventInjectMessage\(event\)\)/)
  })

  it('scopes deletes to the event source calendar', () => {
    expect(src).toMatch(/calendarId:\s*event\.calendarId/)
  })
})

describe('DocumentsSection → chat wiring', () => {
  const src = componentSource('DocumentsSection.tsx')

  it('accepts attachments on its inject prop (not a message-only signature)', () => {
    expect(src).toMatch(/onInjectChat:\s*\(msg:\s*string,\s*attachments\?:\s*ChatAttachment\[\]\)/)
  })

  it('sends document taps with the buildDocumentInject attachment (real Drive fileId)', () => {
    expect(src).toMatch(/buildDocumentInject\(file,/)
    expect(src).toMatch(/onInjectChat\(message,\s*\[attachment\]\)/)
  })

  it('sends artifact taps with the buildArtifactInject attachment (real artifact id)', () => {
    expect(src).toMatch(/buildArtifactInject\(artifact\)/)
  })

  it('uses the status-tagging artifactsFetcher, not a raw fetch that masks HTTP errors', () => {
    expect(src).toMatch(/artifactsFetcher/)
    expect(src).not.toMatch(/fetch\(url\)\.then\(r\s*=>\s*r\.json\(\)\)/)
  })
})

/* ════════════════════════════════════════════════════════════════════════════
   HIGH-VOLUME PAYLOAD SIMULATION — a full "worst day" of panel taps.
   Every payload the panel can emit must stay resolvable (attachment carries
   the id the chat route needs) and bounded (a single tap can never produce a
   runaway request body).
   ════════════════════════════════════════════════════════════════════════════ */

describe('bulk inject payload integrity', () => {
  it('1k document taps: every attachment carries the tapped fileId and mimeType', () => {
    for (let i = 0; i < 1_000; i++) {
      const { message, attachment } = buildDocumentInject(
        { id: `file-${i}`, name: `Doc ${i}`, mimeType: 'application/pdf' },
        i % 2 === 0,
      )
      expect(attachment.fileId).toBe(`file-${i}`)
      expect(attachment.type).toBe('document')
      expect(attachment.mimeType).toBe('application/pdf')
      expect(message).toContain(`Doc ${i}`)
    }
  })

  it('1k artifact taps: every attachment content embeds the resolvable [artifact:id] marker', () => {
    for (let i = 0; i < 1_000; i++) {
      const { attachment } = buildArtifactInject({ id: `art-${i}`, toolId: 'issue-tree', title: `T${i}` })
      expect(attachment.content).toContain(`[artifact:art-${i}]`)
    }
  })

  it('1k task taps with 10k-char notes: every message stays bounded', () => {
    const notes = 'n '.repeat(5_000)
    for (let i = 0; i < 1_000; i++) {
      const msg = buildTaskInjectMessage(
        { title: `task ${i}`, status: 'needsAction', due: new Date().toISOString(), notes },
        'Ops',
      )
      expect(msg.length).toBeLessThan(1_000)
    }
  })
})
