import { type FaultCode, USER_MESSAGES, classifyCode } from '@/lib/fault-codes'

/**
 * The application error base (ERROR_REPORTING_2026-08-24.md §12.1).
 *
 * ONE base class for every application error. A closed `code` union — not a
 * class per case — is what gives exhaustiveness in statusForCode()'s switch.
 *
 * The three constructor rituals live HERE and nowhere else:
 *   - setPrototypeOf with new.target (never a hardcoded class, or instanceof
 *     breaks for every subclass),
 *   - captureStackTrace with new.target so the trace starts at the throw site
 *     rather than inside this constructor,
 *   - super(message, { cause }) — forwarding the OPTIONS OBJECT is the only
 *     way ES2022 installs `cause`. `super(message)` drops the chain silently.
 *
 * The five existing ad-hoc classes (CircuitOpenError, LoopDetectedError,
 * InvalidPageTokenError, SecretCryptoError, PaperclipSchemaError) are NOT
 * retrofitted here — toFault() recognizes them structurally. The retrofit is
 * Phase 2, one class per PR, each with its existing suite green: live control
 * flow matches those classes by instanceof AND message text today, so a
 * base-class swap is a behavior change, not a refactor.
 */

export interface AppErrorOptions {
  code: FaultCode
  /** Fixed per code by default; the ONLY text a client ever sees. */
  userMessage?: string
  /** ES2022 cause. MUST be forwarded to super() or it is silently dropped. */
  cause?: unknown
  /** Allowlist-filtered by scrubContext() before it reaches a record. */
  context?: Record<string, unknown>
  /** Decided once, here, where the failure's meaning is known. */
  retryable?: boolean
  /** Fingerprint override for a call site that knows better than the cascade. */
  fingerprint?: string
}

export class AppError extends Error {
  readonly code: FaultCode
  readonly userMessage: string
  readonly context?: Record<string, unknown>
  readonly retryable: boolean
  readonly fingerprint?: string

  constructor(message: string, opts: AppErrorOptions) {
    super(message, { cause: opts.cause })
    Object.setPrototypeOf(this, new.target.prototype)
    Error.captureStackTrace?.(this, new.target)
    this.name = new.target.name
    this.code = opts.code
    this.userMessage = opts.userMessage ?? USER_MESSAGES[opts.code]
    this.context = opts.context
    this.retryable = opts.retryable ?? classifyCode(opts.code).isRetryable
    this.fingerprint = opts.fingerprint
  }
}

/** Structural check that survives module duplication (two copies of this file
 *  in a bundle would break instanceof; a shape check does not). */
export function isAppError(err: unknown): err is AppError {
  return (
    err instanceof Error &&
    typeof (err as AppError).code === 'string' &&
    typeof (err as AppError).userMessage === 'string' &&
    typeof (err as AppError).retryable === 'boolean'
  )
}
