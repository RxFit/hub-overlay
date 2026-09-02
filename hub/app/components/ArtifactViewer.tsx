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
  const sections = artifact.content?.sections ?? []
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
