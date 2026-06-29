import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { discoverApplicationFootprint, ApplicationFootprint } from './discovery';
import { loadAllConstraints, SystemConstraint } from './context';
import { saveToolArtifact } from '../tool-artifacts';
import { getTenantId } from '../tenant-context';

export interface AuditFinding {
  id: string;
  type: 'violation' | 'deviation' | 'undocumented' | 'gap';
  severity: 'critical' | 'major' | 'minor';
  element: string;
  message: string;
  ckbReference?: string;
}

/**
 * Parses constraints to extract table and column requirements.
 * Matches patterns like "the `kpis` table must contain a `trend` column"
 * or "table `kpis` must have a `trend` column".
 */
export function matchTableAndColumnRequirement(intent: string): { tableName: string; columnName: string } | null {
  const patterns = [
    /(?:the\s+)?[`"']?(\w+)[`"']?\s+table\s+(?:must\s+)?(?:contain|have|include)\s+(?:a\s+)?[`"']?(\w+)[`"']?\s+column/i,
    /table\s+[`"']?(\w+)[`"']?\s+(?:must\s+)?(?:contain|have|include)\s+(?:a\s+)?[`"']?(\w+)[`"']?\s+column/i,
    /column\s+[`"']?(\w+)[`"']?\s+in\s+(?:table\s+)?[`"']?(\w+)[`"']?/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(intent);
    if (match) {
      if (pattern.source.startsWith('column')) {
        return { tableName: match[2], columnName: match[1] };
      }
      return { tableName: match[1], columnName: match[2] };
    }
  }
  return null;
}

