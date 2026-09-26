import type { SyncSourceId } from './config'
import type { SyncDoc } from './documents'

export interface SyncWindow {
  since: Date
  until: Date
}

export interface CollectResult {
  /** One per record, deduplicated by document id, oldest change first. */
  docs: SyncDoc[]
  /** Records the window listed, before type filtering and dedupe. */
  scanned: number
  /** True when maxItems cut the window short; `cursor` is then the last record processed. */
  truncated: boolean
  /** Where the next run may resume: `until` when complete. */
  cursor: Date
}

export interface SyncSource {
  id: SyncSourceId
  collect(window: SyncWindow, opts: { maxItems: number; signal?: AbortSignal }): Promise<CollectResult>
}

/**
 * Hard ceiling on records LISTED for one window. Both upstreams list newest
 * first, and a run must process oldest first (so a truncated run's cursor
 * never skips anything), which means listing the whole window before
 * processing any of it. A window bigger than this is refused loudly — pass a
 * smaller `lookbackHours` — rather than silently processing only its newest end.
 */
export const LIST_CAP = 5000
