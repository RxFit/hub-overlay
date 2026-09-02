import { NextResponse } from 'next/server';
import { getServiceAccountAccessToken } from '@/lib/google-auth';
import { fetchDriveDocContent } from '@/lib/content-fetch';
import { buildChunkDeleteLikePattern } from '@/lib/chunk-delete-pattern';
import { withFault } from '@/lib/route-fault'

/**
 * Google Workspace Webhook Receiver
 * 
 * Handles incoming push notifications from Google Drive and Calendar.
 * Rather than processing the entire payload synchronously, it acknowledges
 * the webhook immediately and kicks off an async Paperclip AI task to:
 * 1. Read the delta (new doc, updated event).
 * 2. Generate a vector embedding via the active Gemini embedding model.
 * 3. Store the chunk in the `documentChunks` pgvector table.
 * 4. Create explicit Graph edges in `entityLinks` connecting the new data to existing KPIs/Nodes.
 */
export const POST = withFault('webhooks/google', async (req: Request) => {
  // 1. Verify Google Webhook headers (X-Goog-Channel-Token, X-Goog-Resource-State)
  const channelToken = req.headers.get('x-goog-channel-token');
  const resourceState = req.headers.get('x-goog-resource-state');
  
  // Check channel token validity
  const expectedToken = process.env.GOOGLE_WEBHOOK_CHANNEL_TOKEN;
  if (!expectedToken) {
    console.error('[Google Webhook] GOOGLE_WEBHOOK_CHANNEL_TOKEN is not configured.');
    return NextResponse.json({ error: 'Internal configuration error' }, { status: 500 });
  }
  if (!channelToken || channelToken !== expectedToken) {
    console.warn('[Google Webhook] Unauthorized request or channel token mismatch');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Acknowledge sync event immediately
  if (resourceState === 'sync') {
    return NextResponse.json({ status: 'Acknowledged Sync' }, { status: 200 });
  }

  const resourceId = req.headers.get('x-goog-resource-id') || 'unknown';
  const resourceUri = req.headers.get('x-goog-resource-uri') || '';

  // 3a. A changes.watch channel (registered by /api/webhooks/google/renew)
  // does not name a file — it says "something changed, come list it". The
  // notification's only job is to trigger a changes.list from the stored
  // cursor; per-file add/update/trash/delete all fall out of that listing.
  if (resourceUri.includes('/changes')) {
    processChangesQueue().catch(err => {
      console.error('[Google Webhook] Changes processing error:', err);
    });
    return NextResponse.json({ status: 'Processing changes' }, { status: 200 });
  }

  // 3b. Handle document deletion or trashing (legacy per-file channels)
  if (resourceState === 'trash' || resourceState === 'delete') {
    let fileId = resourceId;
    if (resourceUri) {
      const match = resourceUri.match(/\/files\/([a-zA-Z0-9-_]+)/);
      if (match) {
        fileId = match[1];
      }
    }

    console.log(`[Google Webhook] File deleted or trashed. Cleaning up chunks for: ${fileId}`);
    deleteChunksForFile(fileId).catch(err => {
      console.error('[Google Webhook Deletion Error]', err);
    });

    return NextResponse.json({ status: 'Processing deletion' }, { status: 200 });
  }

  // 4. Process the delta asynchronously for add/update events
  processGoogleDelta(resourceId, resourceUri).catch(err => {
    console.error('[Google Webhook Error in Background]', err);
  });

  // 5. Always return 200 quickly so Google doesn't retry
  return NextResponse.json({ status: 'Processing delta' }, { status: 200 });
})

async function processGoogleDelta(resourceId: string, resourceUri: string) {
  console.log(`[Google Webhook] Processing delta for resource: ${resourceId}, URI: ${resourceUri}`);

  const accessToken = await getServiceAccountAccessToken('https://www.googleapis.com/auth/drive.readonly');
  if (!accessToken) {
    throw new Error('Failed to obtain Google Drive access token');
  }

  // Extract file ID from resourceUri or resourceId
  let fileId = resourceId;
  if (resourceUri) {
    const match = resourceUri.match(/\/files\/([a-zA-Z0-9-_]+)/);
    if (match) {
      fileId = match[1];
    }
  }

  await ingestDriveFile(accessToken, fileId);
}

/** Read one Drive file and (re)index it — shared by the legacy per-file path
 *  and the changes-channel path. */
async function ingestDriveFile(accessToken: string, fileId: string) {
  // Fetch file metadata to get name, mimeType, webViewLink
  const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!metaRes.ok) {
    throw new Error(`Failed to fetch file metadata for ${fileId}: ${metaRes.status}`);
  }
  const metadata = await metaRes.json() as { name: string; mimeType: string; webViewLink?: string };

  // Fetch the plain text content
  const content = await fetchDriveDocContent(accessToken, fileId, metadata.mimeType);
  if (content.startsWith('[Failed') || content.startsWith('[Binary')) {
    console.warn(`[Google Webhook] Skipped file ${fileId} content extraction: ${content}`);
    return;
  }

  // Phase 1 (multi-tenancy): derive tenant from webhook channel/hostname.
  // PHASE 2 TODO: When multi-tenant webhook channels exist, derive tenantId
  // from the channel token or a channel-to-tenant lookup instead of env default.
  const { getDefaultTenantId } = await import('@/lib/tenant-context');
  const tenantId = getDefaultTenantId(); // deliberate use of @deprecated helper (see PHASE 2 TODO)
  const sourceUrl = metadata.webViewLink || `https://docs.google.com/document/d/${fileId}/edit`;

  // Use the ingest client to handle chunking, clearing, and uploading
  const { ingestDocument } = await import('@/lib/ingest-client');
  const hubUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';

  console.log(`[Google Webhook] Ingesting file ${fileId} content via ingestDocument...`);
  const result = await ingestDocument(tenantId, sourceUrl, content, {
    baseUrl: hubUrl,
    chunkSize: 3000,
    chunkOverlap: 600
  });

  if (!result.success) {
    throw new Error(`Ingest client failed to index ${fileId}: ${result.error}`);
  }

  console.log(`[Google Webhook] Successfully indexed document ${fileId} with ${result.chunkIds.length} chunks`);
}

