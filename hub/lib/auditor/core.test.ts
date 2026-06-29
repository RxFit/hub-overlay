import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverApplicationFootprint } from './discovery';
import { loadAllConstraints } from './context';
import { saveToolArtifact } from '../tool-artifacts';
import { runComparisonAudit, saveAuditReport, matchTableAndColumnRequirement, isRouteDeclaredPublic } from './core';

vi.mock('./discovery', () => ({
  discoverApplicationFootprint: vi.fn(),
}));

vi.mock('./context', () => ({
  loadAllConstraints: vi.fn(),
}));

vi.mock('../tool-artifacts', () => ({
  saveToolArtifact: vi.fn(),
}));

vi.mock('../tenant-context', () => ({
  getTenantId: vi.fn(() => 'rxfit'),
}));

const mockGenerateContent = vi.fn();
vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return {
          generateContent: mockGenerateContent,
        };
      }
    },
    SchemaType: {
      ARRAY: 'ARRAY',
      OBJECT: 'OBJECT',
      STRING: 'STRING',
      INTEGER: 'INTEGER',
      NUMBER: 'NUMBER',
      BOOLEAN: 'BOOLEAN',
    },
  };
});

describe('Zero-Tolerance Context Auditor Core', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-gemini-key';
  });

  describe('Helper - matchTableAndColumnRequirement', () => {
    it('matches table and column requirements correctly', () => {
      const intent1 = 'the `kpis` table must contain a `trend` column';
      const req1 = matchTableAndColumnRequirement(intent1);
      expect(req1).toEqual({ tableName: 'kpis', columnName: 'trend' });

      const intent2 = 'table kpis must have a trend column';
      const req2 = matchTableAndColumnRequirement(intent2);
      expect(req2).toEqual({ tableName: 'kpis', columnName: 'trend' });

      const intent3 = 'column trend in table kpis';
      const req3 = matchTableAndColumnRequirement(intent3);
      expect(req3).toEqual({ tableName: 'kpis', columnName: 'trend' });

      const intent4 = 'some random intent string';
      const req4 = matchTableAndColumnRequirement(intent4);
      expect(req4).toBeNull();
    });
  });

  describe('Helper - isRouteDeclaredPublic', () => {
    it('returns public constraint if one exists for route path', () => {
      const constraints = [
        {
          id: 'sc-1',
          sourceFile: 'file.md',
          category: 'security' as const,
          intent: 'Allow unauthenticated access to /api/public-route',
          severity: 'minor' as const,
        },
      ];

      const match = isRouteDeclaredPublic('/api/public-route', constraints);
      expect(match).toBeDefined();
      expect(match?.id).toBe('sc-1');

      const matchNone = isRouteDeclaredPublic('/api/secret-route', constraints);
      expect(matchNone).toBeUndefined();
    });
  });

  describe('runComparisonAudit', () => {
    it('should flag routes with authType "none" that do not have a public constraint', async () => {
      vi.mocked(discoverApplicationFootprint).mockReturnValue({
        apiRoutes: [
          { path: '/api/unprotected-route', method: 'GET', authType: 'none' },
          { path: '/api/auth/callback', method: 'GET', authType: 'none' }, // excluded
          { path: '/api/protected-route', method: 'POST', authType: 'nextauth' },
        ],
        dbSchema: [
          { name: 'users', columns: [{ name: 'tenant_id', type: 'text' }] }
        ],
      });

      vi.mocked(loadAllConstraints).mockResolvedValue([
        {
          id: 'sc-1',
          sourceFile: 'file.md',
          category: 'security',
          intent: 'Allow unprotected-route to be public',
          severity: 'minor',
        }
      ]);

      const oldKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      try {
        const findings = await runComparisonAudit();
        expect(findings).toEqual([]);
      } finally {
        process.env.GEMINI_API_KEY = oldKey;
      }
    });

    it('should flag unprotected routes if no matching constraint declares it public', async () => {
      vi.mocked(discoverApplicationFootprint).mockReturnValue({
        apiRoutes: [
          { path: '/api/sensitive-no-auth', method: 'POST', authType: 'none' },
        ],
        dbSchema: [
          { name: 'users', columns: [{ name: 'tenant_id', type: 'text' }] }
        ],
      });

      vi.mocked(loadAllConstraints).mockResolvedValue([]);

      const oldKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      try {
        const findings = await runComparisonAudit();
        expect(findings.length).toBe(1);
        expect(findings[0]).toEqual({
          id: 'det-api-auth--api-sensitive-no-auth-post',
          type: 'violation',
          severity: 'critical',
          element: '/api/sensitive-no-auth',
          message: 'Route has no authentication',
        });
      } finally {
        process.env.GEMINI_API_KEY = oldKey;
      }
    });

    it('should flag tables missing a tenant ID column', async () => {
      vi.mocked(discoverApplicationFootprint).mockReturnValue({
        apiRoutes: [],
        dbSchema: [
          { name: 'tenants', columns: [{ name: 'id', type: 'text' }] }, // excluded
          { name: 'safe_table', columns: [{ name: 'tenantId', type: 'text' }] },
          { name: 'isolated_table', columns: [{ name: 'tenant_id', type: 'text' }] },
          { name: 'leak_table', columns: [{ name: 'id', type: 'text' }] }, // missing
        ],
      });

      vi.mocked(loadAllConstraints).mockResolvedValue([]);

      const oldKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      try {
        const findings = await runComparisonAudit();
        expect(findings.length).toBe(1);
        expect(findings[0]).toEqual({
          id: 'det-db-tenant-leak_table',
          type: 'violation',
          severity: 'critical',
          element: 'leak_table',
          message: 'Table is missing tenant_id column for multi-tenant data isolation',
        });
      } finally {
        process.env.GEMINI_API_KEY = oldKey;
      }
    });

    it('should flag missing table or column required by a constraint', async () => {
      vi.mocked(discoverApplicationFootprint).mockReturnValue({
        apiRoutes: [],
        dbSchema: [
          {
            name: 'kpis',
            columns: [{ name: 'tenant_id', type: 'text' }, { name: 'id', type: 'text' }]
          }
        ],
      });

      vi.mocked(loadAllConstraints).mockResolvedValue([
        {
          id: 'sc-kpis-trend',
          sourceFile: 'file.md',
          category: 'database',
          intent: 'the `kpis` table must contain a `trend` column',
          severity: 'major',
        },
        {
          id: 'sc-missing-table',
          sourceFile: 'file.md',
          category: 'database',
          intent: 'the `logs` table must contain a `level` column',
          severity: 'critical',
        }
      ]);

      const oldKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      try {
        const findings = await runComparisonAudit();
        expect(findings).toContainEqual({
          id: 'det-db-missing-column-sc-kpis-trend',
          type: 'violation',
          severity: 'major',
          element: 'kpis.trend',
          message: 'Column trend is missing in table kpis, required by constraint: "the `kpis` table must contain a `trend` column"',
          ckbReference: 'sc-kpis-trend',
        });

        expect(findings).toContainEqual({
          id: 'det-db-missing-table-sc-missing-table',
          type: 'violation',
          severity: 'critical',
          element: 'logs',
          message: 'Table logs is missing, required by constraint: "the `logs` table must contain a `level` column"',
          ckbReference: 'sc-missing-table',
        });
      } finally {
        process.env.GEMINI_API_KEY = oldKey;
      }
    });

    it('should call Gemini and merge results safely with deduplication', async () => {
      vi.mocked(discoverApplicationFootprint).mockReturnValue({
        apiRoutes: [
          { path: '/api/unprotected', method: 'GET', authType: 'none' }
        ],
        dbSchema: [
          { name: 'users', columns: [{ name: 'tenant_id', type: 'text' }] }
        ],
      });

      vi.mocked(loadAllConstraints).mockResolvedValue([]);

      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify([
            {
              id: 'det-api-auth--api-unprotected-get',
              type: 'violation',
              severity: 'critical',
              element: '/api/unprotected',
              message: 'Duplicate route issue',
            },
            {
              id: 'sem-custom-finding',
              type: 'gap',
              severity: 'major',
              element: 'audit-log',
              message: 'Audit log is missing from constraints',
            }
          ])
        }
      });

      const findings = await runComparisonAudit();
      expect(findings.length).toBe(2);
      expect(findings.map(f => f.id)).toContain('det-api-auth--api-unprotected-get');
      expect(findings.map(f => f.id)).toContain('sem-custom-finding');
    });
  });

  describe('saveAuditReport', () => {
    it('should save findings as a tool artifact', async () => {
      const dummyFindings: any[] = [
        { id: '1', type: 'violation', severity: 'critical', element: 'table', message: 'msg' }
      ];

      await saveAuditReport(dummyFindings);

      expect(saveToolArtifact).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: 'rxfit',
        toolId: 'auditor',
        title: expect.stringContaining('Zero-Tolerance Audit Report'),
        content: expect.objectContaining({
          findings: dummyFindings,
        }),
      }));
    });
  });
});
