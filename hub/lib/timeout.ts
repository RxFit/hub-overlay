import { createLogger } from './logger'

const log = createLogger('timeout')

/**
 * Race a promise against a timeout. Returns fallback value on timeout.
 *
 * Critical for preventing upstream hangs from blocking SSE responses,
 * intent detection, or any other time-sensitive pipeline stage.
 *
 * Timer is properly cleaned up via `finally { clearTimeout }` to prevent
 * event-loop leaks (hub-00018 fix).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>
  const timer = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => {
      log.warn({ ms, label }, `Timeout exceeded for ${label} — using fallback`)
      resolve(fallback)
    }, ms)
  })
  try {
    return await Promise.race([promise, timer])
  } finally {
    clearTimeout(timeoutId!)
  }
}
