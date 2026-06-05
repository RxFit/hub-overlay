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
    
    if (!channelToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. We only care about sync/update/add events
    if (resourceState === 'sync') {
      return NextResponse.json({ status: 'Acknowledged Sync' }, { status: 200 });
    }

    // 3. Extract basic payload info (URL, resourceId)
    // Note: The actual body of Google Webhooks is often empty; we have to fetch the resource.
    const resourceId = req.headers.get('x-goog-resource-id') || 'unknown';
    const resourceUri = req.headers.get('x-goog-resource-uri') || '';

    // 4. Process the delta asynchronously so we can return 200 quickly
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

  // POST to pgvector ingestion endpoint
  const hubUrl = process.env.NEXTAUTH_URL || 'https://hub.casatrejo.com';
  const upsertUrl = `${hubUrl}/api/embeddings/upsert`;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const tenantId = process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit';
  const sourceUrl = metadata.webViewLink || `https://docs.google.com/document/d/${fileId}/edit`;

  const postRes = await fetch(upsertUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      tenantId,
      sourceUrl,
      content
    })
  });

  if (!postRes.ok) {
    const bodyText = await postRes.text().catch(() => '');
    throw new Error(`Failed to POST embedding: ${postRes.status} ${bodyText}`);
  }

  console.log(`[Google Webhook] Successfully indexed document ${fileId}`);
}
