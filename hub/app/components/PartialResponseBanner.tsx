'use client'

import {
  clearPartialResponseNotice,
  usePartialResponseNotice,
} from '@/lib/partial-response-client'

export function PartialResponseBanner() {
  const visible = usePartialResponseNotice()
  if (!visible) return null

  return (
    <div className="partial-response-banner" role="status" aria-live="polite">
      <span>Some data could not be loaded. Values shown may be incomplete.</span>
      <button
        type="button"
        className="partial-response-btn"
        onClick={clearPartialResponseNotice}
      >
        Dismiss
      </button>
    </div>
  )
}
