'use client'

import { useCallback, useRef } from 'react'
import type { ChatAttachment, ToolArtifactRecord, ToolArtifactSection } from '@/types'
import { SKILL_MAP } from '@/lib/skills'
import { buildArtifactInject } from '@/lib/panel-inject'
import { MessageContent } from '@/app/components/MessageContent'
import { useModalA11y } from '@/app/hooks/useModalA11y'

/* ══════════════════════════════════════════════════════════════════════════════
   ARTIFACT VIEWER — read a saved artifact back, any time

   Tapping a row under Documents › Artifacts used to fire a chat message with a
   bare `[artifact:id]` marker the chat route never resolved, so "pull that
   research back up" produced an answer about nothing. This slide-over renders
   the saved sections directly (a right-hand drawer on desktop, full-screen on
   phones) and offers "Discuss in chat", which now attaches the real content.

   It is deliberately independent of the tool-panel state: a Deep Research run
   can be in flight in the panel while an older report is open here.
   ══════════════════════════════════════════════════════════════════════════════ */

export function artifactToolName(toolId: string): string {
  return SKILL_MAP[toolId]?.name ?? toolId
}

export function formatArtifactDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {
    return iso
  }
}

const ARTIFACT_SECTION_TYPES = new Set<ToolArtifactSection['type']>([
  'branch', 'hypothesis', 'pro', 'con', 'recommendation', 'step', 'score',
  'critique', 'slide', 'insight', 'narrative', 'generic',
])
const MAX_VIEWER_SECTION_DEPTH = 8
const MAX_VIEWER_SECTIONS = 250

/**
 * Artifact content is JSON supplied by authenticated clients, and older rows
 * predate this viewer. Normalize it before rendering so one malformed row
 * cannot throw from `.map()` or recurse without a bound and take down the Hub.
 */
export function normalizeViewerSections(content: unknown): ToolArtifactSection[] {
  let seen = 0
  const walk = (value: unknown, depth: number, path: string): ToolArtifactSection[] => {
    if (!Array.isArray(value) || depth > MAX_VIEWER_SECTION_DEPTH || seen >= MAX_VIEWER_SECTIONS) return []
    const sections: ToolArtifactSection[] = []
    for (let i = 0; i < value.length && seen < MAX_VIEWER_SECTIONS; i += 1) {
      const raw = value[i]
      if (!raw || typeof raw !== 'object') continue
      const section = raw as Record<string, unknown>
      const title = typeof section.title === 'string' ? section.title : ''
      const body = typeof section.content === 'string' ? section.content : ''
      if (!title && !body) continue
      seen += 1
      const rawType = typeof section.type === 'string' ? section.type : ''
      const children = walk(section.children, depth + 1, `${path}-${i}`)
      sections.push({
        id: typeof section.id === 'string' && section.id ? section.id : `${path}-${i}`,
        type: ARTIFACT_SECTION_TYPES.has(rawType as ToolArtifactSection['type'])
          ? rawType as ToolArtifactSection['type']
          : 'generic',
        title: title || 'Untitled section',
        content: body,
        ...(children.length > 0 ? { children } : {}),
      })
    }
    return sections
  }

  if (!content || typeof content !== 'object') return []
  return walk((content as { sections?: unknown }).sections, 0, 'artifact-section')
}

interface ArtifactViewerProps {
  artifact: ToolArtifactRecord
  onClose: () => void
  /** Read-style inject into the primary chat (message + the content attachment). */
  onDiscuss: (message: string, attachments: ChatAttachment[]) => void
}

export function ArtifactViewer({ artifact, onClose, onDiscuss }: ArtifactViewerProps) {
  const dialogRef = useRef<HTMLElement>(null)
  useModalA11y(dialogRef, onClose)

  const toolName = artifactToolName(artifact.toolId)
  const sections = normalizeViewerSections(artifact.content)
  const metaBrief = artifact.content?.metadata?.brief
  const brief = typeof metaBrief === 'string' && metaBrief.trim() ? metaBrief.trim() : null

  const discuss = useCallback(() => {
    const { message, attachment } = buildArtifactInject({
      id: artifact.id,
      toolId: artifact.toolId,
      title: artifact.title,
      toolName,
      content: artifact.content,
    })
    onDiscuss(message, [attachment])
  }, [artifact, onDiscuss, toolName])

  return (
    <div className="artifact-viewer__root">
      <div className="artifact-viewer__backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        ref={dialogRef}
        className="artifact-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-viewer-title"
        tabIndex={-1}
      >
        <header className="artifact-viewer__header">
          <div className="artifact-viewer__heading">
            <span className="artifact-viewer__eyebrow">Saved artifact · {toolName}</span>
            <h2 id="artifact-viewer-title" className="artifact-viewer__title">{artifact.title}</h2>
            <span className="artifact-viewer__meta">
              Saved {formatArtifactDate(artifact.createdAt)}
              {artifact.createdBy ? ` · ${artifact.createdBy}` : ''}
            </span>
          </div>
          <button className="artifact-viewer__close" onClick={onClose} aria-label="Close artifact" title="Close">
            ✕
          </button>
        </header>

        <div className="artifact-viewer__body">
          {brief && <p className="artifact-viewer__brief">“{brief}”</p>}
          {sections.length === 0 ? (
            <p className="artifact-viewer__empty">This artifact has no saved sections.</p>
          ) : (
            sections.map(section => <ArtifactSectionCard key={section.id} section={section} />)
          )}
        </div>

        <footer className="artifact-viewer__footer">
          <button className="artifact-viewer__discuss" onClick={discuss}>
            Discuss in chat
          </button>
          <button className="artifact-viewer__dismiss" onClick={onClose}>
            Close
          </button>
        </footer>
      </aside>
    </div>
  )
}

function ArtifactSectionCard({ section, depth = 0 }: { section: ToolArtifactSection; depth?: number }) {
  return (
    <section
      className={`artifact-viewer__section artifact-viewer__section--${section.type}`}
      style={depth > 0 ? { marginLeft: Math.min(depth, 3) * 12 } : undefined}
    >
      <h3 className="artifact-viewer__section-title">{section.title}</h3>
      {section.content && <MessageContent content={section.content} />}
      {section.children?.map(child => (
        <ArtifactSectionCard key={child.id} section={child} depth={depth + 1} />
      ))}
    </section>
  )
}
