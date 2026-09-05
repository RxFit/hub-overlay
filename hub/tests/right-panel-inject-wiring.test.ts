import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* ════════════════════════════════════════════════════════════════════════════
   WIRING GUARD — right panel → chat (Phase 4 PR 1)
   Mirrors tests/left-panel-inject-wiring.test.ts: the feed-card tap must go
   through lib/feed-attachment so the tapped ledger row travels with the
   message as a 'record' attachment. Before this guard the card sent only
   its title, and the assistant answered from nothing (and reached for the
   retired Paperclip explanation). Source-level fitness checks — there is no
   React renderer in this repo.
   ════════════════════════════════════════════════════════════════════════════ */

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
}

describe('FeedCard → chat wiring', () => {
  const src = source('app/components/RightPanelSections.tsx')

  it('routes card taps through the record-attachment builders', () => {
    expect(src).toMatch(/from '@\/lib\/feed-attachment'/)
    expect(src).toMatch(/feedItemToAttachment\(item\)/)
    expect(src).toMatch(/buildFeedInjectMessage\(item\)/)
    // The bare title-only inject must not come back.
    expect(src).not.toMatch(/onInjectChat\(`Tell me more about: \$\{item\.title\}`\)/)
  })

  it('forwards attachments on the inject prop, end to end', () => {
    expect(src).toMatch(/onInjectChat: \(msg: string, attachments\?: ChatAttachment\[\]\) => void/)
    const page = source('app/page.tsx')
    expect(page).toMatch(/onInjectChat: \(msg: string, attachments\?: ChatAttachment\[\]\) => void\s*\n\s*panelRef/)
    expect(page).toMatch(/<ExecutionPulse[\s\S]*onInjectChat=\{onInjectChat\}/)
  })
})

describe('the chat route reads the Hub, not the retired orchestration platform', () => {
  const route = source('app/api/chat/route.ts')
  const prompt = source('lib/gemini.ts')

  it('assembles the Execution Layer from lib/execution-context and passes attachment scope', () => {
    expect(route).toMatch(/from '@\/lib\/execution-context'/)
    expect(route).toMatch(/readExecutionSnapshot\(\{ userEmail: session\.user\.email \?\? '', isAdmin: chatIsAdmin \}\)/)
    expect(route).toMatch(/resolveAttachmentContext\(attachments, lastUserMsg, googleAccessToken, \{/)
    expect(route).not.toMatch(/from '@\/lib\/paperclip'/)
  })

  it('never teaches the model the "warming up" line again', () => {
    expect(prompt).not.toContain('may be warming up')
    expect(route).not.toContain('orchestration data unavailable')
    expect(route).not.toContain('may be warming up')
  })
})
