import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { createLogger } from '@/lib/logger'

const log = createLogger('db')

/**
 * Singleton Drizzle client for Railway Postgres.
 * Lazy-initialized so the module can be imported at build time without DATABASE_URL.
 * Throws at runtime if DATABASE_URL is missing.
 */

let _db: ReturnType<typeof drizzle> | null = null

/**
 * Resolve and validate the Postgres connection parameters from a DATABASE_URL.
 *
 * Node 22 strict URL parsing breaks on Unix domain sockets in connection
 * strings, so we keep `localhost` in the URL to satisfy the parser and manually
 * extract the `?host=` query param (the Cloud SQL socket path) to override
 * postgres.js' connection host.
 *
 * SOCKET-INVARIANT GUARD — fail early, fail loud (P1). A malformed DATABASE_URL
 * used to fall through to a `localhost` TCP connect which, in Cloud Run, reaches
 * nothing and ECONNREFUSEs at the FIRST query instead of at boot — hiding a
 * broken deploy behind a revision that looks up but can't serve. We refuse that:
 *   - A `?host=` override in this app is ALWAYS a Cloud SQL Unix socket and must
 *     be an absolute path (e.g. /cloudsql/PROJECT:REGION:INSTANCE); a
 *     non-absolute value is rejected in every environment.
 *   - With no socket override, a localhost / 127.0.0.1 / empty host in
 *     production cannot reach Cloud SQL and is rejected there. (Local dev on
 *     localhost and a real TCP host both pass.)
 *
 * SECURITY: DATABASE_URL and cleanUrl carry the DB password and are NEVER placed
 * in a thrown message or log — only `explicitHost` (a non-secret /cloudsql/…
 * path) and the literal loopback hostname token may appear.
 *
 * @throws Error (`[db] …`) when the URL violates the socket invariant.
 */
export function resolveDbConnection(url: string): { cleanUrl: string; explicitHost?: string } {
  const hostMatch = url.match(/[?&]host=([^&\s]+)/)
  const explicitHost = hostMatch ? decodeURIComponent(hostMatch[1]) : undefined

  // Strip the ?host= parameter from the URL so postgres.js doesn't send it to
  // the DB as a config parameter.
  const cleanUrl = url.replace(/[?&]host=[^&\s]+/, '').replace(/\?$/, '')

  if (explicitHost !== undefined) {
    // A ?host= override is always a Cloud SQL Unix socket → must be absolute.
    if (!explicitHost.startsWith('/')) {
      throw new Error(
        `[db] DATABASE_URL ?host= override must be an absolute Cloud SQL socket path ` +
          `(e.g. /cloudsql/PROJECT:REGION:INSTANCE), got a non-absolute value: "${explicitHost}".`,
      )
    }
  } else if (process.env.NODE_ENV === 'production') {
    // No socket override in production — a loopback/empty host can't reach
    // Cloud SQL. Parse defensively: a URL that won't parse is treated as a
    // real (non-local) host we can't classify, never a guard failure.
    let hostname: string | undefined
    try {
      hostname = new URL(cleanUrl).hostname
    } catch {
      // Unparseable → leave hostname undefined → do not throw.
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '') {
      throw new Error(
        `[db] DATABASE_URL resolves to the "${hostname || 'localhost'}" host in production but has no ` +
          `?host= Cloud SQL socket override — this cannot reach Cloud SQL and will ECONNREFUSE at the ` +
          `first query. Set ?host=/cloudsql/PROJECT:REGION:INSTANCE for the Cloud Run deployment.`,
      )
    }
  }

  return { cleanUrl, explicitHost }
}

function getDb() {
  if (_db) return _db
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('[db] DATABASE_URL is not set. Add it to Railway hub service env vars.')

  const { cleanUrl, explicitHost } = resolveDbConnection(url)

  const client = postgres(cleanUrl, {
    max: 10,
    idle_timeout: 20,
    // Bound connection ESTABLISHMENT (library default: 30s). During a Cloud
    // SQL incident with hanging connects, every pooled query used to wait the
    // full 30s before failing — with this shared singleton behind chat, KPI
    // sync and reports, that stacked into user-visible stalls. 10s fails fast
    // to each caller's own fallback. (Deliberately NO statement_timeout here:
    // embedding upserts and report jobs legitimately run long; per-path
    // bounds belong at the call sites, e.g. lib/ai-tools/resolve.ts.)
    connect_timeout: 10,
    ...(explicitHost && { host: explicitHost })
  })
  _db = drizzle(client, { schema })
  log.info('Database connection initialized')
  return _db
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop]
  },
})

/**
 * Execute a function within a database transaction.
 * All operations inside the callback will be committed together
 * or rolled back if any operation throws.
 */
export async function withTransaction<T>(
  fn: (tx: Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  try {
    return await getDb().transaction(fn)
  } catch (err) {
    log.error({ err }, 'Transaction failed — all changes rolled back')
    throw err
  }
}