export function isRouteDeclaredPublic(routePath: string, constraints: SystemConstraint[]): SystemConstraint | undefined {
  const pathLower = routePath.toLowerCase();
  const cleanPath = pathLower.replace(/^\/api\//, '');
  return constraints.find(c => {
    const intentLower = c.intent.toLowerCase();
    const mentionsRoute = intentLower.includes(pathLower) || c.id.toLowerCase().includes(pathLower) || intentLower.includes(cleanPath);
    const mentionsPublic = 
      intentLower.includes('public') || 
      intentLower.includes('allow') || 
      intentLower.includes('no auth') || 
      intentLower.includes('unauthenticated') || 
      intentLower.includes('anonymous') || 
      intentLower.includes('guest') ||
      intentLower.includes('bypass');
    return mentionsRoute && mentionsPublic;
  });
}


/**
 * Safe helper to parse JSON response from Gemini.
 */
function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '');
    cleaned = cleaned.replace(/\n```$/, '');
  }
  return cleaned.trim();
}

/**
 * Runs a comparison audit comparing actual application footprint against system constraints.
 */
export async function runComparisonAudit(vaultPath?: string): Promise<AuditFinding[]> {
  const footprint = discoverApplicationFootprint();
  const constraints = await loadAllConstraints(vaultPath);

  const findings: AuditFinding[] = [];

  // --- 1. Deterministic Rule: API Route Authentication ---
  // If route path has authType === 'none' and is not /api/auth, check if there's any constraint marking it public.
  for (const route of footprint.apiRoutes) {
    const isAuthPath = route.path.startsWith('/api/auth') || route.path === '/api/auth';
    if (route.authType === 'none' && !isAuthPath) {
      const publicConstraint = isRouteDeclaredPublic(route.path, constraints);
      if (!publicConstraint) {
        findings.push({
          id: `det-api-auth-${route.path}-${route.method}`.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
          type: 'violation',
          severity: 'critical',
          element: route.path,
          message: 'Route has no authentication',
        });
      }
    }
  }

  // --- 2. Deterministic Rule: DB Schema Tenant Isolation ---
  // Any table (excluding the metadata tenants table) that does not have tenant_id or tenantId should be flagged.
  for (const table of footprint.dbSchema) {
    if (table.name.toLowerCase() === 'tenants') {
      continue;
    }
    const hasTenantCol = table.columns.some(col => {
      const nameLower = col.name.toLowerCase();
      return nameLower === 'tenantid' || nameLower === 'tenant_id';
    });
    if (!hasTenantCol) {
      findings.push({
        id: `det-db-tenant-${table.name}`.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
        type: 'violation',
        severity: 'critical',
        element: table.name,
        message: 'Table is missing tenant_id column for multi-tenant data isolation',
      });
    }
  }

  // --- 3. Deterministic Rule: Table/Column constraints ---
  // E.g. "the kpis table must contain a trend column"
  for (const constraint of constraints) {
    const req = matchTableAndColumnRequirement(constraint.intent);
    if (req) {
      const { tableName, columnName } = req;
      const table = footprint.dbSchema.find(t => t.name.toLowerCase() === tableName.toLowerCase());
      if (!table) {
        findings.push({
          id: `det-db-missing-table-${constraint.id}`.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
          type: 'violation',
          severity: constraint.severity === 'critical' ? 'critical' : 'major',
          element: tableName,
          message: `Table ${tableName} is missing, required by constraint: "${constraint.intent}"`,
          ckbReference: constraint.id,
        });
      } else {
        const column = table.columns.find(c => c.name.toLowerCase() === columnName.toLowerCase());
        if (!column) {
          findings.push({
            id: `det-db-missing-column-${constraint.id}`.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
            type: 'violation',
            severity: constraint.severity === 'critical' ? 'critical' : 'major',
            element: `${tableName}.${columnName}`,
            message: `Column ${columnName} is missing in table ${tableName}, required by constraint: "${constraint.intent}"`,
            ckbReference: constraint.id,
          });
        }
      }
    }
  }

  // --- 4. Gemini Semantic Audit Helper ---
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (geminiKey) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.ARRAY,
            description: 'List of audit findings',
            items: {
              type: SchemaType.OBJECT,
              properties: {
                id: { type: SchemaType.STRING },
                type: { type: SchemaType.STRING },
                severity: { type: SchemaType.STRING },
                element: { type: SchemaType.STRING },
                message: { type: SchemaType.STRING },
                ckbReference: { type: SchemaType.STRING },
              },
              required: ['id', 'type', 'severity', 'element', 'message'],
            },
          },
        },
      });

      const prompt = `You are a strict security and compliance auditor.
Analyze the system constraints and the actual discovered footprint of the application.

System Constraints:
${JSON.stringify(constraints, null, 2)}

Actual Footprint:
${JSON.stringify(footprint, null, 2)}

Look for:
1. Violations: Constraints that are actively violated by the footprint.
2. Deviations: Footprint elements that deviate slightly from architectural intents.
3. Undocumented endpoints/tables: API routes or DB tables that exist but are not mentioned in any constraints or context.
4. Gaps: Constraints that mandate certain tables, API routes, or features that are completely missing from the footprint.

Output a JSON array of AuditFinding objects. Each AuditFinding must have:
- id: a unique identifier for the finding (e.g., 'sem-violation-route-path')
- type: 'violation' | 'deviation' | 'undocumented' | 'gap'
- severity: 'critical' | 'major' | 'minor'
- element: the name of the route, table, or column containing the issue
- message: detail explaining the issue and why it is flagged
- ckbReference: optional ID of the related constraint if applicable
`;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      const cleaned = cleanJsonResponse(responseText);
      const semanticFindings = JSON.parse(cleaned) as AuditFinding[];

      const existingIds = new Set(findings.map(f => f.id.toLowerCase()));

      for (const semFinding of semanticFindings) {
        if (!semFinding.id || !semFinding.element || !semFinding.message) {
          continue;
        }

        const type = ['violation', 'deviation', 'undocumented', 'gap'].includes(semFinding.type) 
          ? semFinding.type 
          : 'deviation';
        const severity = ['critical', 'major', 'minor'].includes(semFinding.severity) 
          ? semFinding.severity 
          : 'minor';

        const normalized: AuditFinding = {
          id: semFinding.id,
          type,
          severity,
          element: semFinding.element,
          message: semFinding.message,
          ckbReference: semFinding.ckbReference,
        };

        const key = normalized.id.toLowerCase();
        if (!existingIds.has(key)) {
          findings.push(normalized);
          existingIds.add(key);
        }
      }
    } catch (err) {
      console.error('[auditor/core] Gemini semantic analysis failed:', err);
    }
  } else {
    console.warn('[auditor/core] Gemini API key not found. Skipping semantic analysis.');
  }

  return findings;
}

/**
 * Saves audit findings to database as a tool artifact.
 */
export async function saveAuditReport(findings: AuditFinding[]): Promise<any> {
  let tenantId = 'rxfit';
  try {
    tenantId = getTenantId();
  } catch {
    // default to fallback
  }

  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const title = `Zero-Tolerance Audit Report - ${dateStr}`;

  return await saveToolArtifact({
    tenantId,
    toolId: 'auditor',
    title,
    content: {
      findings,
      timestamp: new Date().toISOString(),
    },
    contextSummary: `Static analysis and semantic audit discovered ${findings.length} findings, with ${findings.filter(f => f.severity === 'critical').length} critical issues.`,
  });
}
