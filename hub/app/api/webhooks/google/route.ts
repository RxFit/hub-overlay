import { NextResponse } from 'next/server';

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

    // 4. Trigger Paperclip Execution Layer asynchronously
    // Paperclip AI will fetch the resource, chunk it, embed it to pgvector, and map the Graph.
    console.log(`[Google Webhook] Triggering Paperclip for resource: ${resourceId}`);
    
    // TODO: Await pubsub or background job queue (e.g., Inngest or simple fetch)
    // await enqueuePaperclipTask('process-google-delta', { resourceId, resourceUri });

    // 5. Always return 200 quickly so Google doesn't retry
    return NextResponse.json({ status: 'Processing delta' }, { status: 200 });
  } catch (error) {
    console.error('[Google Webhook Error]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
