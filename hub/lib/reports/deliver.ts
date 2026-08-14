/**
 * Digest delivery — getting a finished report in front of someone.
 *
 * Without this, scheduled digests land in Drive and nobody knows they exist,
 * which is indistinguishable from not generating them.
 *
 * ── Why the email carries a LINK rather than the report body ──
 * The digest is already a formatted Google Doc with tables. Re-rendering it as
 * inline email HTML would mean maintaining a second renderer whose output
 * drifts from the first, and Gmail's HTML handling would flatten the tables
 * anyway. A short email pointing at the Doc keeps one canonical artifact.
 *
 * ── Failure posture ──
 * Delivery failing must not undo a generated report. The Doc exists and is
 * linked from Drive either way, so every function here reports failure rather
 * than throwing, and the runner records it as a note on an otherwise successful
 * run.
 */

import { googleFetch } from '../google/client'
import { tagHubChatPost } from '../chat-post-tag'
import type { ReportDelivery } from './config'

const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
const CHAT_BASE = 'https://chat.googleapis.com/v1'

/** Literal token in a delivery list that expands to the tenant's admins. */
export const ADMINS_TOKEN = 'admins'

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/

/**
 * Expand a configured recipient list into real addresses.
 *
 * `admins` expands to the tenant's admin emails; everything else must be a
 * literal address. Invalid entries are dropped rather than sent to — a typo in
 * a settings field should lose one recipient, not fail the delivery or bounce.
 * Deduplicated case-insensitively so an admin listed both ways gets one copy.
 */
export function resolveRecipients(delivery: ReportDelivery, adminEmails: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const add = (raw: string) => {
    const email = raw.trim()
    if (!EMAIL_RE.test(email)) return
    const key = email.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(email)
  }

  for (const entry of delivery.email) {
    if (entry.trim().toLowerCase() === ADMINS_TOKEN) adminEmails.forEach(add)
    else add(entry)
  }
  return out
}

/** Strip CR/LF so a header value cannot inject additional headers. */
const stripHeader = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()

/**
 * Build the RFC 2822 payload for a digest notification, base64url-encoded as
 * Gmail's `raw` field expects. Pure, so the wire format is testable.
 */
export function buildDigestEmail(input: {
  from: string
  to: string[]
  title: string
  startDate: string
  endDate: string
  documentUrl: string
  notes?: string[]
}): string {
  const body = [
    `Your ${input.title.toLowerCase()} is ready.`,
    '',
    `Reporting period: ${input.startDate} to ${input.endDate}`,
    '',
    `Open the report: ${input.documentUrl}`,
    ...(input.notes?.length ? ['', 'Notes:', ...input.notes.map(n => `- ${n}`)] : []),
    '',
    'Generated automatically by the HUB Overlay.',
  ].join('\r\n')

  const lines = [
    `From: ${stripHeader(input.from)}`,
    `To: ${input.to.map(stripHeader).join(', ')}`,
    `Subject: ${stripHeader(`${input.title} — ${input.startDate} to ${input.endDate}`)}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  ]

  return Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export interface DeliveryOutcome {
  emailed: number
  chatPosted: boolean
  /** Human-readable reasons for anything that did not go out. */
  problems: string[]
}

/**
 * Deliver a finished digest by email and/or Chat, per the report's config.
 * Never throws.
 */
export async function deliverDigest(
  accessToken: string,
  delivery: ReportDelivery,
  adminEmails: string[],
  message: {
    from: string
    title: string
    startDate: string
    endDate: string
    documentUrl: string
    notes?: string[]
  },
): Promise<DeliveryOutcome> {
  const outcome: DeliveryOutcome = { emailed: 0, chatPosted: false, problems: [] }

  const recipients = resolveRecipients(delivery, adminEmails)
  if (recipients.length) {
    try {
      await googleFetch<unknown>(GMAIL_SEND, accessToken, {
        method: 'POST',
        body: JSON.stringify({ raw: buildDigestEmail({ ...message, to: recipients }) }),
      })
      outcome.emailed = recipients.length
    } catch (err) {
      outcome.problems.push(`email delivery failed: ${err instanceof Error ? err.message : 'error'}`)
    }
  }

  if (delivery.chatSpaceId) {
    try {
      // User-auth Chat messages are text-only — cards need app credentials.
      // Tagged (lib/chat-post-tag.ts): a scheduled digest posts AS the
      // operator, and agents in the space that react to operator messages
      // must be able to tell it apart from the operator typing.
      await googleFetch<unknown>(
        `${CHAT_BASE}/${delivery.chatSpaceId}/messages`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({
            text: tagHubChatPost(`${message.title} (${message.startDate} – ${message.endDate}): ${message.documentUrl}`),
          }),
        },
      )
      outcome.chatPosted = true
    } catch (err) {
      outcome.problems.push(`chat delivery failed: ${err instanceof Error ? err.message : 'error'}`)
    }
  }

  return outcome
}
