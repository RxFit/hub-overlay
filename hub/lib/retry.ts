import { toFault, type FaultContext } from '@/lib/fault'
import type { FaultCode } from '@/lib/fault-codes'
import { reportFault } from '@/lib/fault-report'
import { swallow } from '@/lib/swallow'

/**
 * withRetry — exponential-backoff retry wrapper with the OTel accounting
 * rule built in (ERROR_REPORTING_2026-08-24.md §3 Layer 4 :233, §6 :895).
 *
 * The rule that makes the error rate mean anything: "Errors that were
 * retried or handled (allowing an operation to complete gracefully) SHOULD
 * NOT be recorded on spans or metrics that describe this operation." So:
 *
 *  - A retry that eventually SUCCEEDS produces exactly ONE `degraded` fault
 *    carrying `retryCount: n` — reported HERE, structurally, so no caller
 *    can forget it and none can turn n swallowed failures into n `error`
 *    rows. Without this the reported error rate is inflated by the retry
 *    factor (three attempts → 3× the true rate).
 *  - A retry that is EXHAUSTED (or a non-retryable error) throws the caught
 *    error object unchanged and reports NOTHING: the record is made once,
 *    later, at the boundary that gives up (withFault → toFault). The attempt
 *    count rides along as a NON-ENUMERABLE `retryCount` annotation on the
 *    error so toFault can count it onto that terminal record without the
 *    annotation leaking into any JSON.stringify / Object.keys consumer.
 *
 * SERVER-ONLY: this module now imports lib/fault (next/server, node crypto)
 * through lib/fault-report. It must never reach a client-component bundle
 * (the directive string is deliberately not spelled out here so a
 * directive grep over lib/ does not false-positive on this comment) —
 * every importer today is a server route or a server-side lib.
 *
 * Retry policy: 5xx and network/timeout shapes are retried; 4xx is
 * deterministic and is not; CircuitOpenError is refused BY POLICY (see
 * isRetryable). Existing callers are left untouched.
 *
 * Classification of the recovered record: what this loop retries is mostly
 * a plain `Error('... status 503')` / `Error('fetch failed')` shape, and
 * lib/fault.ts recognize() has no rule for HTTP-status text, so toFault
 * alone would file the recovery as `internal` — code blame, isRetryable
 * false — contradicting the retry decision just made and counting an
 * upstream wobble as an internal defect. retryableCode() mirrors
 * isRetryable's token rules onto the closed taxonomy (upstream_5xx,
 * upstream_unavailable, timeout_connect, timeout_idle) and is applied ONLY
 * when recognize() had nothing better (`internal`, not cancelled): an
 * AppError, a syscall-coded error or an aborted attempt keeps its own verdict.
 */

/** What `onAttempt` receives — once per FAILED attempt, never on success. */
export interface RetryAttemptInfo {
  /** 1-based: the attempt that just failed. */
  attempt: number
  maxAttempts: number
  err: unknown
  willRetry: boolean
  /** The backoff about to be slept (jitter included); 0 when !willRetry. */
  delayMs: number
}

export interface RetryOpts {
  maxAttempts?: number
  baseMs?: number
  jitter?: boolean
  /** Observer for every failed attempt. A throwing hook is swallowed
   *  (module 'retry', op 'onAttempt') and never alters the retry. */
  onAttempt?: (info: RetryAttemptInfo) => void
  /** Attribution for the recovered-after-retry `degraded` fault: the pino
   *  `module` binding of the caller (defaults to 'retry'). */
  module?: string
  /** The operation being retried, e.g. 'listLabels' (defaults to 'withRetry'). */
  op?: string
}

const RETRYABLE_STATUS = ['500', '502', '503', '504']
// Grouped by the taxonomy code retryableCode() files a recovery under; the
// union is exactly the retryable-network token list isRetryable() has
// always used.
const RETRYABLE_TIMEOUT_CONNECT = ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']
const RETRYABLE_UNAVAILABLE = ['fetch failed', 'ECONNREFUSED', 'ECONNRESET', 'network']
const RETRYABLE_NETWORK = [
  'AbortError',
  ...RETRYABLE_UNAVAILABLE,
  ...RETRYABLE_TIMEOUT_CONNECT,
  'timeout',
]

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ''

  // CircuitOpenError FIRST, by name (lib/circuit-breaker.ts:6). A tripped
  // breaker means "we did not try, by policy" — retrying it would be the
  // retry loop overriding the breaker's decision, and the spec (§3 Layer 4
  // :235) requires logs to distinguish that from "we tried and
  // the dependency said no". Previously this only held because the message
  // `Circuit open for "<key>"` happens to carry no retryable token; that is
  // a coincidence, not a rule, so make it explicit. lib/fault.ts already
  // maps the name to upstream_breaker_open (non-retryable by definition).
  if (name === 'CircuitOpenError') return false

  // Reject 4xx — deterministic failures should not be retried
  if (/\b4\d{2}\b/.test(msg)) return false

  // Retry on server error status codes
  if (RETRYABLE_STATUS.some((code) => msg.includes(code))) return true

  // Retry on network / timeout errors
  if (RETRYABLE_NETWORK.some((tok) => msg.includes(tok) || name.includes(tok))) return true

  return false
}

/**
 * The closed-taxonomy code for a shape isRetryable() accepted — used for the
 * recovered-after-retry record ONLY, and only when lib/fault.ts recognize()
 * classified the error as plain `internal`. Mirrors isRetryable's token
 * rules (lib/retry.test.ts pins that every retryable shape maps); returns
 * undefined for anything else (AbortError included) so the caller keeps
 * recognize()'s verdict.
 */
