import { createHash } from 'node:crypto'
import type { EmbedFn } from '@/lib/vault/embeddings'
import { VaultUnavailableError } from '@/lib/vault/errors'

/**
 * Deterministic, offline embedding stand-in. A text maps to a stable
 * 8-dimensional unit vector derived from its SHA-256, so identical texts are
 * identical vectors, and tests can steer similarity by embedding the same
 * text as the query. Failures are scripted per call.
 */

export interface FakeEmbed {
  embed: EmbedFn
  calls: string[]
  /** Throw for the Nth call (1-based) — e.g. "chunk 2 of 3". */
  failOnCall: number | null
  /** Throw for every call whose text matches. */
  failWhen: ((text: string) => boolean) | null
  /** The error to throw when scripted to fail. */
  error: () => Error
}

export function vectorFor(text: string, dims = 8): number[] {
  const digest = createHash('sha256').update(text, 'utf8').digest()
  const raw = Array.from({ length: dims }, (_, i) => (digest[i % digest.length] / 255) * 2 - 1)
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1
  return raw.map((v) => v / norm)
}

export function createFakeEmbed(): FakeEmbed {
  const fake: FakeEmbed = {
    calls: [],
    failOnCall: null,
    failWhen: null,
    error: () => new VaultUnavailableError('embedding', 'http', 'simulated embedding failure'),
    embed: async (text: string, opts?: { signal?: AbortSignal }) => {
      fake.calls.push(text)
      if (opts?.signal?.aborted) throw new VaultUnavailableError('embedding', 'timeout', 'deadline expired')
      if (fake.failOnCall !== null && fake.calls.length === fake.failOnCall) throw fake.error()
      if (fake.failWhen?.(text)) throw fake.error()
      return vectorFor(text)
    },
  }
  return fake
}
