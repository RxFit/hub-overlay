'use client'

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { getTenantConfig } from '@/lib/tenant';
import AuditorFindings from '@/app/components/panels/AuditorFindings';
import type { AuditFinding } from '@/lib/auditor/core';
import type { ApplicationFootprint } from '@/lib/auditor/discovery';
import './auditor.css';

const tenant = getTenantConfig();

export default function AuditorDashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const role = (session?.user as any)?.role as string;

  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [footprint, setFootprint] = useState<ApplicationFootprint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // Client-side access restriction
  useEffect(() => {
    if (status === 'authenticated' && role !== 'admin' && role !== 'superadmin') {
      router.replace('/');
    }
  }, [status, role, router]);

  const runAuditScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      // 1. Run audit compare scan
      const auditRes = await fetch('/api/auditor/audit', { method: 'POST' });
      if (!auditRes.ok) {
        throw new Error(`Failed to run audit: ${auditRes.statusText}`);
      }
      const auditData = await auditRes.json();
      if (auditData.success) {
        setFindings(auditData.findings || []);
      } else {
        throw new Error(auditData.error || 'Audit scan failed');
      }

      // 2. Discover footprint for stats
      const discoverRes = await fetch('/api/auditor/discover', { method: 'POST' });
      if (discoverRes.ok) {
        const discoverData = await discoverRes.json();
        setFootprint(discoverData);
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred during scanning');
    } finally {
      setScanning(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'authenticated' && (role === 'admin' || role === 'superadmin')) {
      runAuditScan();
    }
  }, [status, role, runAuditScan]);

  if (status === 'loading' || (loading && !scanning)) {
    return (
      <div className="admin-shell">
        <div className="admin-loading">
          <div className="admin-loading__spinner" />
          <span>Initial compliance scan in progress…</span>
        </div>
      </div>
    );
  }

  // Stats calculation
  const totalCriticals = findings.filter(f => f.severity === 'critical').length;
  const totalMajors = findings.filter(f => f.severity === 'major').length;
  const totalMinors = findings.filter(f => f.severity === 'minor').length;
  const totalGaps = findings.filter(f => f.type === 'gap').length;

  const totalCheckedRoutes = footprint?.apiRoutes?.length || 0;
  const totalCheckedTables = footprint?.dbSchema?.length || 0;
  const totalCheckedElements = totalCheckedRoutes + totalCheckedTables;

  // Compliance score calculation: base 100, deduction for findings based on severity
  // Critical = -20%, Major = -10%, Minor = -3%
  const calculatedScore = Math.max(
    0,
    100 - (totalCriticals * 20 + totalMajors * 10 + totalMinors * 3)
  );

  // SVG Dial variables
  const radius = 45;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (calculatedScore / 100) * circumference;

  return (
    <div className="admin-shell">
      {/* Header */}
      <header className="admin-header">
        <div className="admin-header__left">
          <button className="admin-back-btn" onClick={() => router.push('/admin')} aria-label="Back to Admin">
            ← Admin
          </button>
          <div className="admin-header__title">
            <span className="admin-header__accent">{tenant.logoText}</span>
            {' '}Zero-Tolerance Auditor
          </div>
        </div>
        <div className="admin-header__right">
          <span className="admin-role-badge" style={{ color: '#C5A059' }}>
            {role === 'superadmin' ? 'Super Admin' : 'Admin'}
          </span>
          <span className="admin-header__email">{session?.user?.email}</span>
        </div>
      </header>

      <main className="admin-main">
        {error && (
          <div className="admin-error" role="alert" style={{ marginBottom: 'var(--space-4)' }}>
            <span>⚠️ {error}</span>
            <button onClick={runAuditScan} className="admin-retry-btn">Retry</button>
          </div>
        )}

        {/* Top Control & Score Panel */}
        <div className="auditor-panel" style={{ marginBottom: 'var(--space-4)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-4)' }}>
            <div className="compliance-meter-container">
              {/* Circular Gauge */}
              <div className="compliance-dial">
                <svg>
                  <circle
                    cx="60"
                    cy="60"
                    r={radius}
                    className="compliance-dial-bg"
                  />
                  <circle
                    cx="60"
                    cy="60"
                    r={radius}
                    className="compliance-dial-progress"
                    style={{
                      strokeDasharray: circumference,
                      strokeDashoffset: strokeDashoffset,
                      stroke: calculatedScore > 80 ? 'hsl(152, 69%, 46%)' : calculatedScore > 50 ? 'hsl(38, 92%, 50%)' : 'hsl(0, 84%, 60%)'
                    }}
                  />
                </svg>
                <div className="compliance-dial-text">{calculatedScore}%</div>
              </div>
              
              <div>
                <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, margin: 0, color: 'var(--text-primary)', fontFamily: 'var(--font-heading)' }}>
                  Compliance Score
                </h2>
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  Based on active system constraints compared with application footprint.
                </p>
              </div>
            </div>

            {/* Run Scan Button */}
            <div>
              <button
                onClick={runAuditScan}
                disabled={scanning}
                className={`btn-scan ${scanning ? 'scanning' : ''}`}
                aria-label="Run auditor scan"
              >
                {scanning ? (
                  <>
                    <span className="spinner" />
                    <span>Scanning...</span>
                  </>
                ) : (
                  <span>Run Scan</span>
                )}
                <span className="scan-pulse" />
              </button>
            </div>
          </div>
        </div>

        {/* KPI Stats Grid */}
        <div className="kpi-grid">
          <div className="kpi-slot">
            <span className="kpi-title">Compliance Score</span>
            <span className="kpi-value" style={{ color: calculatedScore > 80 ? 'hsl(152, 69%, 46%)' : calculatedScore > 50 ? 'hsl(38, 92%, 50%)' : 'hsl(0, 84%, 60%)' }}>
              {calculatedScore}%
            </span>
          </div>
          <div className="kpi-slot">
            <span className="kpi-title">Total Criticals</span>
            <span className="kpi-value" style={{ color: totalCriticals > 0 ? 'hsl(348, 100%, 60%)' : 'var(--text-primary)' }}>
              {totalCriticals}
            </span>
          </div>
          <div className="kpi-slot">
            <span className="kpi-title">Total Gaps</span>
            <span className="kpi-value" style={{ color: totalGaps > 0 ? 'hsl(270, 100%, 60%)' : 'var(--text-primary)' }}>
              {totalGaps}
            </span>
          </div>
          <div className="kpi-slot">
            <span className="kpi-title">Checked Elements</span>
            <span className="kpi-value">
              {totalCheckedElements} <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 400 }}>({totalCheckedRoutes} R / {totalCheckedTables} T)</span>
            </span>
          </div>
        </div>

        {/* Auditor Findings Panel */}
        <AuditorFindings findings={findings} />
      </main>
    </div>
  );
}
