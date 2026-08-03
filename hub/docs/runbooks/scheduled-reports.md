---
title: Runbook — Turning on scheduled reports
created: 2026-07-30
tags: [runbook, reports, cron, cloud-scheduler]
related: ["[[../architecture/GOOGLE_WORKSPACE_LEVERAGE_DESIGN_2026-07-28]]"]
---

# Runbook — Turning on scheduled reports

Scheduled digests are **fully implemented and completely inert** until a Cloud
Scheduler job calls them. Everything else is done: the schedule engine, the
digest and deck builders, email/Chat delivery, and the Settings editor. This
runbook is the one manual step.

## What you are wiring

`POST /api/reports/run` is fired **hourly**. Each firing asks every configured
report *"are you due in this hour, in the tenant's timezone?"* and generates only
those. Reports are configured in **Settings → Scheduled Reports**; with nothing
saved, a tenant runs the seeded defaults (weekly digest Mon 07:00, monthly review
deck on the 1st at 07:00, both emailed to admins).

Hourly is deliberate — see `lib/reports/config.ts`. It keeps cadence as editable
data rather than infrastructure the app would have to reprovision every time
someone changed a dropdown.

## Prerequisite: CRON_SECRET

The route is guarded by the same constant-time `x-cron-secret` check as
`/api/kpis/sync`, reading `process.env.CRON_SECRET`. It answers **503** if the
variable is unset, so it fails loudly rather than running unguarded.

Confirm the deployed service has it:

```bash
gcloud run services describe hub \
  --project=rxfit-automation --region=us-central1 \
  --format='value(spec.template.spec.containers[0].env[].name)' | tr ',' '\n' | grep -i cron
```

Nothing returned means it is either absent or injected as a *secret* rather than
a plain env var — check `--set-secrets` on the service too. Whatever value
`/api/kpis/sync` already uses is the value to reuse; the two routes read the
same variable.

## Create the job

```bash
gcloud scheduler jobs create http hub-reports-run \
  --project=rxfit-automation \
  --location=us-central1 \
  --schedule="0 * * * *" \
  --time-zone="Etc/UTC" \
  --uri="https://hub.casatrejo.com/api/reports/run" \
  --http-method=POST \
  --headers="x-cron-secret=THE_SECRET_VALUE" \
  --attempt-deadline=300s \
  --description="Hourly: generate any scheduled Hub reports that are due"
```

Notes:

- **`0 * * * *` in UTC is correct and does not need adjusting for your
  timezone.** The job only *asks*; the app decides due-ness in the tenant's
  timezone. Firing on the hour in UTC covers every local hour.
- `--attempt-deadline=300s` because one firing may build several reports, each
  making multiple Google calls. The default (180s) can cut a monthly deck short.
- The header carries a secret, so this command lands in your shell history —
  clear it, or use `--headers-from-file`.

## Verify

Run it once by hand rather than waiting for the hour:

```bash
gcloud scheduler jobs run hub-reports-run \
  --project=rxfit-automation --location=us-central1

gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name=hub AND textPayload:"[reports]"' \
  --project=rxfit-automation --freshness=10m --limit=50
```

A successful call returns `{"ok":true,"ran":N,"results":[…]}`.

## Reading the responses

| Response | Meaning | Action |
|---|---|---|
| `{"ok":true,"ran":0}` | Nothing was due in this hour | Normal. Most firings look like this. |
| `503 CRON_SECRET is not configured` | Env var missing on the service | See the prerequisite above. |
| `401 Unauthorized` | Header value does not match `CRON_SECRET` | Re-check the value; it is compared in constant time, so there is no partial-match hint. |
| `409 No usable Google credential for this tenant` | No admin has a stored refresh token that mints | An admin must sign in through the deliberate sign-in button at least once. |
| `results[].status: "created"` with a `reason` | Report generated, delivery partly failed | The Doc/deck exists in Drive; the reason names the delivery problem. |
| `results[].status: "failed"` | That report failed; others in the hour still ran | The reason carries the upstream error. |

A digest whose data sections read "Google Analytics data unavailable" means the
run authenticated but the analytics call failed — usually no property chosen
(**Settings → Analytics Sources**) or the credential lacks `analytics.readonly`.

## Turning it off

```bash
gcloud scheduler jobs pause hub-reports-run \
  --project=rxfit-automation --location=us-central1
```

Pausing is preferable to deleting — it keeps the job's history. Individual
reports can also be disabled per-tenant in Settings without touching the job.