function retryableCode(err: unknown): FaultCode | undefined {
  const msg = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ''
  const has = (tok: string) => msg.includes(tok) || name.includes(tok)
  if (RETRYABLE_STATUS.some((code) => msg.includes(code))) return 'upstream_5xx'
  if (RETRYABLE_TIMEOUT_CONNECT.some(has)) return 'timeout_connect'
  if (RETRYABLE_UNAVAILABLE.some(has)) return 'upstream_unavailable'
  if (has('timeout')) return 'timeout_idle'
  return undefined
}

/**
 * Stamp the retry count onto the error the boundary will normalize.
 * Non-enumerable so it never appears in Object.keys / JSON.stringify (an
 * error body echoed to a client must not grow a field nobody allowlisted);
 * configurable so a second wrapper can re-stamp. Wrapped because a frozen
 * or sealed error makes defineProperty throw a TypeError — and turning the
 * caller's error into a DIFFERENT error would be worse than losing the
 * count.
 */
function annotateRetryCount(err: unknown, retries: number): void {
  if (retries < 1) return
  if (typeof err !== 'object' || err === null) return
  try {
    Object.defineProperty(err, 'retryCount', {
      value: retries,
      enumerable: false,
      configurable: true,
    })
  } catch {
    // Frozen/sealed error: the count is lost, the error is not.
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOpts,
): Promise<T> {
  // Floor at 1. This is the ONE deliberate behaviour change from the old
  // counted `for` loop: for maxAttempts <= 0 that loop never called fn and
  // fell through to `throw lastError` with lastError still `undefined` — a
  // throw of a non-Error that no `catch (err)` can attribute, and exactly the
  // only-throw-error violation this rewrite exists to remove. Reproducing it
  // would mean re-adding an `unknown` throw, so instead a wrapper named
  // withRetry always makes at least one attempt. No caller passes <= 0
  // (the smallest maxAttempts in the tree is 2; the rest take the default);
  // lib/retry.test.ts pins this so it cannot drift silently.
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 3)
  const baseMs = opts?.baseMs ?? 500
  const jitter = opts?.jitter ?? true
  // Not named `module`: that identifier is a CommonJS global and the Next
  // ESLint preset (@next/next/no-assign-module-variable) fails `npm run lint`
  // on it, which is a CI gate (.github/workflows/ci.yml "Lint").
  const moduleName = opts?.module ?? 'retry'
  const op = opts?.op ?? 'withRetry'

  let lastError: unknown
  // 0-based; reported to onAttempt as `attempt + 1`. Equals the number of
  // retries already spent when fn() finally resolves.
  let attempt = 0

  // `for (;;)` with every exit inside the catch: each throw is of the caught
  // `err` (a real throwable, never `unknown`), and there is no statement
  // after the loop, so the old trailing `throw lastError` — an
  // only-throw-error violation and a throw of `unknown` — has nowhere to
  // live. Same attempt counts, same delays, same jitter as before.
  for (;;) {
    try {
      const value = await fn()
      if (attempt > 0) {
        // Recovered: ONE degraded record for the whole operation, carrying
        // the failures a caller never saw. reportFault never throws and
        // never awaits on this path (its module contract); toFault never
        // throws. The guard is insurance against the one outcome the spec
        // forbids — telemetry turning a recovered call into a failure.
        try {
          const ctx: FaultContext = {
            layer: 'lib',
            module: moduleName,
            severity: 'degraded',
            outcome: 'degraded',
            retryCount: attempt,
            // `op` is on lib/fault.ts ALLOWED_CONTEXT_KEYS, so this lands
            // on the record as context.op (a code-chosen operation name,
            // never user data).
            context: { op },
          }
          let draft = toFault(lastError, ctx)
          // recognize() placed nothing (plain `internal`, and not a user
          // abort): re-file under the code the retry decision was made on,
          // so the record agrees with the loop that produced it. A second
          // toFault call is the price of never overriding a code recognize()
          // DID find (an AppError's own code, a syscall-coded error).
          if (draft.code === 'internal' && draft.outcome !== 'cancelled') {
            const code = retryableCode(lastError)
            if (code) draft = toFault(lastError, { ...ctx, code })
          }
          reportFault(draft)
        } catch (reportErr) {
          swallow(reportErr, { module: 'retry', op: 'reportRecovered' })
        }
      }
      return value
    } catch (err) {
      lastError = err

      const isLast = attempt === maxAttempts - 1
      const willRetry = !isLast && isRetryable(err)

      let delayMs = 0
      if (willRetry) {
        const delay = baseMs * Math.pow(2, attempt)
        delayMs = jitter ? delay + Math.random() * delay * 0.3 : delay
      }

      if (opts?.onAttempt) {
        // A throwing observer must never change the retry decision.
        try {
          opts.onAttempt({ attempt: attempt + 1, maxAttempts, err, willRetry, delayMs })
        } catch (hookErr) {
          swallow(hookErr, { module: 'retry', op: 'onAttempt' })
        }
      }

      if (!willRetry) {
        // Exhausted or non-retryable: no record here — the boundary that
        // gives up makes it (spec §3 Layer 4 :233: "attempts are counted
        // onto the eventual record"). `attempt` retries preceded this failure.
        annotateRetryCount(err, attempt)
        throw err
      }

      await sleep(delayMs)
      attempt++
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
