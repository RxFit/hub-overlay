/**
 * Gmail → Semantic Brain documents, read through domain-wide delegation.
 *
 * WHY DELEGATION, NOT A STORED REFRESH TOKEN: the Hub's per-user OAuth
 * refresh tokens (lib/google-token-store.ts) expire, get revoked on password
 * changes, and die whenever a consent screen changes — every one of those
 * silently stops a nightly job. A service-account token minted with
 * `sub: <mailbox>` has no user credential to lose; it works for as long as the
 * Workspace admin's delegation grant stands. The token is `gmail.readonly`,
 * so this path can never send, modify or delete mail.
 *
 * One document per message (`gmail-<message id>`), oldest first. Bodies prefer
 * text/plain, fall back to de-tagged HTML, drop quoted reply history (which
 * would otherwise index every thread N times), and are bounded in length.
 * Attachments are listed by filename only; their bytes are never fetched.
 */

import { mintServiceAccountToken } from '@/lib/google-auth'
import type { SyncDoc } from './documents'
import { toDocumentId } from './documents'
import { SemanticSyncError, failFromResponse, fetchWithRetry, mapLimit, type FetchLike } from './http'
import { LIST_CAP, type CollectResult, type SyncSource } from './source'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const MAX_BODY_CHARS = 20_000
const FETCH_CONCURRENCY = 8

interface GmailHeader {
  name?: string
  value?: string
}

export interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailPart
}

/** Build the Gmail search for a window. Exported for tests. */
export function buildGmailQuery(since: Date, until: Date, filter: string | undefined): string {
  const q = [
    `after:${Math.floor(since.getTime() / 1000)}`,
    `before:${Math.floor(until.getTime() / 1000)}`,
    '-in:drafts',
  ]
  if (filter?.trim()) q.push(filter.trim())
  return q.join(' ')
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

/** De-tag an HTML email body. Entities are decoded last so `&amp;lt;` stays `&lt;`. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|table|section)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Drop quoted reply history: `>`-prefixed lines, and everything from an
 * "On <date>, <person> wrote:" attribution onward (only when something
 * precedes it, so a message that is ALL quote keeps its text).
 */
export function stripQuotedReply(text: string): string {
  const unquoted = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
  const attribution = unquoted.search(/^On .{4,200}wrote:\s*$/m)
  const cut = attribution > 0 ? unquoted.slice(0, attribution) : unquoted
  return cut.replace(/\n{3,}/g, '\n\n').trim()
}

/** Walk the MIME tree: plain text if any, else HTML as text; plus attachment names. */
export function extractMessageText(payload: GmailPart | undefined): { body: string; attachments: string[] } {
  const plain: string[] = []
  const html: string[] = []
  const attachments: string[] = []
  const walk = (part: GmailPart | undefined): void => {
    if (!part) return
    if (part.filename && (part.body?.attachmentId || part.body?.size)) {
      attachments.push(part.filename)
      return
    }
    const data = part.body?.data
    if (data && part.mimeType === 'text/plain') plain.push(decodeBase64Url(data))
    else if (data && part.mimeType === 'text/html') html.push(decodeBase64Url(data))
    part.parts?.forEach(walk)
  }
  walk(payload)
  const raw = plain.length ? plain.join('\n\n') : html.length ? htmlToText(html.join('\n')) : ''
  const body = stripQuotedReply(raw.replace(/\r\n/g, '\n'))
  return {
    body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n[truncated]` : body,
    attachments,
  }
}

const header = (msg: GmailMessage, name: string): string =>
  msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? ''

function splitAddresses(value: string): string[] {
  return value
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 50)
}

/** Exported for tests. */
export function gmailMessageToDoc(msg: GmailMessage, mailbox: string): SyncDoc {
  const { body, attachments } = extractMessageText(msg.payload)
  const date = new Date(Number(msg.internalDate ?? 0))
  const subject = header(msg, 'Subject') || '(no subject)'
  const from = header(msg, 'From')
  const to = header(msg, 'To')
  const cc = header(msg, 'Cc')
  const labels = msg.labelIds ?? []
  const direction = labels.includes('SENT') ? 'sent' : 'received'

  return {
    id: toDocumentId('gmail', msg.id),
    title: `Email: ${subject}`,
    updatedAt: date,
    facts: [
      ['From', from],
      ['To', to],
      ['Cc', cc],
      ['Date', date.toISOString()],
      ['Mailbox', `${mailbox} (${direction})`],
      ['Attachments', attachments.join(', ')],
    ],
    body: body || msg.snippet || '',
    structData: {
      source: 'gmail',
      mailbox,
      direction,
      subject,
      from,
      to: splitAddresses(to),
      date: date.toISOString(),
      thread_id: msg.threadId ?? '',
      message_id: msg.id,
      labels,
    },
  }
}

export function createGmailSource(opts: {
  subject: string
  query: string | undefined
  fetchImpl?: FetchLike
  /** Test seam; defaults to a delegated service-account token. */
  token?: (signal?: AbortSignal) => Promise<string>
}): SyncSource {
  const fetchImpl = opts.fetchImpl ?? fetch
  const token =
    opts.token ?? ((signal?: AbortSignal) => mintServiceAccountToken({ scope: GMAIL_READONLY_SCOPE, subject: opts.subject, signal }))

  return {
    id: 'gmail',
    async collect(window, { maxItems, signal }): Promise<CollectResult> {
      const q = buildGmailQuery(window.since, window.until, opts.query)

      // List every id in the window (ids only — cheap), newest first.
      const ids: string[] = []
      let pageToken: string | undefined
      do {
        const params = new URLSearchParams({ q, maxResults: '500' })
        if (pageToken) params.set('pageToken', pageToken)
        const res = await fetchWithRetry(fetchImpl, `${API}/messages?${params}`, {
          headers: { Authorization: `Bearer ${await token(signal)}` },
          signal,
        })
        if (!res.ok) await failFromResponse('collect', 'Gmail list messages', res)
        const page = (await res.json()) as { messages?: Array<{ id: string }>; nextPageToken?: string }
        ids.push(...(page.messages ?? []).map((m) => m.id))
        if (ids.length > LIST_CAP) {
          throw new SemanticSyncError('collect', `Gmail window holds more than ${LIST_CAP} messages — rerun with a smaller lookbackHours`)
        }
        pageToken = page.nextPageToken
      } while (pageToken)

      // Gmail lists newest first; process oldest first so a truncated run's
      // cursor never jumps past an unprocessed message.
      const ordered = ids.reverse()
      const truncated = ordered.length > maxItems
      const batch = ordered.slice(0, maxItems)

      const messages = await mapLimit(batch, FETCH_CONCURRENCY, async (id) => {
        const res = await fetchWithRetry(fetchImpl, `${API}/messages/${encodeURIComponent(id)}?format=full`, {
          headers: { Authorization: `Bearer ${await token(signal)}` },
          signal,
        })
        // A message deleted between list and get is not a failure of the run.
        if (res.status === 404) {
          await res.text().catch(() => '')
          return null
        }
        if (!res.ok) await failFromResponse('collect', `Gmail get message ${id}`, res)
        return (await res.json()) as GmailMessage
      })

      const docs = messages
        .filter((m): m is GmailMessage => m !== null)
        .map((m) => gmailMessageToDoc(m, opts.subject))
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())

      const lastProcessed = docs.length ? docs[docs.length - 1].updatedAt : window.since
      return { docs, scanned: ids.length, truncated, cursor: truncated ? lastProcessed : window.until }
    },
  }
}
