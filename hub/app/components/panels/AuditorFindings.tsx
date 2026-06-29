'use client'

import { useState } from 'react';
import type { AuditFinding } from '@/lib/auditor/core';

interface AuditorFindingsProps {
  findings: AuditFinding[];
}

export default function AuditorFindings({ findings = [] }: AuditorFindingsProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedSeverity, setSelectedSeverity] = useState<string>('all');

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  };

  const getBasename = (filePath: string) => {
    return filePath.split(/[/\\]/).pop() || filePath;
  };

  const filteredFindings = findings.filter(finding => {
    const matchesSearch =
      (finding.element || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (finding.message || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (finding.ckbReference || '').toLowerCase().includes(searchTerm.toLowerCase());

    const matchesType =
      selectedType === 'all' ||
      finding.type === selectedType;

    const matchesSeverity =
      selectedSeverity === 'all' ||
      finding.severity === selectedSeverity;

    return matchesSearch && matchesType && matchesSeverity;
  });

  const types = ['all', 'violation', 'deviation', 'undocumented', 'gap'];
  const severities = ['all', 'critical', 'major', 'minor'];

  return (
    <div className="auditor-panel" style={{ marginTop: 'var(--space-6)' }}>
      <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: 'var(--space-4)', color: 'var(--text-primary)', fontFamily: 'var(--font-heading)' }}>
        Audit Findings ({filteredFindings.length})
      </h3>

      {/* Filters & Search */}
      <div className="filters-bar">
        {/* Search */}
        <div className="search-container">
          <input
            type="text"
            className="search-input"
            placeholder="Search findings by element, message, or reference..."
            value={searchTerm}
            onChange={handleSearchChange}
            aria-label="Search findings"
          />
        </div>

        {/* Filter Type */}
        <div className="filter-group">
          <span className="filter-label">Filter by Type</span>
          <div className="filter-tabs">
            {types.map(t => (
              <button
                key={t}
                onClick={() => setSelectedType(t)}
                className={`filter-tab ${selectedType === t ? 'active' : ''}`}
                aria-pressed={selectedType === t}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Filter Severity */}
        <div className="filter-group">
          <span className="filter-label">Filter by Severity</span>
          <div className="filter-tabs">
            {severities.map(s => (
              <button
                key={s}
                onClick={() => setSelectedSeverity(s)}
                className={`filter-tab ${selectedSeverity === s ? 'active' : ''}`}
                aria-pressed={selectedSeverity === s}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Findings list */}
      <div className="findings-container">
        {filteredFindings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-6)', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            No matching findings found.
          </div>
        ) : (
          filteredFindings.map((finding) => (
            <div key={finding.id} className="finding-card">
              <div className="finding-header">
                <span className="finding-element">{finding.element}</span>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <span className="badge badge-type">{finding.type}</span>
                  <span className={`badge badge-${finding.severity}`}>{finding.severity}</span>
                </div>
              </div>
              <p className="finding-message">{finding.message}</p>
              
              <div className="finding-meta">
                {finding.ckbReference && (
                  <span>
                    Ref: <code style={{ color: 'var(--text-secondary)' }}>{finding.ckbReference}</code>
                  </span>
                )}
                
                {finding.sourceFile && (
                  <>
                    <span>•</span>
                    <span>
                      Source:{' '}
                      <a
                        href={`file:///C:/AntigravityHQ/chats/hub-paperclip/${finding.sourceFile}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--accent-bright)', textDecoration: 'underline' }}
                        title={`Open C:/AntigravityHQ/chats/hub-paperclip/${finding.sourceFile}`}
                      >
                        {getBasename(finding.sourceFile)}
                      </a>
                    </span>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
