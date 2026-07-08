# Cloud Logging query pack — AI-path telemetry

The AI path emits one structured JSON line per lifecycle event to stdout
(`lib/observability.ts`, NS-1). On Cloud Run, stdout is captured into Cloud
Logging as `jsonPayload`, so every query below works as-is in
**Logs Explorer** (Logging → Logs Explorer → paste into the query box).

Event stream (all correlated by `jsonPayload.requestId`):

| type                  | fields                                     | persisted to DB? |
|-----------------------|--------------------------------------------|------------------|
| `ai_request_start`    | `route`                                    | no |
| `ai_provider_selected`| `provider`, `model`, `attempt`             | no |
| `ai_first_token`      | `ms`                                       | no |
| `ai_complete`         | `ms`, `provider`, `model`, `finishReason`  | yes (`telemetry:ai_complete`) |
| `ai_timeout`          | `layer` (`connect`\|`idle`), `provider`, `model` | yes |
| `ai_fallback`         | `from`, `to`, `reason`                     | yes |
| `ai_error`            | `code`, `message`, `provider?`             | yes |

The persisted subset also lands in Postgres `event_log` (best-effort sink,
NS-10) and powers the in-app **/admin/ai-health** dashboard. Cloud Logging
remains the source of truth and the place for retention beyond 30 days
(`pruneOldEventLogs` trims the DB copy).

Replace `hub` below with the actual Cloud Run service name if it differs.

## Base filter

```text
resource.type="cloud_run_revision"
resource.labels.service_name="hub"
jsonPayload.type=~"^ai_"
```

## Fallback rate

Fallback events (numerator):

```text
resource.type="cloud_run_revision"
resource.labels.service_name="hub"
jsonPayload.type="ai_fallback"
```

Terminal requests (denominator — completes + errors):

```text
resource.type="cloud_run_revision"
resource.labels.service_name="hub"
jsonPayload.type=("ai_complete" OR "ai_error")
```

Run both over the same time range and divide the counts (Logs Explorer shows
the count in the histogram header). The in-app thresholds are: warn above
25%, critical above 50% (`lib/ai-health.ts` — `FALLBACK_WARN` /
`FALLBACK_CRIT`). To see WHY fallbacks happen, group by `jsonPayload.reason`.

## Timeout spike

```text
resource.type="cloud_run_revision"
resource.labels.service_name="hub"
jsonPayload.type="ai_timeout"
```

Break down by ladder layer / model with the Logs Explorer "group by" on
`jsonPayload.layer` and `jsonPayload.model`. In-app threshold: warn at
≥ 5 timeouts/hour (`TIMEOUTS_PER_HOUR_WARN`).

## Latency percentile approximation

Exact percentiles need a **log-based distribution metric** (below). For a
quick manual approximation, count slow completions and compare with the
total:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="hub"
jsonPayload.type="ai_complete"
jsonPayload.ms > 10000
```

If more than 5% of `ai_complete` lines match, p95 is worse than 10 s. Bisect
the threshold (5000, 20000, …) to bracket the percentile. First-token
latency works the same way with `jsonPayload.type="ai_first_token"`.

For a real p50/p95 chart: Logging → **Log-based metrics** → Create metric →
type **Distribution**, filter `jsonPayload.type="ai_complete"`, field name
`jsonPayload.ms`. The metric then appears in Metrics Explorer with built-in
percentile aligners (`ALIGN_PERCENTILE_95` etc.).

## Error-code breakdown

```text
resource.type="cloud_run_revision"
resource.labels.service_name="hub"
jsonPayload.type="ai_error"
```

Group by `jsonPayload.code` (e.g. `auth`, `overloaded`,
`ai_audit_write_failed`). `jsonPayload.message` is already PII-free by
contract — telemetry never carries message content, raw emails, or tokens.

## Wiring a log-based alert

1. Logging → **Log-based metrics** → **Create metric**.
   - Type: **Counter**; name e.g. `ai_fallback_count`.
   - Filter: the fallback query above (service + `jsonPayload.type="ai_fallback"`).
2. Monitoring → **Alerting** → **Create policy** → select the new metric.
   - Rolling window 1 h, aligner `sum`.
   - Condition: threshold, e.g. `> 5` fallbacks/hour (tune against the
     dashboard's observed baseline; the in-app warn fires at a 25% rate,
     which for the current single-tenant volume is roughly this order).
3. Add a notification channel (e-mail / Slack webhook) and save.

Repeat with the `ai_timeout` and `ai_error` filters for timeout-spike and
error-rate alerts (suggested starting thresholds: ≥ 5 timeouts/h, ≥ 10
errors/h). These cloud alerts complement — not replace — the in-app
`alerts[]` on `/admin/ai-health`, which evaluates the same conditions from
the persisted rows with no GCP dependency.
