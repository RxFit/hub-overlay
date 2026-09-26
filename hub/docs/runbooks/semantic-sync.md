# Semantic sync — Stripe + Gmail → Semantic Brain (Vertex AI Search)

The Hub indexes new Stripe activity and Gmail messages into Vertex AI Search
data stores in project `semantic-brain-desktop` (the Semantic Brain's
project). No new servers: it is one route on the existing `hub` Cloud Run
service, fired nightly by a GitHub Actions schedule.

> **These data stores must NOT be connected to the Hub chat engine**
> (`semanticbrain_1779229063037`, `VERTEX_ENGINE_ID`). The chat searches that
> engine with no data-store scoping and no per-role authorization, so every
> chat-enabled role — including the default `onboarding` role — would be able
> to retrieve mailbox bodies and billing records. The sync enforces this: every
> run reads the chat engine's connected data stores and **refuses to import**
> into one of them (and refuses when it cannot check). Surfacing these records
> in the Hub chat needs role-gated retrieval first — a separate change.

| Piece | Where |
|-------|-------|
| Route | `POST /api/cron/semantic-sync` (`x-cron-secret`) — `hub/app/api/cron/semantic-sync/route.ts` |
| Engine | `hub/lib/semantic-sync/` (module headers carry the contracts) |
| Trigger | `.github/workflows/semantic-sync.yml` — 07:13 UTC daily (02:13 Central, daylight time) |
| Status | `GET /api/admin/semantic-sync` (signed-in admin) |

> **Ships dark, deny by default.** A source with any required variable unset
> reports `not_configured` and nothing is fetched, written or imported for it.
> The nightly workflow only *warns* in that state. Nothing below is done by the
> PR that shipped this feature.

## What a run does

Per source (Stripe and Gmail run independently — one failing never stops the
other):

0. **Exposure guard**: if a data store is configured, confirm it is not
   connected to the chat engine (see the box above). Otherwise stop with
   `failure.stage: config` before reading or writing anything.
1. Read the cursor `<GCS URI>/<source>/_state.json`. The window is
   `cursor − 1h` → now (first run: the last 24h). A dropped nightly firing is
   caught up on the next one, up to 14 days back.
2. **Collect**, oldest first, at most `maxItems` (default 300):
   - **Stripe** — the `/v1/events` stream, so updates are seen, not just
     creations. One document per object (customer, charge, invoice,
     subscription, checkout session, refund) holding its latest snapshot.
   - **Gmail** — messages in the window, read as the configured mailbox via
     domain-wide delegation with the `gmail.readonly` scope. Drafts are
     excluded; promotions/social are excluded by default.
3. **Write** one HTML file per record to `<GCS URI>/<source>/docs/<id>.html`,
   then one JSONL manifest to `<GCS URI>/<source>/manifests/<timestamp>.jsonl`:

   ```json
   {"id":"gmail-18c5f…","structData":{"source":"gmail","from":"…","date":"…"},"content":{"mimeType":"text/html","uri":"gs://…/gmail/docs/gmail-18c5f….html"}}
   ```

   This is Vertex AI Search's *unstructured documents with metadata* format.
   HTML because the engine takes `<title>` as the result title, which is what
   the chat shows the model.
4. **Import**: `documents:import` of the manifest into the source's data store,
   `reconciliationMode: INCREMENTAL` (same id = replaced, nothing deleted).
   **Uploading to GCS alone does not update search** — the import is what does.
5. **Advance the cursor** — last, so any earlier failure leaves it in place and
   the next run re-covers the same window (every write is idempotent).

The import finishes asynchronously, after the cursor has already moved past
its records — so every started import is kept in the cursor file's `imports`
queue until it **succeeds**. Each run checks every queued operation and reports
it in `previousImports`:

| Report | Meaning |
|--------|---------|
| `running` | still importing; stays queued |
| `succeeded` | no rejected documents; leaves the queue |
| `retrying` | failed, or finished with some documents rejected — its manifests are re-imported with this run's import (INCREMENTAL, so re-importing is harmless) |
| `unknown` | the operation could not be read; stays queued, and after 3 runs in a row is treated as failed and retried |
| `abandoned` | a manifest failed 3 import attempts — recorded in `abandoned`, and the run reports `failed` (the workflow fails) even though its own new records landed |

## Owner setup

Do these in order. `GET /api/admin/semantic-sync` shows, per source, exactly
which variables are still missing, plus the service account's email and the
**client id** step 4 asks for.

### 1. Buckets

One GCS location per source, e.g. the existing `gs://sb-…` buckets. A prefix is
fine (`gs://sb-stripe/hub`); the sync writes under `<uri>/<source>/…` so both
sources may even share one bucket. Keeping the buckets in
`semantic-brain-desktop` (the project that owns the data stores) is simplest.

