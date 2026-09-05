'use client'

import {
  clearPartialResponseNotice,
  injectPartialResponseIntoAssistant,
  usePartialResponseAssistantAvailable,
  usePartialResponseNotice,
} from '@/lib/partial-response-client'

export function PartialResponseBanner() {
  const visible = usePartialResponseNotice()
  const assistantAvailable = usePartialResponseAssistantAvailable()
  if (!visible) return null

  return (
    <div className="partial-response-banner" role="status" aria-live="polite">
      <span>Some data could not be loaded. Values shown may be incomplete.</span>
      {assistantAvailable && (
        <button
          type="button"
          className="partial-response-btn"
          onClick={injectPartialResponseIntoAssistant}
        >
          Ask assistant
        </button>
      )}
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
