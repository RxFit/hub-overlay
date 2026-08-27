import pino from 'pino'
import pretty from 'pino-pretty'
import crypto from 'crypto'

/**
 * ONE root pino instance per process (ERROR_REPORTING_2026-08-24.md Layer 0,
 * "Step 0"). The previous shape called `pino(...)` — and in dev allocated a
 * fresh pino-pretty stream — on EVERY createLogger() call; per-request logger
 * construction across 112 route handlers is a per-request allocation for what
 * should be a cheap `child()`. The signature is unchanged, so every existing
 * call site now gets a child of this root for free.
 *
 * In production the root emits Cloud Logging's structured shape, which is what
 * gives the app a push channel at $0: pino's defaults are `"level": 50` and
 * `"msg"`, but Cloud Logging keys on `"severity"` and `"message"`, and GCP
 * Error Reporting ingests any ERROR+ line whose message carries a stack. The
 * label map below is the GCP LogSeverity enum — a blind uppercase would emit
 * WARN/FATAL, which are not members and fall back to DEFAULT severity.
 */

const isDev = process.env.NODE_ENV !== 'production'

/** pino label → GCP LogSeverity (WARN→WARNING, FATAL→CRITICAL are the two
 *  that differ; TRACE is not a member at all). */
const GCP_SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
}

const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info')

// Dev keeps pino's native keys — pino-pretty renders `level`/`msg` — while
// prod emits the GCP shape. One stream, allocated once.
const root = isDev
  ? pino({ level }, pretty({ colorize: true }))
  : pino({
      level,
      messageKey: 'message',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ severity: GCP_SEVERITY[label] ?? 'DEFAULT' }),
      },
      base: {
        serviceContext: { service: 'hub', version: process.env.GIT_SHA ?? 'unknown' },
      },
    })

export function createLogger(module: string, correlationId?: string) {
  return root.child({ module, correlationId: correlationId ?? crypto.randomUUID() })
}

export function withCorrelationId(id: string) {
  return logger.child({ correlationId: id })
}

export const logger = createLogger('hub')
