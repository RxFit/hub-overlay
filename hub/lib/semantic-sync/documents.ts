/**
 * The document shape every source produces, and its two on-bucket renderings.
 *
 * Vertex AI Search "unstructured data with metadata" import (the format the
 * Semantic Brain's Cloud Storage data stores take) is a JSONL manifest whose
 * lines each point at a content file:
 *
 *   {"id":"…","structData":{…},"content":{"mimeType":"text/html","uri":"gs://…"}}
 *
 * Content cannot be inlined in that manifest, so each record is written as one
 * small HTML file plus one manifest line. HTML rather than plain text because
 * the engine takes the <title> as the result title — which is what the chat's
 * result parser (lib/vertex.ts) shows the model — and the facts block keeps
 * dates, parties and amounts next to the body for extractive snippets.
 */

import { createHash } from 'crypto'

export type StructValue = string | number | boolean | string[]

export interface SyncDoc {
  /** Discovery Engine document id — stable per record, so re-syncs replace. */
  id: string
  title: string
  /** When the record last changed; the cursor advances on this. */
  updatedAt: Date
  /** Label/value pairs rendered above the body. */
  facts: Array<[string, string]>
  /** Plain-text body, already bounded by the source. */
  body?: string
  /** Filterable metadata. Keep each field's type stable across records. */
  structData: Record<string, StructValue>
}

const MAX_ID = 63

/**
 * `gmail` + `18c5f…` → `gmail-18c5f…`. Characters outside the Discovery Engine
 * id alphabet become `_`; an id that would exceed 63 chars becomes a stable
 * hash so the same record always maps to the same document.
 */
export function toDocumentId(prefix: string, raw: string): string {
  const candidate = `${prefix}-${raw.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  if (candidate.length <= MAX_ID) return candidate
  return `${prefix}-${createHash('sha256').update(raw).digest('hex').slice(0, MAX_ID - prefix.length - 1)}`
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderHtml(doc: SyncDoc): string {
  const facts = doc.facts
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('')
  const paragraphs = (doc.body ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtml(doc.title)}</title>`,
    '</head><body>',
    `<h1>${escapeHtml(doc.title)}</h1>`,
    facts ? `<dl>${facts}</dl>` : '',
    paragraphs,
    '</body></html>',
    '',
  ].join('\n')
}

export function manifestLine(doc: SyncDoc, contentUri: string): string {
  return JSON.stringify({
    id: doc.id,
    structData: { ...doc.structData, title: doc.title, updated_at: doc.updatedAt.toISOString() },
    content: { mimeType: 'text/html', uri: contentUri },
  })
}