### 2. Data stores

Each source imports into a **dedicated** Vertex AI Search data store of type
**Cloud Storage → unstructured documents with metadata (JSONL)**, in
`semantic-brain-desktop`, location `global`.

- **Do not connect it to the `semanticbrain_1779229063037` app** — the sync
  refuses to import into any data store that is (see the box at the top). To
  search it from the Vertex console or other Vertex tooling, connect it to a
  separate app instead.
- The June investigation recorded existing `email` and `stripe` data stores.
  **If those are connected to `semanticbrain_1779229063037`, their contents are
  already searchable by every chat-enabled Hub role today**, independent of
  this sync — check the app's connected data stores in the AI Applications
  console and disconnect them unless that exposure is intended. They also
  cannot be targets for this sync while connected.
- Leaving `SEMANTIC_SYNC_<SOURCE>_DATA_STORE` unset is allowed: objects are
  still written, the import is skipped, and the workflow warns every night.
- `GET /api/admin/semantic-sync` reports `dataStoreChatVisible` per source:
  `true` means the sync will refuse to run; `null` means the engine could not
  be read (the sync also refuses).

### 3. IAM for the service account

The sync authenticates as the service account in `GOOGLE_SERVICE_ACCOUNT_KEY`
(Secret Manager `hub-google-sa-key`) — the same identity that already queries
the Semantic Brain, not the Cloud Run runtime identity. Grant it:

| Where | Role | Why |
|-------|------|-----|
| each sync bucket | `roles/storage.objectUser` | create **and overwrite** objects, read the cursor (`objectCreator` cannot overwrite) |
| project `semantic-brain-desktop` | `roles/discoveryengine.editor` | `documents:import`, reading its operation, and reading the chat engine's connected data stores (the exposure guard) |

The import reads the manifest and content files as the **Discovery Engine
service agent** (`service-962367132064@gcp-sa-discoveryengine.iam.gserviceaccount.com`),
not as the Hub. If an import fails with a permission error on `gs://…`
(always the case for a bucket in another project), grant that agent
`roles/storage.objectViewer` on the bucket.

### 4. Domain-wide delegation (Gmail only)

