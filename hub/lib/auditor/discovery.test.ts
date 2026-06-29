import { describe, it, expect } from 'vitest';
import { 
  discoverApplicationFootprint, 
  stripComments, 
  extractMethods, 
  findRouteFiles 
} from './discovery';

describe('discoverApplicationFootprint', () => {
  it('scans the API routes correctly', () => {
    const footprint = discoverApplicationFootprint();
    expect(footprint.apiRoutes).toBeInstanceOf(Array);
    expect(footprint.apiRoutes.length).toBeGreaterThan(0);

    const discoverRoute = footprint.apiRoutes.find(r => r.path === '/api/auditor/discover');
    if (discoverRoute) {
      expect(discoverRoute.authType).toBe('nextauth');
    }
  });

  it('scans the DB schema correctly', () => {
    const footprint = discoverApplicationFootprint();
    expect(footprint.dbSchema).toBeInstanceOf(Array);
    expect(footprint.dbSchema.length).toBeGreaterThan(0);

    const tenantsTable = footprint.dbSchema.find(t => t.name === 'tenants');
    expect(tenantsTable).toBeDefined();
    expect(tenantsTable?.columns).toBeInstanceOf(Array);
    
    const idColumn = tenantsTable?.columns.find(c => c.name === 'id');
    expect(idColumn).toBeDefined();
    expect(idColumn?.type).toBe('text');
  });
});

describe('discovery helper - findRouteFiles', () => {
  it('handles non-existent directories gracefully without throwing', () => {
    expect(() => findRouteFiles('/non-existent-directory-path-12345')).not.toThrow();
    const results = findRouteFiles('/non-existent-directory-path-12345');
    expect(results).toEqual([]);
  });
});

describe('discovery helper - stripComments', () => {
  it('removes single line comments and multi-line comments but preserves URLs', () => {
    const testCode = `
      // This is a single line comment
      const url = "https://github.com/RxFit/hub-overlay"; // trailing comment
      /* Multi-line comment
         containing getServerSession */
      const key = "apiKey";
    `;
    const cleaned = stripComments(testCode);
    expect(cleaned).toContain('https://github.com/RxFit/hub-overlay');
    expect(cleaned).toContain('const key = "apiKey"');
    expect(cleaned).not.toContain('This is a single line comment');
    expect(cleaned).not.toContain('Multi-line comment');
    expect(cleaned).not.toContain('getServerSession'); // Since it was only in the comment
  });
});

describe('discovery helper - extractMethods', () => {
  it('extracts methods from function exports, arrow function variable exports, and named re-exports', () => {
    const testCode = `
      export async function GET(req: Request) {}
      export const POST = (req: Request) => {};
      export { handler as PUT, handler as DELETE };
      export { OPTIONS };
      const PATCH = () => {};
    `;
    const methods = extractMethods(testCode);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('OPTIONS');
    expect(methods).not.toContain('PATCH'); // Not exported
  });
});
