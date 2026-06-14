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
 * Append-only audit logging helper.
 * Inserts a row into the Postgres `event_log` table.
 * Accepts an optional transaction client (`tx`) to run within an active transaction.
 */
export async function recordEvent(opts: EventOptions, tx?: any): Promise<void> {
  const tenantId = opts.tenantId || getTenantId()
  if (!opts.tenantId) {
    log.debug({ eventType: opts.eventType }, 'recordEvent: no explicit tenantId — resolved via getTenantId() fallback')
  }
  const client = tx || db

  try {
    await client.insert(eventLog).values({
      tenantId,
      eventType: opts.eventType,
      actor: opts.actor,
      resourceType: opts.resourceType ?? null,
      resourceId: opts.resourceId ?? null,
      payload: opts.payload ?? null,
      correlationId: opts.correlationId ?? null,
    })
    log.debug({ eventType: opts.eventType, actor: opts.actor }, 'Event logged successfully')
  } catch (err) {
    // Audit log failures should not block the main workflow, but we log the failure
    log.error({ err, opts }, 'Failed to record event in DB')
  }
}
