<#
.SYNOPSIS
    One-time migration runbook: Hub (Railway) -> Cloud Run + Cloud SQL.
    Run step by step (each step is idempotent); requires gcloud CLI + psql/pg_dump.

.NOTES
    Companion docs: CLOUDRUN_ENV_MIGRATION_PLAN.md, RAILWAY_TO_CLOUDRUN_MIGRATION_SCOPE.md
    NO credentials in this file — everything comes from env vars or prompts.
#>

param(
    [string]$Project = $env:GCP_PROJECT,
    [string]$Region  = "us-central1",
    [ValidateSet('apis','sql','secrets','build','deploy','domain','verify')]
    [Parameter(Mandatory = $true)][string]$Step
)

if (-not $Project) { Write-Error "Set GCP_PROJECT env var or pass -Project"; exit 1 }
gcloud config set project $Project | Out-Null

switch ($Step) {

  'apis' {
    # Enable required services (one-time)
    gcloud services enable run.googleapis.com cloudbuild.googleapis.com `
      artifactregistry.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com
    gcloud artifacts repositories create hub --repository-format=docker --location=$Region 2>$null
    Write-Host "APIs enabled, Artifact Registry repo 'hub' ready."
  }

  'sql' {
    # Cloud SQL Postgres 16 with pgvector. The Hub never had a DATABASE_URL on
    # Railway, so this is a fresh schema, not a data migration.
    gcloud sql instances create hub-pg --database-version=POSTGRES_16 `
      --tier=db-g1-small --region=$Region --storage-size=10
    gcloud sql databases create hub --instance=hub-pg
    Write-Host "Set a postgres user password:"
    gcloud sql users set-password postgres --instance=hub-pg --prompt-for-password
    Write-Host @"
NEXT (manual, via Cloud SQL Studio or psql):
  CREATE EXTENSION IF NOT EXISTS vector;
THEN from hub/ with DATABASE_URL pointing at this instance:
  npx drizzle-kit migrate
"@
  }

  'secrets' {
    # Create each secret interactively (paste value, Ctrl+Z/Enter on Windows to end).
    $names = @('NEXTAUTH_SECRET','GOOGLE_CLIENT_SECRET','GEMINI_API_KEY','EXA_API_KEY',
               'PAPERCLIP_API_KEY','PAPERCLIP_AUTH_PASSWORD','GOOGLE_SERVICE_ACCOUNT_KEY','DATABASE_URL')
    foreach ($n in $names) {
      Write-Host "Creating secret $n (paste value, then Enter + Ctrl+Z + Enter):"
      gcloud secrets create $n --data-file=- 2>$null
      if ($LASTEXITCODE -ne 0) { Write-Host "  $n exists - adding new version"; gcloud secrets versions add $n --data-file=- }
    }
  }

  'build' {
    Push-Location "$PSScriptRoot\..\hub"
    gcloud builds submit . --config=cloudbuild.yaml
    Pop-Location
  }

  'deploy' {
    # Attach runtime config (idempotent; rerun after changing values).
    gcloud run services update hub --region=$Region `
      --add-cloudsql-instances="${Project}:${Region}:hub-pg" `
      --set-secrets="NEXTAUTH_SECRET=NEXTAUTH_SECRET:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,EXA_API_KEY=EXA_API_KEY:latest,PAPERCLIP_API_KEY=PAPERCLIP_API_KEY:latest,PAPERCLIP_AUTH_PASSWORD=PAPERCLIP_AUTH_PASSWORD:latest,GOOGLE_SERVICE_ACCOUNT_KEY=GOOGLE_SERVICE_ACCOUNT_KEY:latest,DATABASE_URL=DATABASE_URL:latest" `
      --set-env-vars="NEXTAUTH_URL=https://hub.casatrejo.com,PAPERCLIP_BASE_URL=https://api.paperclip.casatrejo.com,PAPERCLIP_AUTH_EMAIL=danny@rxfitatx.com,SUPERADMIN_EMAILS=danny@rxfitatx.com,NEXT_PUBLIC_TENANT_ID=rxfit"
  }

  'domain' {
    gcloud beta run domain-mappings create --service=hub --domain=hub.casatrejo.com --region=$Region
    Write-Host "Update DNS for hub.casatrejo.com per the record shown above, then wait for cert provisioning."
  }

  'verify' {
    $url = gcloud run services describe hub --region=$Region --format="value(status.url)"
    Write-Host "Service URL: $url"
    Write-Host "Smoke tests: login, chat, 'create an issue', 'show agent status', feed populates, semantic search returns results."
  }
}
