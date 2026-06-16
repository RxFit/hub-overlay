# Hub Overlay ↔ Paperclip Integration Audit — 2026-06-12

Scope: structural, technical, and functional issues in the hand-off infrastructure
between the Hub (AI Chat Interface, `hub/`) and Paperclip (paperclip.ing), both
directions. API contract verified against the live `@paperclipai/server` package
(npm `paperclipai` v2026.609.0) and the live Cloud Run instance health endpoint.

Verdict before fixes: **most of the Hub→Paperclip management surface was broken**,
and most of the Paperclip→Hub read path silently returned empty data. Every issue
below marked ✅ has been fixed in this pass.

---

## A. Hub → Paperclip (chat hand-offs / management)

### A1. ✅ CRITICAL — Proxy double-prefix broke ~13 chat intents
All client intent handlers called `/api/paperclip/api/companies/...`, while the
proxy (`hub/app/api/paperclip/[...path]/route.ts`) prepends `/api/` itself. Every
call built `/api/api/companies/...`, failed the allow-list, and returned
**403 "Forbidden path"**. Broken intents: check_agent_status, view_runs,
assign_issue, update_issue_state, create_agent, launch_campaign, restart_agent,
run_audit, delete_workspace, delete_agent, and the COO lookup in
send_communication (silently degraded to CEO routing).
**Fix:** proxy now strips a leading `api` segment (both URL styles work) and the
allow-list match is boundary-safe; all call sites in `page.tsx` normalized to
`/api/paperclip/companies/...`.

### A2. ✅ CRITICAL — Proxy dropped query strings
The proxy forwarded only path segments; `?limit=50`, `?status=...` never reached
Paperclip. **Fix:** `req.nextUrl.search` is appended to the upstream URL.

### A3. ✅ CRITICAL — Wrong endpoints for single-issue / single-agent operations
Paperclip has no company-scoped single-resource routes. The Hub called
`PATCH/GET /api/companies/:cid/issues/:id` and `PATCH/DELETE /api/companies/:cid/agents/:id`
— all 404s. Real routes: `/api/issues/:id`, `/api/agents/:id`.
**Fix:** `lib/paperclip.ts` (getIssue, updateIssue, getAgent, updateAgent,
deleteAgent) and `page.tsx` (assign_issue, update_issue_state, restart_agent,
delete_agent) repointed.

### A4. ✅ CRITICAL — `updateIssue` sent fields the API silently strips
It sent `{ state, assigneeId }`; Paperclip's PATCH schema accepts `{ status,
assigneeAgentId }` and strips unknown keys — updates returned 200 while changing
**nothing** (silent no-op, the worst failure mode).
**Fix:** vocabulary translation added (`state`→`status`, `assigneeId`→`assigneeAgentId`).

### A5. ✅ HIGH — Priority vocabulary mismatch
Hub used `urgent|high|medium|low|none`; Paperclip accepts `critical|high|medium|low`.
Creating an "urgent" issue → 400 validation error.
**Fix:** outbound map `urgent→critical`, `none→low`; inbound map `critical→urgent`.
`CreateIssueRequestSchema` accepts both vocabularies.

### A6. ✅ HIGH — Created-issue response misparsed → duplicate-issue risk
`POST /companies/:id/issues` returns the issue as a **bare object**; the Hub read
`res.issue` → `undefined` → "Action failed" shown to the user **after the issue
was actually created**, inviting retries and duplicates.
**Fix:** response unwrapping tolerates bare and wrapped shapes.

### A7. ✅ MEDIUM — `update_issue_state` couldn't reach all states
State map lacked `in_review`, `blocked`, `backlog`. **Fix:** full Paperclip status
vocabulary mapped.

## B. Paperclip → Hub (reverse path: feed, pulse, chat context)

### B1. ✅ CRITICAL — List responses misparsed → everything silently empty
Paperclip returns **bare arrays** from `/companies`, `/companies/:id/issues`,
`/companies/:id/agents`; the Hub read `data.issues ?? []` / `data.agents ?? []`
→ always `[]`. Result: chat system-prompt context, Execution Feed (`/api/feed`),
and CEO Pulse all operated on empty data without erroring.
**Fix:** `pickArray`/`pickItem` helpers in `lib/paperclip.ts` + `pickList` in
`page.tsx`; zod response schemas converted to bare|wrapped unions.

### B2. ✅ CRITICAL — Issue shape mismatch (`state.group` vs `status`)
The entire Hub reads Linear-style `issue.state.group/name`; Paperclip sends a flat
`status` string. Feed classification, pulse scoring, audits, and the "open issues"
counts all evaluated `undefined`.
**Fix:** boundary normalization derives `state {group,name}` from `status`
(`in_progress/in_review/blocked → started`, `done → completed`, etc.) so every
downstream consumer works unchanged; raw `status` is passed through.

### B3. ✅ CRITICAL — `/api/companies/:id/runs` does not exist
The endpoint the Hub used for run history (chat context, CEO Pulse scoring,
view_runs) isn't in Paperclip's API — runs are per-issue at `/api/issues/:id/runs`.
CEO Pulse therefore scored every department from 0 runs → permanently "DRIFTING".
**Fix:** `getRuns()` reimplemented as an aggregation over the company's recent
issues' runs (with field mapping `runId→id`, `finishedAt→completedAt`,
`succeeded→completed`, `timed_out→failed`, duration derived). New route
`GET /api/paperclip/runs?companyId=` exposes it to the client; `view_runs` uses it.

### B4. ✅ MEDIUM — Agent status vocabulary too narrow
Paperclip agents report `active|paused|idle|running|error|pending_approval|terminated`;
the Hub only understood `active|inactive|error`, so `running` agents rendered as
"unknown/⚪". **Fix:** normalization maps all 7 states onto the Hub's 3-state model;
status displays treat `running` as healthy.

### B5. ✅ MEDIUM — CEO Pulse "blockedTasks" counted ALL in-flight issues
It counted `state.group === 'started'`, inflating the blocked metric. **Fix:** now
counts issues whose Paperclip status is actually `blocked`.

### B6. (No webhooks — by design, noted) The reverse path is 100% polling
(feed/SWR 60s, pulse 5min, stall detector 5min). Paperclip supports plugin
webhooks; if you want push-based updates later, that's the hook point. No change made.

## C. Infrastructure / structural

### C1. ✅ HIGH — Railway Dockerfile health check hit a nonexistent path
`HEALTHCHECK ... http://localhost:3100/health` — Paperclip mounts health at
`/api/health` (the watchdog scripts already used the right path). The container
was permanently "unhealthy" to Railway. **Fix:** Dockerfile now probes `/api/health`.