1. Enable the **Gmail API** in the project that owns the service account.
2. Google Admin console → Security → Access and data control → API controls →
   **Manage domain-wide delegation** → Add new:
   - Client ID: `serviceAccount.delegationClientId` from
     `GET /api/admin/semantic-sync` (the key's numeric `client_id`)
   - OAuth scopes: `https://www.googleapis.com/auth/gmail.readonly`

**Security note:** this grant lets whoever holds the key read *any* mailbox in
the Workspace domain, read-only. The Hub only ever impersonates
`SEMANTIC_SYNC_GMAIL_SUBJECT`, but the key becomes as sensitive as that mail:
keep it only in Secret Manager, and rotate it (and re-enter the new client id if
the service account changes) if it may have leaked. A dedicated service
account just for this sync would narrow the blast radius.

No refresh token is involved, so nothing expires: the grant holds until an
admin removes it.

### 5. Environment variables on the `hub` service

| Env var | Required | Example | Notes |
|---------|----------|---------|-------|
| `SEMANTIC_SYNC_STRIPE_GCS_URI` | Stripe | `gs://sb-stripe/hub` | |
| `SEMANTIC_SYNC_STRIPE_DATA_STORE` | optional | `sb-stripe-docs` | bare id (expanded under `VERTEX_GCP_PROJECT`) or full resource path |
| `STRIPE_SECRET_KEY` | Stripe | secret | already used by the KPI source; a restricted key needs **Events: read** and **Customers: read** |
| `SEMANTIC_SYNC_GMAIL_GCS_URI` | Gmail | `gs://sb-email/hub` | |
| `SEMANTIC_SYNC_GMAIL_DATA_STORE` | optional | `sb-email-docs` | |
| `SEMANTIC_SYNC_GMAIL_SUBJECT` | Gmail | `danny@rxfitatx.com` | the mailbox to read |
| `SEMANTIC_SYNC_GMAIL_QUERY` | optional | `-category:promotions -category:social` (default) | any Gmail search; set to empty to index everything |

The non-secret ones can be set immediately — `--update-env-vars` merges, so
later deploys keep them:

```bash
gcloud run services update hub --region us-central1 --project rxfit-automation \
  --update-env-vars="SEMANTIC_SYNC_STRIPE_GCS_URI=gs://…,SEMANTIC_SYNC_GMAIL_GCS_URI=gs://…,SEMANTIC_SYNC_GMAIL_SUBJECT=danny@rxfitatx.com"
```

Then add them to `ENV_VARS` in `.github/workflows/deploy.yml` in a follow-up PR
so the configuration lives in git. If `STRIPE_SECRET_KEY` is not yet bound on
the service, bind it from Secret Manager like the other `hub-*` secrets
(`valueFrom.secretKeyRef`).

### 6. Verify

1. `GET /api/admin/semantic-sync` — every source `ready: true`.
2. Actions → **Nightly semantic sync** → Run workflow with **dryRun** checked:
   lists and renders, writes nothing. Each source should report `dry_run` with
   a document count.
3. Run it again without dryRun. Each source reports `synced` (or `noop`) and
   `import.status: started`.
4. The next run shows `previousImports[].status: succeeded`, and the data
   store's Activity tab in the AI Applications console shows the imported
   documents. (`/api/admin/semantic-brain-health` will NOT find them — it
   searches the chat engine, which these data stores are deliberately not
   connected to.)

## Backfill

Actions → Nightly semantic sync → Run workflow with `lookbackHours` (max 720).
It ignores the cursor for that run, then leaves the cursor where the run ended.
Stripe keeps events for 30 days, so that is as far back as Stripe goes. A large
window may stop at `maxItems` (`truncated: true`); the nightly run continues
from there automatically.

## Failure classes

The route answers **502** when any source failed, with `failure.stage` and the
upstream's own message; the workflow run fails and GitHub emails.

| Stage | Typical message | Fix |
|-------|-----------------|-----|
| `auth` | `unauthorized_client` | Delegation missing or scope mismatch (step 4) — the scope must be exactly `…/auth/gmail.readonly` |
| `auth` | `invalid_grant` / `unconfigured` | `GOOGLE_SERVICE_ACCOUNT_KEY` unset, deleted or disabled |
| `config` | `connected to the Hub chat engine` | The data store is connected to `semanticbrain_1779229063037`. Disconnect it, or point the variable at a dedicated data store (step 2) |
| `config` | `could not verify … refusing to import` | The chat engine could not be read — usually a missing `roles/discoveryengine.editor` (step 3), or a wrong `VERTEX_ENGINE_ID` |
| `collect` | Gmail 403 `…has not been used…` | Enable the Gmail API (step 4.1) |
| `collect` | Stripe 401 / 403 | `STRIPE_SECRET_KEY` invalid, or a restricted key lacking Events: read |
| `collect` | `window holds more than 5000` | Rerun with a smaller `lookbackHours` |
| `state` / `upload` | GCS 403 `storage.objects.create` / `delete` | `roles/storage.objectUser` on the bucket (step 3) |
| `state` | `_state.json is not valid JSON` | Delete that object; the next run starts over with a 24h window (backfill with `lookbackHours` if needed) |
| any | `run deadline reached during …` | The run hit its 240s budget; the cursor did not move and the next run retries (already-written objects are simply overwritten). Dispatch with a smaller `maxItems` to finish sooner |
| `import` | 403 `discoveryengine.documents.import` | `roles/discoveryengine.editor` (step 3) |
| `import` | 404 / 400 | Wrong data-store id, or not in `semantic-brain-desktop`/`global` |
| `previousImports` retrying | `unsupported` / schema errors | Data store is structured, not unstructured-with-metadata (step 2) |
| `previousImports` retrying | permission denied reading `gs://…` | Discovery Engine service agent cannot read the bucket (step 3) |
| `import` | `manifest(s) … abandoned` | See "Import failures" below |

## Import failures

`previousImports` is how an asynchronous failure surfaces. A failed or
partially rejected import is retried automatically (per manifest, up to three
attempts); `errors` carries Google's per-document messages. A manifest that
fails a third time is **abandoned**: the run fails loudly once, and the
manifest URI is kept in the cursor file's `abandoned` list (visible through
`GET /api/admin/semantic-sync`). Those records are in GCS but not in the
index. Fix the cause, then either run a `lookbackHours` backfill covering the
affected days, or re-import the listed manifests by hand
(`documents:import` with `reconciliationMode: INCREMENTAL`).

## What is and is not indexed

- **Stripe:** names, emails, amounts, statuses, dates, line-item descriptions,
  metadata. Never card or payment-method details, and never hosted invoice or
  receipt URLs (bearer links).
- **Gmail:** subject, participants, date, labels, attachment *filenames*, and
  the body with quoted reply history removed (capped at 20,000 characters).
  Attachment contents are never fetched.
- **Not propagated:** deletions. A deleted email stays indexed; a deleted
  Stripe customer is re-indexed as "(deleted)". Remove documents by hand in the
  data store if needed.
- Synced email is **untrusted content**. Should it ever be surfaced to the
  chat (through role-gated retrieval), treat it like any other retrieved
  document: evidence, never instructions.
