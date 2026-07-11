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

function getDb() {
  if (_db) return _db
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('[db] DATABASE_URL is not set. Add it to Railway hub service env vars.')
  
  // Node 22 strict URL parsing breaks on Unix domain sockets in connection strings.
  // We use `localhost` in the URL to satisfy the parser, and manually extract the `host`
  // query param (used for Cloud SQL sockets) to override the postgres.js connection options.
  const hostMatch = url.match(/[?&]host=([^&]+)/)
  const explicitHost = hostMatch ? decodeURIComponent(hostMatch[1]) : undefined
  
  const client = postgres(url, { 
    max: 10, 
    idle_timeout: 20,
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
