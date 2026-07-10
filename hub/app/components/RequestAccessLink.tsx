'use client'

import { buildAccessRequestMailto } from '@/lib/access-request'

/**
 * A lightweight, consistent "request access" affordance for the app's
 * access-denied / not-yet-provisioned dead-ends. Renders a `mailto:` anchor
 * pre-filled with an access-request draft (recipient = the tenant admin contact
 * when configured, else blank for the user to address). Purely additive — the
 * surrounding copy is unchanged; this just adds an actionable path.
 */
export function RequestAccessLink({
  role,
  reason,
  label = 'Request access',
  className,
  style,
}: {
  role?: string
  reason?: string
  label?: string
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <a
      href={buildAccessRequestMailto({ role, reason })}
      className={className}
      style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'underline', ...style }}
    >
      {label}
    </a>
  )
}
