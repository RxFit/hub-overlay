import { db } from './db'
import { eventLog } from './schema'
import { createLogger } from './logger'
import { getTenantId } from './tenant-context'

const log = createLogger('event-logger')

export interface EventOptions {
  eventType: string
  actor: string
  resourceType?: string | null
  resourceId?: string | null
  payload?: Record<string, unknown> | null
  correlationId?: string | null
  tenantId?: string
}

/**
 * Append-only audit logging — one row into the Postgres `event_log` table.
 * Accepts an optional transaction client (`tx`) to run within an active
 * transaction.
 *
 * Two entry points, one insert:
 *  - `recordEventStrict` REJECTS on failure. It exists so a caller that
 *    accounts for its own dropped writes (lib/fault-report.ts's `sinkFailed`
 *    counter) can actually observe one — a sink that swallows its own
 *    failure makes a DB outage look like perfect health.
 *  - `recordEvent` is the best-effort wrapper everything else uses: audit
 *    failures never block the main workflow; the failure is logged (event
 *    type only — never the payload, which during an outage would put every
 *    request's payload into the error log) and swallowed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recordEventStrict(opts: EventOptions, tx?: any): Promise<void> {
  const tenantId = opts.tenantId || getTenantId()
  if (!opts.tenantId) {
    log.debug({ eventType: opts.eventType }, 'recordEvent: no explicit tenantId — resolved via getTenantId() fallback')
  }
  const client = tx || db

  await client.insert(eventLog).values({
    tenantId,
    eventType: opts.eventType,
    actor: opts.actor,
    resourceType: opts.resourceType ?? null,
    resourceId: opts.resourceId ?? null,
    payload: opts.payload ?? null,
    correlationId: opts.correlationId ?? null,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recordEvent(opts: EventOptions, tx?: any): Promise<void> {
  try {
    await recordEventStrict(opts, tx)
    log.debug({ eventType: opts.eventType, actor: opts.actor }, 'Event logged successfully')
  } catch (err) {
    // Audit log failures should not block the main workflow. Log the event
    // TYPE only — not opts: during a DB outage, logging the whole payload on
    // every request would amplify the outage into the error log.
    log.error({ err, eventType: opts.eventType }, 'Failed to record event in DB')
  }
}
