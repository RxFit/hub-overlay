import crypto from 'crypto'
import { createLogger } from './logger'

const log = createLogger('loop-detector')

export class LoopDetectedError extends Error {
  constructor(method: string, path: string, count: number) {
    super(`Loop detected: Same write request [${method} ${path}] was executed ${count} times sequentially within a short time window.`)
    this.name = 'LoopDetectedError'
  }
}

interface RequestRecord {
  signature: string
  timestamp: number
  scope: string
}

/**
 * LoopDetector monitors outgoing HTTP write operations.
 * If the same request (signature based on URL, method, and hashed body)
 * is repeated 3 times within 5 seconds without other intervening successful requests,
 * it trips and throws a LoopDetectedError to prevent infinite loops.
 */
class LoopDetector {
  private history: RequestRecord[] = []
  private readonly MAX_HISTORY = 50
  private readonly REPEAT_THRESHOLD = 3
  private readonly TIME_WINDOW_MS = 5000 // 5 seconds

  getSignature(method: string, path: string, body?: any): string {
    const methodUpper = method.toUpperCase()
    const bodyStr = body
      ? typeof body === 'string'
        ? body
        : JSON.stringify(body)
      : ''
    const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex')
    return `${methodUpper}:${path}:${bodyHash}`
  }

  /**
   * Tracks a request and checks for loops.
   * Throws a LoopDetectedError if a loop is detected.
   */
  detectAndRecord(method: string, path: string, body?: any, scope: string = '__global__'): void {
    const methodUpper = method.toUpperCase()
    // Skip GET/HEAD requests as they are safe and expected to be repeated
    if (['GET', 'HEAD'].includes(methodUpper)) {
      return
    }

    const signature = this.getSignature(method, path, body)
    const now = Date.now()

    // Filter out old history outside the window
    this.history = this.history.filter((h) => now - h.timestamp < this.TIME_WINDOW_MS)

    // Check how many times this exact signature was repeated in our window for this scope
    const occurrences = this.history.filter((h) => h.signature === signature && h.scope === scope)

    if (occurrences.length >= this.REPEAT_THRESHOLD - 1) {
      log.error(
        { method: methodUpper, path, occurrences: occurrences.length + 1, scope },
        'CRITICAL: Sequential write request loop detected!',
      )
      throw new LoopDetectedError(methodUpper, path, occurrences.length + 1)
    }

    this.history.push({ signature, timestamp: now, scope })
    if (this.history.length > this.MAX_HISTORY) {
      this.history.shift()
    }
  }

  /** Clears the detector history (useful for tests) */
  clear(): void {
    this.history = []
  }
}

export const loopDetector = new LoopDetector()
