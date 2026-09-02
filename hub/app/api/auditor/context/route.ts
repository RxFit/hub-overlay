import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { loadAllConstraints, queryConstraintsLocal } from '@/lib/auditor/context';
import { createLogger } from '@/lib/logger';
import { withFault } from '@/lib/route-fault';

const log = createLogger('api/auditor/context');

export const runtime = 'nodejs';

/**
 * GET /api/auditor/context
 * Lists all loaded system constraints/rules from the central Obsidian vault.
 * Supports query parameters:
 *  - `forceRefresh`: (optional) set to 'true' to bypass cache
 *  - `query`: (optional) search string to filter constraints
 *  - `category`: (optional) filter by category ('security' | 'architecture' | 'database' | 'ux')
 */
export const GET = withFault('auditor/context', async (req: Request) => {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    log.warn('Unauthorized GET request to auditor/context');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const forceRefresh = searchParams.get('forceRefresh') === 'true';
  const query = searchParams.get('query') || '';
  const category = searchParams.get('category') || '';

  // Load all constraints from vault
  let constraints = await loadAllConstraints(undefined, forceRefresh);

  // Apply filters
  if (category) {
    constraints = constraints.filter(c => c.category === category.toLowerCase());
  }

  if (query) {
    constraints = queryConstraintsLocal(constraints, query);
  }

  // Deduplicate source files list for metadata
  const sourceFiles = Array.from(new Set(constraints.map(c => c.sourceFile)));

  return NextResponse.json({
    success: true,
    totalCount: constraints.length,
    sourceFilesCount: sourceFiles.length,
    sourceFiles,
    constraints,
  });
})

/**
 * POST /api/auditor/context
 * Submits a query to retrieve relevant system constraints/rules.
 * Accepts a JSON body:
 *  {
 *    "query": "auth flow",
 *    "category": "security",
 *    "limit": 10,
 *    "forceRefresh": false
 *  }
 */
export const POST = withFault('auditor/context', async (req: Request) => {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    log.warn('Unauthorized POST request to auditor/context');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }

  const query = body.query || '';
  const category = body.category || '';
  const forceRefresh = !!body.forceRefresh;
  const limit = typeof body.limit === 'number' ? body.limit : undefined;

  // Load all constraints from vault
  let constraints = await loadAllConstraints(undefined, forceRefresh);

  // Filter by category if specified
  if (category) {
    constraints = constraints.filter(c => c.category === category.toLowerCase());
  }

  // Filter by search query
  if (query) {
    constraints = queryConstraintsLocal(constraints, query);
  }

  // Limit results if specified
  if (limit !== undefined && limit > 0) {
    constraints = constraints.slice(0, limit);
  }

  const sourceFiles = Array.from(new Set(constraints.map(c => c.sourceFile)));

  return NextResponse.json({
    success: true,
    query,
    returnedCount: constraints.length,
    sourceFilesCount: sourceFiles.length,
    constraints,
  });
})
