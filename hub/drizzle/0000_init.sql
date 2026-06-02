-- Hub DB Schema — run once against Railway Postgres
-- Tables: tenants, hub_users (replaces HUB_ROLES_SHEET_ID), kpis (replaces NEXT_PUBLIC_KPI_SHEET_ID)

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  domain      TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hub_users (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  email             TEXT NOT NULL,
  name              TEXT,
  role              TEXT NOT NULL DEFAULT 'onboarding',
  assigned_projects TEXT[] DEFAULT '{}',
  assigned_by       TEXT,
  assigned_at       TIMESTAMPTZ DEFAULT now(),
  last_login        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, email)
);

CREATE UNIQUE INDEX IF NOT EXISTS hub_users_email_tenant_uniq ON hub_users(tenant_id, email);

CREATE TABLE IF NOT EXISTS kpis (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  label           TEXT NOT NULL,
  value           TEXT NOT NULL DEFAULT '0',
  unit            TEXT,
  trend           TEXT,
  trend_direction TEXT DEFAULT 'neutral',
  source          TEXT DEFAULT 'manual',
  scope           TEXT DEFAULT 'global',
  company_id      TEXT,
  visibility      TEXT DEFAULT 'staff',
  updated_at      TIMESTAMPTZ DEFAULT now(),
  updated_by      TEXT
);

-- Seed the rxfit tenant
INSERT INTO tenants (id, name, domain)
VALUES ('rxfit', 'RxFit Athletics', 'rxfitatx.com')
ON CONFLICT (id) DO NOTHING;
