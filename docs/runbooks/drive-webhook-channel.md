---
title: Runbook — Keeping the Drive webhook channel alive
created: 2026-08-07
tags: [runbook, webhooks, drive, semantic-brain, cron, cloud-scheduler]
related: ["[[scheduled-reports]]"]
---

# Runbook — Keeping the Drive webhook channel alive

The semantic index (pgvector `document_chunks`) is fed **exclusively** by Google
Drive push notifications to `POST /api/webhooks/google`. Google delivers those
only while a **notification channel** is alive — and channels expire on
Google's schedule, silently. When the original hand-registered channel lapsed,
the index simply stopped updating: no error, no log, search just went stale.

The app now manages the channel itself via `POST /api/webhooks/google/renew`:

- **No channel stored** → registers a `changes.watch` channel starting from
  "now" and records it in the `webhook_channels` table.
- **Channel expiring within 6 hours (or already expired)** → registers a
  replacement, **keeping the stored changes cursor** (so the gap while dead is
  backfilled), then stops the old channel best-effort.
- **Healthy** → no-op.

The webhook route understands the resulting notifications: a changes-channel
ping triggers a `changes.list` from the stored cursor, ingesting
added/updated files and deleting chunks for removed/trashed ones. Legacy
per-file channels keep working unchanged.

## The one manual step: the Cloud Scheduler job

Same pattern as scheduled reports (see [[scheduled-reports]]) — the code is
inert until something calls it. Fire it **hourly**:

```bash
gcloud scheduler jobs create http hub-webhook-renew \
  --project=rxfit-automation --location=us-central1 \
  --schedule="17 * * * *" \
  --uri="https://<hub-domain>/api/webhooks/google/renew" \
  --http-method=POST \
  --headers="x-cron-secret=<CRON_SECRET value>" \
  --attempt-deadline=120s
```

Minute 17 (vs the reports job) just spreads the load; any minute works.
Renewal requests a 7-day TTL and stores whatever Google actually grants, so
the hourly cadence is safe regardless of how aggressively Google clamps.

## Prerequisites (all already required by the webhook itself)

| Env var | Why the renewal needs it |
| --- | --- |
| `CRON_SECRET` | Guards the endpoint (constant-time check; 503 when unset). |
| `GOOGLE_WEBHOOK_CHANNEL_TOKEN` | Set as the channel's token; the webhook route rejects notifications without it. |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | The channel watches what the service account can see — the same identity that ingests content. |
| `NEXTAUTH_URL` | Becomes the channel's delivery address (`<NEXTAUTH_URL>/api/webhooks/google`). Must be `https://`. |

Also required once per Google Workspace: the webhook **domain must be
verified** for push notifications (Search Console → domain property covering
the hub's domain). If `changes.watch` answers
`webhook_url_not_allowed`/`push.webhookUrlUnauthorized`, that verification is
what's missing.

## Verifying it works

```bash
# Fire a renewal by hand:
curl -s -X POST -H "x-cron-secret: $CRON_SECRET" \
  https://<hub-domain>/api/webhooks/google/renew | jq
# → { "ok": true, "status": "bootstrapped" | "renewed" | "healthy", "expiration": ... }
```

Admins can also `GET /api/webhooks/google/renew` (session auth) for the live
channel state: expiration, time remaining, and whether a changes cursor is
stored. It answers **503 when the channel is missing or expired**, so an
uptime check can watch it directly — the exact "it expired silently" failure
this runbook exists to end.

Then edit any Google Doc the service account can see and check the logs for
`[Google Webhook] Processing N Drive change(s)` followed by
`Successfully indexed document …`.

## Failure modes

- **`status: 503, "CRON_SECRET is not configured"`** — env var missing on the
  service; the job is firing but the route refuses to run unguarded.
- **Cursor rejected (`InvalidPageTokenError` in logs)** — the channel was dead
  so long that Drive can no longer serve the stored cursor. The route resets
  to a fresh cursor automatically; documents changed during the outage
  re-index on their next edit. A bulk re-ingest is the manual remedy if that
  matters.
- **Duplicate notifications after a renewal** — expected briefly: the old
  channel is stopped best-effort *after* its replacement is live. Processing
  is coalesced and cursor-based, so duplicates cost a little work, never
  duplicate chunks.
