import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { generateEmbedding, upsertDocumentChunk } from '../lib/vector-store'
import { db } from '../lib/db'
import { tenants } from '../lib/schema'

async function debug() {
  console.log('=== Debugging Upsert/Embedding ===')
  console.log('GEMINI_API_KEY prefix:', process.env.GEMINI_API_KEY?.substring(0, 7))
  console.log('DATABASE_URL prefix:', process.env.DATABASE_URL?.substring(0, 15))

  try {
    console.log('1. Testing database connectivity...')
    const allTenants = await db.select().from(tenants)
    console.log('Database connected. Found tenants:', allTenants.map(t => t.id))
  } catch (dbErr) {
    console.error('FAIL: Database connection failed:', dbErr)
  }

  try {
    console.log('2. Testing generateEmbedding with Gemini...')
    const emb = await generateEmbedding('hello world')
    console.log('SUCCESS: Generated embedding. Dimensions:', emb.length)
  } catch (embErr) {
    console.error('FAIL: Embedding generation failed:', embErr)
  }

  try {
    console.log('3. Testing upsertDocumentChunk...')
    const res = await upsertDocumentChunk('rxfit', 'debug-source', 'hello world')
    console.log('SUCCESS: Upserted chunk. ID:', res.id)
  } catch (upsertErr) {
    console.error('FAIL: upsertDocumentChunk failed:', upsertErr)
  }
}

debug().catch(console.error)
