import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { runComparisonAudit, saveAuditReport } from '@/lib/auditor/core';
import { createLogger } from '@/lib/logger';
import { withFault } from '@/lib/route-fault';

const log = createLogger('api/auditor/audit');

export const runtime = 'nodejs';

/**
 * POST /api/auditor/audit
 * Runs the Zero-Tolerance Context Audit.
 * Protects using getServerSession(authOptions).
 * Saves the findings to the DB as a tool artifact and returns them.
 */
export const POST = withFault('auditor/audit', async (req: Request) => {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    log.warn('Unauthorized POST request to auditor/audit');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Run the comparison audit
  const findings = await runComparisonAudit();

  // Save the report as a tool artifact
  await saveAuditReport(findings);

  return NextResponse.json({
    success: true,
    findings,
  });
})
