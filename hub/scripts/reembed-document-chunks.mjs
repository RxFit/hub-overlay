/**
 * Backfill: re-embed document_chunks into the ACTIVE embedding model's space.
 *
 * WHY: gemini-embedding-001 (EOL 2026-07-14) and gemini-embedding-2 produce
 * embeddings in INCOMPATIBLE vector spaces. lib/vector-store now tags every row
 * with document_chunks.embedding_model and search only trusts rows on the active
 * model, so rows still on the old model (or a legacy NULL) are invisible until
 * re-embedded here. Run this ONCE after deploying the model switch.
 *
 * SAFE + RESUMABLE: only touches rows whose embedding_model differs from the
 * active model; re-running continues where it left off and retries failures.
 * Read-committed single-row UPDATEs — no destructive bulk operation.
 *
 * Run against the target DB (e.g. Cloud SQL via the socket / auth proxy):
 *   DATABASE_URL="postgres://…?host=/cloudsql/PROJECT:REGION:hub-pg" \
 *   GEMINI_API_KEY="…" EMBEDDING_MODEL="gemini-embedding-2" \
 *   node hub/scripts/reembed-document-chunks.mjs [--dry-run] [--limit N] [--batch N]
 *
 * Mirrors drizzle/migrate.mjs' Cloud SQL socket handling; keep the model/dims in
 * sync with lib/vector-store (EMBEDDING_MODEL / EMBEDDING_DIMENSIONS).
 */
import postgres from 'postgres'
import { GoogleGenerativeAI } from '@google/generative-ai'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[reembed] DATABASE_URL is not set. Refusing to run without an explicit connection string.')
  process.exit(1)
}

const API_KEY =
  process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
const MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-2'
const DIMENSIONS = 768
const MAX_CHARS = 8_000

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const numFlag = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def
}
const BATCH = numFlag('--batch', 100)
const MAX_ROWS = numFlag('--limit', Infinity)

// Cloud SQL Unix-socket handling (mirror of drizzle/migrate.mjs).
const hostMatch = DATABASE_URL.match(/[?&]host=([^&\s]+)/)
const explicitHost = hostMatch ? decodeURIComponent(hostMatch[1]) : undefined
const cleanUrl = DATABASE_URL.replace(/[?&]host=[^&\s]+/, '').replace(/\?$/, '')

const sql = postgres(cleanUrl, {
  max: 1,
  connect_timeout: 15,
  ...(explicitHost && { host: explicitHost }),
})

async function main() {
  const [{ n: pending }] = await sql`
    SELECT count(*)::int AS n FROM document_chunks
    WHERE embedding_model IS DISTINCT FROM ${MODEL}
  `
  console.log(`[reembed] ${pending} row(s) are not on model "${MODEL}".`)

  if (DRY_RUN) {
    console.log('[reembed] --dry-run: no changes made.')
    await sql.end()
    return
  }
  if (pending === 0) {
    console.log('[reembed] Nothing to do — all rows are on the active model.')
    await sql.end()
    return
  }
  if (!API_KEY) {
    console.error('[reembed] No GEMINI_API_KEY / GOOGLE_API_KEY set — cannot generate embeddings.')
    await sql.end()
    process.exit(1)
  }

  const genAI = new GoogleGenerativeAI(API_KEY)
  const model = genAI.getGenerativeModel({ model: MODEL })

  const cap = Math.min(pending, MAX_ROWS)
  let done = 0
  let failed = 0

  while (done + failed < cap) {
    const rows = await sql`
      SELECT id, content FROM document_chunks
      WHERE embedding_model IS DISTINCT FROM ${MODEL}
      ORDER BY created_at ASC
      LIMIT ${BATCH}
    `
    if (rows.length === 0) break

    for (const row of rows) {
      if (done + failed >= cap) break
      try {
        const text = (row.content || '').slice(0, MAX_CHARS)
        const res = await model.embedContent({
          content: { parts: [{ text }] },
          outputDimensionality: DIMENSIONS,
        })
        const values = res.embedding.values
        const literal = `[${values.join(',')}]`
        await sql`
          UPDATE document_chunks
          SET embedding = ${literal}::vector, embedding_model = ${MODEL}
          WHERE id = ${row.id}
        `
        done++
      } catch (err) {
        failed++
        console.error(`[reembed] Failed id=${row.id} (${err?.code ?? ''} ${err?.message ?? err})`)
      }
    }
    console.log(`[reembed] progress: ${done} re-embedded, ${failed} failed (of ${cap})`)
  }

  console.log(`[reembed] ✅ Done — ${done} re-embedded, ${failed} failed.`)
  if (failed > 0) {
    console.log('[reembed] Re-run to retry failures (only non-active-model rows are reprocessed).')
  }
  await sql.end()
}

main().catch((err) => {
  console.error(`[reembed] ❌ Failed (${err?.code ?? 'no-code'}): ${err?.message ?? err}`)
  process.exit(1)
})
