import React, { Fragment } from 'react'
import { EmailPreviewCard } from '@/app/components/EmailPreviewCard'
import { SKILL_MAP } from '@/lib/skills'

/* ── Safe Markdown-like renderer (no dangerouslySetInnerHTML) ── */
export function parseInlineMarkdown(text: string, onToolActivate?: (toolId: string) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  // Match bold (**...**), italic (*...*), and tool references ([[...]])
  const regex = /\*\*(.*?)\*\*|\*(.*?)\*|\[\[([\w-]+)\]\]/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // Push text before this match
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    if (match[1] !== undefined) {
      // Bold
      nodes.push(<strong key={`b-${match.index}`}>{match[1]}</strong>)
    } else if (match[2] !== undefined) {
      // Italic
      nodes.push(<em key={`i-${match.index}`}>{match[2]}</em>)
    } else if (match[3] !== undefined) {
      // Tool reference — render as clickable gold link
      const toolId = match[3]
      nodes.push(
        <button
          key={`tool-${match.index}`}
          className="inline-tool-link"
          onClick={() => onToolActivate?.(toolId)}
          title={SKILL_MAP[toolId]?.description || toolId}
        >
          {toolId}
        </button>
      )
    }
    lastIndex = match.index + match[0].length
  }
  // Push remaining text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  if (nodes.length === 0) {
    nodes.push(text)
  }
  return nodes
}

interface MessageContentProps {
  content: string
  onToolActivate?: (toolId: string) => void
}

export function MessageContent({ content, onToolActivate }: MessageContentProps) {
  // Strip suggestedTools metadata from visible content
  const cleanContent = content.replace(/<!--suggestedTools:\[.*?\]-->/g, '').trimEnd()
  
  // Custom parser to split by HTML code blocks and generic code blocks
  const parts: { type: 'text' | 'html' | 'code', content: string, lang?: string }[] = []
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g
  let lastIndex = 0
  let match

  while ((match = codeBlockRegex.exec(cleanContent)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: cleanContent.slice(lastIndex, match.index) })
    }
    const lang = match[1] || ''
    if (lang === 'html') {
      parts.push({ type: 'html', content: match[2] })
    } else {
      parts.push({ type: 'code', content: match[2], lang })
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < cleanContent.length) {
    parts.push({ type: 'text', content: cleanContent.slice(lastIndex) })
  }

  return (
    <div style={{ whiteSpace: 'pre-wrap' }}>
      {parts.map((part, pIndex) => {
        if (part.type === 'html') {
          return <EmailPreviewCard key={pIndex} htmlContent={part.content} />
        }
        if (part.type === 'code') {
          return (
            <div key={pIndex} style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'clamp(0.78rem, 0.74rem + 0.2vw, 0.85rem)',
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3)',
              margin: 'var(--space-2) 0',
              overflowX: 'auto',
              lineHeight: 1.55,
            }}>
              {part.content}
            </div>
          )
        }
        
        const lines = part.content.split('\n')
        return (
          <Fragment key={pIndex}>
            {lines.map((line, i) => {
              // Heading lines (## Header or ### Header)
              if (/^#{1,3} /.test(line)) {
                const level = line.match(/^(#+)/)?.[1].length || 2
                const text = line.replace(/^#+\s*/, '')
                return (
                  <div key={`${pIndex}-${i}`} style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 600,
                    fontSize: level === 1 ? '1.05em' : level === 2 ? '0.95em' : '0.9em',
                    marginTop: '0.75em',
                    marginBottom: '0.25em',
                    color: 'var(--text-primary)',
                    letterSpacing: '-0.01em',
                  }}>
                    {parseInlineMarkdown(text, onToolActivate)}
                  </div>
                )
              }
              // Numbered list items (1. or 1) style)
              if (/^\d+[.)\s]/.test(line.trim())) {
                return (
                  <div key={`${pIndex}-${i}`} style={{ paddingLeft: '16px', position: 'relative' }}>
                    {parseInlineMarkdown(line, onToolActivate)}
                  </div>
                )
              }
              // Bullet points — proper indentation
              if (line.startsWith('• ') || line.startsWith('- ')) {
                return <div key={`${pIndex}-${i}`} style={{ paddingLeft: '16px', position: 'relative' }}>{parseInlineMarkdown(line, onToolActivate)}</div>
              }
              // Blockquote lines (> text)
              if (line.startsWith('> ')) {
                return (
                  <div key={`${pIndex}-${i}`} style={{
                    paddingLeft: '12px',
                    borderLeft: '3px solid var(--accent-dim)',
                    color: 'var(--text-secondary)',
                    fontStyle: 'italic',
                    margin: '4px 0',
                  }}>
                    {parseInlineMarkdown(line.slice(2), onToolActivate)}
                  </div>
                )
              }
              // Table header detection
              if (line.includes('|') && line.trim().startsWith('|')) {
                const cells = line.split('|').filter(c => c.trim())
                if (cells.every(c => /^[\s-]+$/.test(c))) return <Fragment key={`${pIndex}-${i}`} />  // separator line
                return (
                  <div key={`${pIndex}-${i}`} style={{
                    display: 'flex',
                    gap: '8px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'clamp(0.75rem, 0.7rem + 0.25vw, 0.85rem)',
                    padding: '2px 0',
                    color: line.includes('---') ? 'transparent' : undefined,
                  }}>
                    {cells.map((cell, j) => (
                      <span key={j} style={{ flex: 1, minWidth: 0 }}>{parseInlineMarkdown(cell.trim(), onToolActivate)}</span>
                    ))}
                  </div>
                )
              }
              // Empty line → visible paragraph break
              if (!line.trim()) {
                return <div key={`${pIndex}-${i}`} style={{ height: '0.5em' }} aria-hidden="true" />
              }
              return <div key={`${pIndex}-${i}`}>{parseInlineMarkdown(line, onToolActivate)}</div>
            })}
          </Fragment>
        )
      })}
    </div>
  )
}

export default MessageContent
