import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

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
  const client = postgres(url, { max: 10, idle_timeout: 20 })
  _db = drizzle(client, { schema })
  return _db
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop]
  },
})

