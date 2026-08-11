/**
 * Gmail triage signals — the deterministic half of the Focus ranking.
 *
 * WHY THIS EXISTS
 * The previous ranker scored a thread as `unread(40) + doesn't-match-a-regex(30)
 * = 70`, which cleared the `>= 60` cut and painted an "Important" chip on
 * essentially every unread message. Because every such thread scored the SAME
 * 70, the stable sort left them in inbox order — so the "priority" strip was
 * literally the top three emails in the inbox, each captioned "Unread message
 * from a real person" whether or not a person had anything to do with it.
 *
 * THE FIX, in one sentence: classify the SENDER from evidence Gmail already
 * hands us (RFC list headers + Gmail's own category labels), give each class a
 * hard score CEILING, and let per-thread modifiers move a thread only within
 * its class.
 *
 * Structure follows the Gmail Priority Inbox paper (Aberdeen, Pacovsky &
 * Slater, 2010): a deterministic global model, a bounded personal delta (the
 * VIP list), and a per-user threshold. Two of its findings shape the numbers
 * below — that "opens" conflate *interesting* with *important* (so `isUnread`
 * is worth +8, not +40), and that a per-user threshold is worth about as much
 * as the entire personal weight vector (so the cut is a named, tunable
 * constant rather than a literal `60` buried in a filter).
 *
 * PURE: no I/O, no dates beyond an injected `now`. Everything here is unit-
 * tested in lib/gmail-signals.test.ts.
 */

import type { GmailThreadSummary } from '@/lib/google'
import { matchVip, type FocusVip } from '@/lib/focus-preferences'

/** How much we believe a human chose to send this specific message. */
export type SenderClass = 'human' | 'unknown' | 'automated' | 'bulk'

export interface ThreadSignals {
  senderClass: SenderClass
  /** Why the class was assigned — surfaced in reasons and useful in tests. */
  classEvidence: string[]

  // Bulk / list markers (RFC 2369, 2919, 8058)
  hasListUnsubscribe: boolean
  hasOneClickUnsubscribe: boolean
  hasListId: boolean
  hasListPost: boolean
  hasFeedbackId: boolean
  precedenceBulk: boolean

  // Automation markers (RFC 3834)
  autoSubmitted: boolean
  /** `Auto-Submitted: no` — an affirmative "a human sent this" marker. */
  autoSubmittedNo: boolean
  hasAutoResponseSuppress: boolean
  roleAddress: boolean

  // Gmail's own verdicts
  categories: string[]
  isImportant: boolean
  isStarred: boolean

  isCalendarInvite: boolean

  // Addressing + reciprocity
  userReplied: boolean
  hasDraft: boolean
  addressedDirectly: boolean
  ccOnly: boolean
  notAddressed: boolean
  recipientCount: number
  sameDomainAsUser: boolean
  undisclosedRecipients: boolean

  vip: FocusVip | null
  /** Subject/snippet is talking to the assistant rather than to the user. */
  suspectedInjection: boolean

  ageMs: number | null
  isUnread: boolean
  messageCount: number
}

/* Role-account patterns. DEMOTED from its old job: it used to be the entire
   human-vs-machine test and carried 30 of the 70 points. It is now one of four
   inputs to the `automated` class, because a keyword denylist over an open set
   of senders has no ceiling on false negatives — `team@formspree.io`,
   `crew@morningbrew.com` and `yelp-business@yelp.com` all sail through it.
   Those are caught upstream by their List-Unsubscribe headers instead.
   Widened here only for misses that a list header would not catch. */
const AUTOMATED_SENDER_RE =
  /(^|[<\s.])(no[-._]?reply|do[-._]?not[-._]?reply|donotreply|mailer-daemon)|notifications?@|newsletters?@|marketing@|updates?@|info@|support@|billing@|receipts?@|invoices?@|@(e|em|mail|email|mailer|news|notify|rs|bounce|ct|link|go|t)\./i

/* Phrasing that addresses the ranking model rather than the human recipient.
   A legitimate correspondent does not tell an assistant what priority to use. */
const INJECTION_RE =
  /ignore (all |any |your )?(previous|prior|above)|disregard (the |all )?(previous|prior|above)|system prompt|you are (an? )?(ai|assistant|language model)|mark (this|it) (as )?(urgent|important|high)|prioriti[sz]e this|set priority/i

const BULK_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']

