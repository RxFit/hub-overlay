/**
 * Access-request helpers.
 *
 * Several "you don't have access — contact an administrator" dead-ends existed
 * with no in-app path to actually reach the admin. These helpers give those
 * messages a lightweight, actionable escape hatch:
 *  - `getAdminContactEmail()` surfaces the tenant's configured admin contact
 *    (if any — it is intentionally optional and unset by default so no address
 *    is invented).
 *  - `buildAccessRequestMailto()` builds a pre-filled `mailto:` the user can
 *    send to request access. When no admin email is configured the recipient is
 *    left blank so the user's mail client still opens a ready-to-address draft.
 *
 * Pure + dependency-light so the URL construction is unit-tested directly.
 */

import { getTenantConfig } from './tenant'

/** The tenant's configured admin contact email, or undefined if none is set. */
export function getAdminContactEmail(): string | undefined {
  return getTenantConfig().adminContactEmail
}

export interface AccessRequestOptions {
  /** The requester's current role, woven into the draft body for context. */
  role?: string
  /** Extra context (e.g. which panel/action was blocked). */
  reason?: string
  /** Recipient; defaults to the tenant admin contact when omitted. */
  adminEmail?: string
}

/**
 * Build a `mailto:` URL that opens a pre-filled access-request draft. The
 * recipient is the provided `adminEmail`, else the tenant admin contact, else
 * blank (user fills it in). Subject/body are encoded with `encodeURIComponent`
 * (not URLSearchParams, whose `+` space-encoding many mail clients mishandle).
 */
export function buildAccessRequestMailto(opts: AccessRequestOptions = {}): string {
  const to = opts.adminEmail ?? getAdminContactEmail() ?? ''
  const subject = 'Hub access request'
  const body = [
    'Hi,',
    '',
    `I'd like to request access in the Hub${opts.role ? ` (my current role is ${opts.role})` : ''}.`,
    opts.reason ? `Context: ${opts.reason}` : '',
    '',
    'Thanks!',
  ].filter(Boolean).join('\n')
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
