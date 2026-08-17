import { describe, it, expect } from 'vitest'
import { WRITE_ACTION_CATALOG, renderWriteActions, writeActionsBySurface } from './write-actions'
import { INTENT_DEFINITIONS, getRequiredPermission } from './interview'
import { buildSystemPrompt } from './gemini'
import type { InterviewIntent } from '@/types'

/* T-70 fixes #3 and #5. The prompt's action list had drifted from the shipped
   intents: 27 intents existed, 11 were advertised, and one advertised action
   ("edit a document") had never existed. Both directions of that drift produce
   the GA4 denial pattern — the model refusing something wired, or promising
   something that isn't. These tests pin the two sets together. */

describe('write-action catalog vs the shipped intents', () => {
  it('advertises EVERY intent the app can actually run', () => {
    const shipped = INTENT_DEFINITIONS.map(d => d.id).sort()
    const advertised = (Object.keys(WRITE_ACTION_CATALOG) as InterviewIntent[]).sort()
    expect(advertised).toEqual(shipped)
  })

  it('advertises NO action the app cannot run (no phantom "edit a document")', () => {
    const shipped = new Set(INTENT_DEFINITIONS.map(d => d.id))
    for (const intent of Object.keys(WRITE_ACTION_CATALOG) as InterviewIntent[]) {
      expect(shipped.has(intent)).toBe(true)
    }
  })

  it('groups each action under the role tier interview.ts actually enforces', () => {
    for (const surface of ['google', 'paperclip'] as const) {
      for (const group of writeActionsBySurface(surface)) {
        for (const intent of Object.keys(WRITE_ACTION_CATALOG) as InterviewIntent[]) {
          if (!group.actions.includes(WRITE_ACTION_CATALOG[intent].label)) continue
          expect(getRequiredPermission(intent)).toBe(group.tier)
        }
      }
    }
  })

  it('puts every action on exactly one surface, and neither surface is empty', () => {
    const google = writeActionsBySurface('google').flatMap(g => g.actions)
    const paperclip = writeActionsBySurface('paperclip').flatMap(g => g.actions)
    expect(google.length).toBeGreaterThan(0)
    expect(paperclip.length).toBeGreaterThan(0)
    expect(google.length + paperclip.length).toBe(INTENT_DEFINITIONS.length)
    expect(google.filter(a => paperclip.includes(a))).toEqual([])
  })
})

describe('the system prompt carries the whole catalog', () => {
  const prompt = buildSystemPrompt({})

  it('names every shipped write action', () => {
    for (const intent of Object.keys(WRITE_ACTION_CATALOG) as InterviewIntent[]) {
      expect(prompt).toContain(WRITE_ACTION_CATALOG[intent].label)
    }
  })

  it('advertises the capabilities that were missing entirely (authoring + sharing)', () => {
    // The old hand-written list mentioned none of these, so the model denied
    // them — to users whose next message would have opened a Confirm Card.
    expect(prompt).toContain('Google Doc')
    expect(prompt).toContain('Google Sheet')
    expect(prompt).toContain('Google Slides')
    expect(prompt).toMatch(/Share a Hub-created/)
    expect(prompt).toContain('routine')
    expect(prompt).toContain('goal')
  })

  it('no longer advertises the phantom document-edit flow', () => {
    expect(prompt).not.toContain('edit a document')
  })

  it('tells the model the list is exhaustive in BOTH directions', () => {
    expect(prompt).toContain('NEVER tell the user the Hub cannot perform an action that appears below')
    expect(prompt).toContain('the app genuinely cannot run it')
  })

  it('keeps the catalog in the CACHED static prefix (it carries no per-request data)', () => {
    const a = buildSystemPrompt({ role: 'staff' })
    const b = buildSystemPrompt({ role: 'admin' })
    for (const p of [a, b]) {
      expect(p).toContain(WRITE_ACTION_CATALOG.create_google_doc.label)
    }
  })
})