### C2. ✅ HIGH — Split-brain: two Paperclip instances with conflicting docs
`AGENTS.md` documents the **local** instance (127.0.0.1:3100, HUB org, agent IDs
`a26e5555…`), while the Hub app talks to the **Cloud Run** RxFit org
(`hub/lib/paperclipConfig.ts`, different company/agent IDs), and
`railway/paperclip/` is a third deployment whose config still points
`publicBaseUrl` at the Cloud Run URL. Anyone following AGENTS.md would assign
issues to agents that don't exist on the instance the Hub uses.
**Fix:** AGENTS.md now carries an explicit two-instance warning block.
**Open decision (yours):** consolidate on one instance, or keep both and align
`railway/paperclip/config.json`'s `publicBaseUrl` with the Railway URL if that
deployment is meant to be live.

### C3. ⚠️ SECURITY — Secrets committed in the repo (NOT auto-fixed; needs rotation)
- `railway/paperclip/config.json` contains a **live Postgres connection string
  with password** (`postgres.railway.internal`). The entrypoint already injects
  `DATABASE_URL` from env — the literal credential in config.json should be
  removed and the password rotated in Railway.
- `scratch_paperclip/master.key` + `scratch_paperclip/instances/default/.env`
  are committed (the key appears to be a dummy, but the pattern is risky).
- `hub/.env.local.example` is clean (placeholders only). ✓

### C4. LOW — Misc
- `paperclip_logs.txt` is UTF-16-mangled (cosmetic, capture artifact).
- The proxy's earlier `startsWith` allow-list matched over-broadly
  (`/api/companiesX` would pass) — fixed as part of A1.
- `orchestration/paperclip-mcp/` is an empty directory (dead structure).
- OneDrive note: the sandbox sees stale/truncated copies of recently edited
  files in this folder; the files on disk are complete. If builds ever fail
  oddly out of this folder, suspect OneDrive sync hydration.

---

## Files changed
- `hub/lib/paperclip.ts` — contract normalization layer (shapes, vocab, endpoints, runs aggregation)
- `hub/lib/zod-schemas.ts` — schemas now validate the real wire format (bare|wrapped unions, both vocabularies)
- `hub/app/api/paperclip/[...path]/route.ts` — path normalization, boundary-safe allow-list, query-string forwarding
- `hub/app/api/paperclip/runs/route.ts` — **new** company-runs aggregation endpoint
- `hub/app/api/paperclip/ceo-pulse/route.ts` — blockedTasks now counts truly blocked issues
- `hub/app/page.tsx` — all 13 intent handlers: correct proxy paths, correct single-resource endpoints, bare/wrapped-tolerant parsing (`pickList`), status-aware open-issue checks, full state map
- `railway/paperclip/Dockerfile` — health check path
- `AGENTS.md` — two-instance warning

## Verification
- Contract cross-checked against `@paperclipai/server` 2026.609.0 route handlers
  and `@paperclipai/shared` validators (status/priority/agent-status enums,
  bare response shapes, route table).
- `lib/paperclip.ts` + `lib/zod-schemas.ts` pass `tsc --strict` (isolated check
  with stubbed infra modules; full-project check not possible in the sandbox —
  run `npm run build` in `hub/` to confirm end-to-end).
- Live Cloud Run instance confirmed reachable; `/api/health` returns
  `{"status":"ok","deploymentMode":"authenticated"}` (and `/health` does not exist,
  confirming C1).

## Recommended next steps
1. Rotate the Railway Postgres password; strip credentials from `railway/paperclip/config.json` (C3).
2. Decide the one-instance-or-two question (C2); align `railway/paperclip/config.json` `publicBaseUrl`/`allowedHostnames` accordingly.
3. Run `npm run build` in `hub/` and exercise one intent of each kind (create issue, reassign, change state, restart agent, view runs) against the live instance.
4. Pin the Paperclip version in the Railway Dockerfile (`pnpm add -g paperclipai@2026.609.0`) so the API contract can't drift under you silently.
