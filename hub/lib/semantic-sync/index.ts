/**
 * Semantic sync — the Hub's feed of Stripe and Gmail records into dedicated
 * Vertex AI Search Cloud Storage data stores in the Semantic Brain's project
 * (semantic-brain-desktop) that are NOT connected to the chat engine — see
 * the exposure guard in ./run.ts. Entry point for POST /api/cron/semantic-sync.
 *
 * Operating it (buckets, data stores, IAM, the domain-wide-delegation grant,
 * env vars): hub/docs/runbooks/semantic-sync.md.
 */

import { mintServiceAccountToken, readServiceAccountKey } from '@/lib/google-auth'
import { SYNC_SOURCES, chatEnginePath, readSourceConfig, type SourceConfig, type SyncSourceId } from './config'
import { createDiscoveryImporter } from './discovery-import'
import { createGcsStore } from './gcs'
import { GMAIL_READONLY_SCOPE, createGmailSource } from './gmail-source'
import { isConnectedToEngine, notConfiguredResult, runSourceSync, type RunOptions, type SourceRunResult, type SyncState } from './run'
import type { SyncSource } from './source'
import { createStripeSource } from './stripe-source'

export { SYNC_SOURCES, type SyncSourceId } from './config'
export type { SourceRunResult } from './run'

/** GCS writes and Discovery Engine imports, as the service account itself. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

function buildSource(config: SourceConfig): SyncSource {
  if (config.source === 'stripe') {
    return createStripeSource({ apiKey: process.env.STRIPE_SECRET_KEY as string })
  }
  return createGmailSource({ subject: config.subject as string, query: config.query })
}

export async function runSemanticSync(
  opts: RunOptions & { sources?: SyncSourceId[]; signal?: AbortSignal },
): Promise<SourceRunResult[]> {
  const token = () => mintServiceAccountToken({ scope: CLOUD_PLATFORM_SCOPE, signal: opts.signal })
  const importer = createDiscoveryImporter({ token, signal: opts.signal })
  const wanted = opts.sources?.length ? opts.sources : SYNC_SOURCES

  // Sources are independent: one failing (say, delegation not yet granted)
  // must not stop the other. runSourceSync never throws — failures come back
  // as `status: 'failed'` with the stage that broke.
  return Promise.all(
    wanted.map(async (source) => {
      const config = readSourceConfig(source)
      if (!config.ready || !config.location) return notConfiguredResult(config)
      return runSourceSync(
        {
          config,
          source: buildSource(config),
          store: createGcsStore({ bucket: config.location.bucket, token, signal: opts.signal }),
          importer,
          chatEngine: chatEnginePath(),
          signal: opts.signal,
        },
        opts,
      )
    }),
  )
}

export interface SemanticSyncStatus {
  serviceAccount: {
    configured: boolean
    clientEmail: string | null
    /** Paste this into Admin console → Security → API controls → Domain-wide delegation. */
    delegationClientId: string | null
  }
  sources: Array<{
    source: SyncSourceId
    ready: boolean
    missing: string[]
    location: string | null
    dataStore: string | null
    mailbox?: string
    gmailQuery?: string
    delegationScope?: string
    /**
     * Whether the data store is connected to the Hub chat engine (the sync
     * refuses to import while it is); null when it could not be checked.
     */
    dataStoreChatVisible?: boolean | null
    /** The source's cursor file, when it is ready and has run at least once. */
    state?: SyncState | null
    stateUnreadable?: string
  }>
}

/**
 * Non-secret readiness snapshot for the admin status route: which variables
 * are missing, the delegation client id to authorize, and each ready source's
 * cursor (last success, last import operation).
 */
export async function getSemanticSyncStatus(signal?: AbortSignal): Promise<SemanticSyncStatus> {
  const key = readServiceAccountKey()
  const token = () => mintServiceAccountToken({ scope: CLOUD_PLATFORM_SCOPE, signal })
  const chatEngine = chatEnginePath()
  let engineIds: Promise<string[] | null> | undefined
  const readEngineIds = () =>
    (engineIds ??= createDiscoveryImporter({ token, signal }).engineDataStoreIds(chatEngine).catch(() => null))

  const sources = await Promise.all(
    SYNC_SOURCES.map(async (source) => {
      const c = readSourceConfig(source)
      const base = c.location ? [c.location.prefix, source].filter(Boolean).join('/') : null
      const entry: SemanticSyncStatus['sources'][number] = {
        source,
        ready: c.ready,
        missing: c.missing,
        location: c.location ? `gs://${c.location.bucket}/${base}` : null,
        dataStore: c.dataStore ?? null,
        ...(source === 'gmail'
          ? { mailbox: c.subject, gmailQuery: c.query, delegationScope: GMAIL_READONLY_SCOPE }
          : {}),
      }
      if (c.dataStore && key) {
        const ids = await readEngineIds()
        entry.dataStoreChatVisible = ids ? isConnectedToEngine(c.dataStore, chatEngine, ids) : null
      }
      if (c.ready && c.location && base) {
        try {
          const store = createGcsStore({ bucket: c.location.bucket, token, signal })
          entry.state = await store.getJson<SyncState>(`${base}/_state.json`)
        } catch (err) {
          entry.stateUnreadable = err instanceof Error ? err.message : String(err)
        }
      }
      return entry
    }),
  )

  return {
    serviceAccount: {
      configured: key !== null,
      clientEmail: key?.client_email ?? null,
      delegationClientId: key?.client_id ?? null,
    },
    sources,
  }
}