const domainOf = (addr: string): string => {
  const m = addr.match(/@([^\s>@,;"]+)/)
  return m ? m[1].toLowerCase().replace(/\.$/, '') : ''
}

/**
 * Reduce a thread to the boolean/enum feature set the scorer and the prompt
 * both consume. Only DERIVED values leave this function — raw header text
 * never reaches the model (see buildFocusPrompt).
 */
export function extractThreadSignals(
  thread: GmailThreadSummary,
  opts: { userEmail?: string; vips?: readonly FocusVip[]; now?: number } = {},
): ThreadSignals {
  const { userEmail = '', vips = [], now = Date.now() } = opts
  const h = thread.headers ?? {}
  const labels = thread.labelIds ?? []

  const hasListUnsubscribe = 'list-unsubscribe' in h
  const hasOneClickUnsubscribe = /one-click/i.test(h['list-unsubscribe-post'] ?? '')
  const hasListId = 'list-id' in h
  const hasListPost = 'list-post' in h
  const hasFeedbackId = 'feedback-id' in h
  const precedenceBulk = /^\s*(bulk|list|junk)/i.test(h['precedence'] ?? '')

  const autoSubmittedRaw = (h['auto-submitted'] ?? '').trim().toLowerCase()
  // RFC 3834: the header is REQUIRED to be present as `no` on human mail that
  // sets it at all, so "present and not `no`" is the automation test.
  const autoSubmitted = autoSubmittedRaw !== '' && !autoSubmittedRaw.startsWith('no')
  const autoSubmittedNo = autoSubmittedRaw.startsWith('no')

  const categories = labels.filter(l => l.startsWith('CATEGORY_'))
  const vip = matchVip(thread.from, vips)
  const userDomain = domainOf(userEmail)
  const senderDomain = domainOf(thread.from)

  const receivedAt = thread.receivedAt ?? (Number.isFinite(Date.parse(thread.date)) ? Date.parse(thread.date) : null)
  const ageMs = receivedAt === null ? null : now - receivedAt

  const sig: ThreadSignals = {
    senderClass: 'unknown',
    classEvidence: [],
    hasListUnsubscribe,
    hasOneClickUnsubscribe,
    hasListId,
    hasListPost,
    hasFeedbackId,
    precedenceBulk,
    autoSubmitted,
    autoSubmittedNo,
    hasAutoResponseSuppress: 'x-auto-response-suppress' in h,
    roleAddress: AUTOMATED_SENDER_RE.test(thread.from),
    categories,
    isImportant: labels.includes('IMPORTANT'),
    isStarred: labels.includes('STARRED'),
    isCalendarInvite: /text\/calendar/i.test(h['content-type'] ?? ''),
    userReplied: thread.userReplied ?? false,
    hasDraft: thread.hasDraft ?? false,
    addressedDirectly: thread.addressedDirectly ?? false,
    ccOnly: thread.ccOnly ?? false,
    notAddressed: !(thread.inTo ?? false) && !(thread.ccOnly ?? false),
    recipientCount: thread.recipientCount ?? 0,
    sameDomainAsUser: userDomain !== '' && senderDomain === userDomain,
    undisclosedRecipients: thread.undisclosedRecipients ?? false,
    vip,
    suspectedInjection: INJECTION_RE.test(`${thread.subject} ${thread.snippet}`),
    ageMs,
    isUnread: thread.isUnread,
    messageCount: thread.messageCount,
  }

  const { senderClass, classEvidence } = classifySender(sig)
  sig.senderClass = senderClass
  sig.classEvidence = classEvidence
  return sig
}

/**
 * Assign the sender class. Top-down, first match wins — and the ORDER carries
 * the product decisions:
 *
 *   1. A VIP the user typed in outranks every automatic signal, so their
 *      accountant at `billing@` is never demoted to noise.
 *   2. Bulk markers beat reciprocity, so a newsletter you once replied to
 *      stays a newsletter.
 *   3. `unknown` is a real answer, not a failure. A first-contact human with
 *      no list headers is genuinely uncertain — that is exactly the case
 *      where the language model earns its keep, and the case where claiming
 *      "message from a real person" was a guess dressed as a fact.
 */
function classifySender(s: ThreadSignals): { senderClass: SenderClass; classEvidence: string[] } {
  if (s.vip) return { senderClass: 'human', classEvidence: ['vip'] }

  const bulk: string[] = []
  if (s.hasListUnsubscribe) bulk.push('list-unsubscribe')
  if (s.hasListId) bulk.push('list-id')
  if (s.hasListPost) bulk.push('list-post')
  if (s.hasFeedbackId) bulk.push('feedback-id')
  if (s.precedenceBulk) bulk.push('precedence:bulk')
  if (s.undisclosedRecipients) bulk.push('undisclosed-recipients')
  for (const c of s.categories) if (BULK_CATEGORIES.includes(c)) bulk.push(c.toLowerCase())
  if (bulk.length) return { senderClass: 'bulk', classEvidence: bulk }

  const auto: string[] = []
  if (s.autoSubmitted) auto.push('auto-submitted')
  if (s.hasAutoResponseSuppress) auto.push('x-auto-response-suppress')
  if (s.roleAddress) auto.push('role-address')
  if (s.categories.includes('CATEGORY_UPDATES')) auto.push('category_updates')
  if (auto.length) return { senderClass: 'automated', classEvidence: auto }

  const human: string[] = []
  if (s.userReplied) human.push('you-replied')
  if (s.hasDraft) human.push('you-drafted')
  if (s.sameDomainAsUser) human.push('same-domain')
  if (human.length) return { senderClass: 'human', classEvidence: human }

  return { senderClass: 'unknown', classEvidence: [] }
}

export interface ClassBand { base: number; ceiling: number }

/**
 * Per-class base score and — the load-bearing part — hard ceiling.
 *
 * The ceiling is applied LAST, after every modifier and after the model's
 * opinion is blended in (see scoreFocusItems). That is what makes the
 * guarantee structural rather than a matter of tuning: a thread carrying
 * List-Unsubscribe cannot render an "Important" chip no matter what the
 * subject line claims or how confidently the model argues for it.
 */
export const CLASS_BANDS: Record<SenderClass, ClassBand> = {
  human: { base: 55, ceiling: 100 },  // may reach Urgent
  unknown: { base: 35, ceiling: 84 }, // may reach Important, never Urgent
  automated: { base: 20, ceiling: 59 }, // may reach Routine, never Important
  bulk: { base: 5, ceiling: 29 },     // Low only
}

/** Ceiling forced on a thread that tries to instruct the ranker. */
export const INJECTION_CEILING = 29

/**
 * Default inclusion cut. Named and exported rather than inlined because the
 * Priority Inbox ablation puts the per-user threshold on par with the entire
 * per-user model (45% → 38% error from personal weights, 38% → 31% from the
 * personal threshold). Making it per-user is the obvious next step.
 */
export const DEFAULT_MIN_PRIORITY = 55

/** The deterministic "global model" score for one thread. */
export function deterministicPriority(sig: ThreadSignals): number {
  const band = CLASS_BANDS[sig.senderClass]
  let score = band.base

  // Explicit user intent — the strongest evidence available, and the only
  // signals that come from the user rather than from the sender.
  if (sig.hasDraft) score += 25
  if (sig.userReplied) score += 20
  if (sig.isStarred) score += 20
  if (sig.vip) score += 30

  // Addressing. Dabbish et al. (CHI 2005): a single-recipient message is
  // substantially more likely to be acted on; list-addressed mail much less.
  if (sig.addressedDirectly) score += 12
  else if (!sig.notAddressed && !sig.ccOnly && sig.recipientCount <= 5) score += 6
  if (sig.ccOnly) score -= 8
  if (sig.notAddressed) score -= 12
  if (sig.recipientCount > 15) score -= 6

  if (sig.isCalendarInvite) score += 10
  if (sig.sameDomainAsUser) score += 10

  // Deliberately small. Unread is a fact about the user's attention, not about
  // the message's importance, and weighting it heavily is precisely what
  // turned the old strip into a list of the newest three emails.
  if (sig.isUnread) score += 8

  if (sig.ageMs !== null && sig.ageMs >= 0) {
    if (sig.ageMs < 2 * 3600_000) score += 10
    else if (sig.ageMs < 24 * 3600_000) score += 6
    else if (sig.ageMs < 72 * 3600_000) score += 2
    else if (sig.ageMs > 7 * 24 * 3600_000) score -= 8
  }

  // A long thread only counts when the user is IN it. Otherwise a chatty
  // notification sequence ("order placed" → "order shipped" → "delivered")
  // scored the same as a real back-and-forth and could reach the Urgent tier,
  // which fired desktop notifications.
  if (sig.messageCount > 1 && sig.userReplied) score += 8

  if (sig.isImportant) score += 4       // Gmail's own label: dense, so low weight
  if (sig.categories.includes('CATEGORY_PERSONAL')) score += 4
  if (sig.autoSubmittedNo) score += 4

  const ceiling = sig.suspectedInjection ? Math.min(band.ceiling, INJECTION_CEILING) : band.ceiling
  return Math.max(0, Math.min(ceiling, Math.round(score)))
}

/**
 * A one-line reason that the code can PROVE from a header or a label.
 *
 * The old fallback asserted "Unread message from a real person" for anything
 * whose address didn't match a regex — which is how Morning Brew and Formspree
 * came to be described as individuals. Every string below is checked against
 * the evidence that produced it, and no string claims a human author unless a
 * VIP match, a reply, or a same-domain address establishes one.
 */
export function deterministicReason(sig: ThreadSignals): string {
  if (sig.suspectedInjection) return 'Contains instruction-like text — review before acting'
  if (sig.vip) return sig.vip.category === 'personal' ? 'Personal VIP sender' : 'VIP sender'
  if (sig.hasDraft) return 'You have an unsent draft in this thread'
  if (sig.userReplied) return 'You replied in this thread'
  if (sig.isStarred) return 'You starred this thread'
  if (sig.senderClass === 'bulk') {
    if (sig.hasOneClickUnsubscribe || sig.hasListUnsubscribe) return 'Bulk mail — carries an unsubscribe link'
    if (sig.hasListId || sig.hasListPost) return 'Mailing-list mail'
    return 'Bulk or promotional mail'
  }
  if (sig.senderClass === 'automated') return 'Automated notification — no reply expected'
  if (sig.isCalendarInvite) return 'Calendar invite'
  if (sig.sameDomainAsUser) return 'From your own domain'
  if (sig.senderClass === 'unknown') {
    return sig.addressedDirectly
      ? 'First-time sender, addressed only to you'
      : "Sender you haven't corresponded with before"
  }
  if (sig.addressedDirectly) return 'Addressed directly to you'
  return 'Ongoing correspondence'
}
