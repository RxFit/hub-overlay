import { describe, it, expect } from 'vitest';
import { discoverApplicationFootprint } from './discovery';

describe('discoverApplicationFootprint', () => {
  it('scans the API routes correctly', () => {
    const footprint = discoverApplicationFootprint();
    expect(footprint.apiRoutes).toBeInstanceOf(Array);
    expect(footprint.apiRoutes.length).toBeGreaterThan(0);

    // Verify some expected fields on API Route
    const sampleRoute = footprint.apiRoutes[0];
    expect(sampleRoute).toHaveProperty('path');
    expect(sampleRoute).toHaveProperty('method');
    expect(sampleRoute).toHaveProperty('authType');
    
    // Check if it mapped the authType correctly
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
