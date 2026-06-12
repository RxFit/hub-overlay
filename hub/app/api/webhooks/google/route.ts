import { NextResponse } from 'next/server';
import { getServiceAccountAccessToken } from '@/lib/google-auth';
import { fetchDriveDocContent } from '@/lib/content-fetch';

/**
 * Google Workspace Webhook Receiver
 * 
 * Handles incoming push notifications from Google Drive and Calendar.
 * Rather than processing the entire payload synchronously, it acknowledges
 * the webhook immediately and kicks off an async Paperclip AI task to:
 * 1. Read the delta (new doc, updated event).
 * 2. Generate a vector embedding via text-embedding API.
 * 3. Store the chunk in the `documentChunks` pgvector table.
 * 4. Create explicit Graph edges in `entityLinks` connecting the new data to existing KPIs/Nodes.
 */
export async function POST(req: Request) {
  try {
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

    // 3. Handle document deletion or trashing
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
  } catch (error) {
    console.error('[Google Webhook Error]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

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

  // Fetch file metadata to get name, mimeType, webViewLink
  const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,webViewLink`, {
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
  const { getDefaultTenantId } = await import('@/lib/tenant-context');
  const tenantId = getDefaultTenantId();
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

async function deleteChunksForFile(fileId: string) {
  const { db } = await import('@/lib/db');
  const { documentChunks } = await import('@/lib/schema');
  const { like, and, eq } = await import('drizzle-orm');
  const { getDefaultTenantId } = await import('@/lib/tenant-context');
  const tenantId = getDefaultTenantId();

  const deleted = await db.delete(documentChunks).where(
    and(
      eq(documentChunks.tenantId, tenantId),
      like(documentChunks.sourceUrl, `%${fileId}%`)
    )
  ).returning();

  console.log(`[Google Webhook] Successfully deleted ${deleted.length} stale chunks associated with file ID: ${fileId}`);
}
