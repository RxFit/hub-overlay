import { timingSafeEqual } from 'crypto'

/**
 * Constant-time `x-cron-secret` check shared by Cloud-Scheduler-fired routes.
 *
 * /api/kpis/sync and /api/reports/run predate this module and still carry
 * local copies of the same function — migrate them here on next touch rather
 * than growing a third copy per route.
 */
export function verifyCronSecret(header: string | null, secret: string): boolean {
  if (!header) return false
  try {
    const a = Buffer.from(header)
    const b = Buffer.from(secret)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}