/**
 * Coalescing latch for changes processing. Drive sends a notification per
 * mutation, often in bursts; every run lists ALL pending changes from the
 * stored cursor, so concurrent runs would only duplicate work (the ingest is
 * idempotent per sourceUrl, so duplication is waste, not corruption). One run
 * active, at most one queued — a notification landing mid-run is covered by
 * the queued pass, which starts from the cursor the active run stores.
 */
let changesRunInFlight: Promise<void> | null = null;
let changesRunQueued = false;

function processChangesQueue(): Promise<void> {
  if (changesRunInFlight) {
    changesRunQueued = true;
    return changesRunInFlight;
  }
  changesRunInFlight = (async () => {
    do {
      changesRunQueued = false;
      await processChanges();
    } while (changesRunQueued);
  })().finally(() => {
    changesRunInFlight = null;
  });
  return changesRunInFlight;
}

async function processChanges() {
  const accessToken = await getServiceAccountAccessToken('https://www.googleapis.com/auth/drive.readonly');
  if (!accessToken) {
    throw new Error('Failed to obtain Google Drive access token');
  }

  const { getChannel, updatePageToken, DRIVE_CHANGES_KIND } = await import('@/lib/google/webhook-channels-db');
  const { listChanges, shouldIngestChange, fetchStartPageToken, InvalidPageTokenError } = await import('@/lib/google/watch-channels');
  const { getDefaultTenantId } = await import('@/lib/tenant-context');
  const tenantId = getDefaultTenantId(); // PHASE 2 TODO: derive from channel metadata

  const row = await getChannel(tenantId, DRIVE_CHANGES_KIND);
  if (!row?.pageToken) {
    console.warn('[Google Webhook] Changes notification but no stored cursor — run /api/webhooks/google/renew first.');
    return;
  }

  let batch;
  try {
    batch = await listChanges(accessToken, row.pageToken);
  } catch (err) {
    if (err instanceof InvalidPageTokenError) {
      // Cursor too old for Drive to serve (channel was dead for a long time).
      // Reset to "now" — the gap is unrecoverable via changes.list, and a
      // loud log beats retrying a token that can never work again.
      const fresh = await fetchStartPageToken(accessToken);
      await updatePageToken(tenantId, DRIVE_CHANGES_KIND, fresh);
      console.error(`[Google Webhook] Stored changes cursor was rejected by Drive; reset to a fresh startPageToken. Documents changed during the outage will re-index on their next edit.`);
      return;
    }
    throw err;
  }

  console.log(`[Google Webhook] Processing ${batch.changes.length} Drive change(s)...`);
  for (const change of batch.changes) {
    try {
      if (change.removed || change.trashed) {
        await deleteChunksForFile(change.fileId);
      } else if (shouldIngestChange(change)) {
        await ingestDriveFile(accessToken, change.fileId);
      }
    } catch (err) {
      // One unreadable file must not stall the cursor behind it forever.
      console.error(`[Google Webhook] Failed to process change for ${change.fileId}:`, err instanceof Error ? err.message : err);
    }
  }

  // Advance the cursor only after the whole batch was attempted.
  await updatePageToken(tenantId, DRIVE_CHANGES_KIND, batch.newStartPageToken);
}

async function deleteChunksForFile(fileId: string) {
  const { db } = await import('@/lib/db');
  const { documentChunks } = await import('@/lib/schema');
  const { and, eq, sql } = await import('drizzle-orm');
  const { getDefaultTenantId } = await import('@/lib/tenant-context');
  const tenantId = getDefaultTenantId(); // deliberate use of @deprecated helper (see PHASE 2 TODO)
  // PHASE 2 TODO: derive tenant from the webhook channel metadata.

  const pattern = buildChunkDeleteLikePattern(fileId);

  const deleted = await db.delete(documentChunks).where(
    and(
      eq(documentChunks.tenantId, tenantId),
      sql`${documentChunks.sourceUrl} LIKE ${pattern} ESCAPE '\\'`
    )
  ).returning();

  console.log(`[Google Webhook] Successfully deleted ${deleted.length} stale chunks associated with file ID: ${fileId}`);
}
