import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { discoverApplicationFootprint } from '@/lib/auditor/discovery';
import { createLogger } from '@/lib/logger';
import { withFault } from '@/lib/route-fault';

const log = createLogger('api/auditor/discover');

export const runtime = 'nodejs';

/**
 * POST /api/auditor/discover
 * Runs static scanning to return the application footprint (API routes and DB schema).
 * Protected using getServerSession(authOptions).
 */
export const POST = withFault('auditor/discover', async (req: Request) => {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    log.warn('Unauthorized POST request to auditor/discover');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const footprint = discoverApplicationFootprint();

  return NextResponse.json(footprint);
})
