# Runbook — Paperclip live workspace cleanup (2026-07-19)

Ops record of the first live audit/cleanup of the production RXF Paperclip
instance, the incident it uncovered, the reversible remediation applied, and
the work still pending owner approval. Use this as the recovery reference if
agents need to be brought back online.

- **Instance:** `https://rxfit-paperclip-11747747730.us-central1.run.app`
  (Cloud Run; custom domain `api.paperclip.casatrejo.com` has a cert-name
  mismatch — use the `run.app` URL).
- **Companies (6):** RxFit Enterprise `829b2493-97ed-4cb9-8775-ff8298dcf650`
  (the only one the Hub uses), plus five leftover sibling orgs from the
  original `orchestration/` setup — Wellness App `130d9582…`, FridgeSnap
  `fe281b7a…`, Jade CoS `f6801930…`, NotebookRx `05ca9da4…`, SEO Agent
  `5021a3f7…`.

## How to authenticate (no secrets in repo)

The Hub signs in with a board email/password via
`POST /api/auth/sign-in/email` `{email, password}` and reuses the returned
`__Secure-paperclip-default.session_token` cookie (see
`hub/lib/paperclipSession.ts`). Board API keys and agent keys use
`Authorization: Bearer …`. Credentials live only in the deploy environment's
env vars (`PAPERCLIP_AUTH_EMAIL` / `PAPERCLIP_AUTH_PASSWORD` /
`PAPERCLIP_API_KEY`) — never commit them. `GET /api/health` should return
`{"status":"ok",…}`.

## Incident — every C-suite agent was failing

All C-suite agents across **all six** companies were in `error`. Every failed
heartbeat run reported the same reason:

> **`Process adapter missing command`**

Root cause: the agents were created with `gemini_cli` / `gemini_local`
**local-CLI adapters**, which require the Gemini CLI installed and
authenticated *on the Paperclip host*. The Cloud Run runtime has no such CLI,
so the adapter resolves to a bare `process` adapter with no `command` and
fails instantly on every wake. RxFit's CMO and CTO had heartbeats enabled and
were re-failing on a timer + retry, producing a steady stream of failed runs
(this is the "CMO failed after 1–3 minutes" symptom from the dashboard
screenshots).

## Action taken — paused all failing agents (REVERSIBLE)

Paused every `error`-state agent via `POST /api/agents/:id/pause` to stop the
failed-run loops. Result: error agents **30 → 0** across all companies. No
agents were deleted or reconfigured. **Rollback:** `POST /api/agents/:id/resume`
for any id below (do this only after the adapter runtime is fixed, or they will
immediately re-enter `error`).

<details><summary>Paused agents (rollback record, 30)</summary>

**RxFit Enterprise**
- `002a8e1c-9206-46a2-bf6e-4ffb46cbb254` COO
- `4f4548b7-9f7d-458b-b4ec-3b373a0fff57` CFO
- `82984f59-633e-4cdf-b8a1-d0499f6c226a` CEO
- `91873c35-2586-4623-bb78-23627d3c5ca9` CTO
- `360e4642-135a-493d-b500-a532d23b3714` CMO
- `9fde4962-a499-49fd-9f46-47a021517c52` CEO Personal

**Wellness App**
- `ffe8817a-d521-4b76-b709-f24779cba2df` CFO
- `6d4b2ea0-ae13-4e2f-b1cf-4116514bafe9` COO
- `2624ed61-8fba-484b-b12a-50985bf3660a` CMO
- `9fde65a8-1f27-42c1-8303-8f06c4283d66` CTO
- `4f6f8e11-0a87-483d-9a39-61cbbca4875d` CEO

**FridgeSnap**
- `81f22332-a0c2-4086-8f3f-68d626f3e20e` CEO
- `c7936618-da55-469e-b131-ba8003c38ca3` CFO
- `d24f9384-45c6-4f22-a252-51cda13fd783` CTO
- `a8b620e3-91bb-46f6-bf8a-3a21a93704a1` CMO

**Jade CoS**
- `114acb48-a29c-49e0-9a60-9d2c68dbb15e` CEO
- `047620e9-3b86-454d-9130-2f0d350ca9d8` COO
- `361e558f-facc-4596-ba81-6187ffa84564` CTO
- `57156176-17cc-4fe2-b1eb-26ee13557881` CFO
- `e0617e39-bfcd-4581-b99b-89efaef2685b` CMO

**NotebookRx**
- `517b01f3-455c-41ab-958b-f7634166ab22` CMO
- `fb6211da-4c15-446f-8e41-e9e4262c0310` CFO
- `ce37b65a-ae49-49f4-a3dc-e3807311486b` COO
- `089b1965-083c-4cc2-906b-22f01799735a` CTO
- `ea5c66ff-184d-4895-9a04-fe080e616104` CEO

**SEO Agent**
- `22619c22-2a27-4c16-85c7-3896d58e0c52` CTO
- `20b75c63-3034-4309-a922-f0cdea8252c5` COO
- `4b10b808-165c-4e35-b13b-3e4d4214df30` CEO
- `aa9eb5d7-e288-4d30-af7c-65bee5cd4c91` CMO
- `df9651db-6304-4605-928e-2d9f36a2deca` CFO
</details>

## Config bug fixed (code)

`RXFIT_CEO_COMPANY_ID` pointed at a phantom company `8f2acc3d…` that returns
`403 User does not have access` and does **not** contain the CEO agent (the
CEO agent `82984f59…` lives in RxFit Enterprise `829b2493…`). The
issue-creation fallback therefore 403'd whenever `DEFAULT_PAPERCLIP_COMPANY_ID`
was unset. Fixed in `hub/lib/paperclipConfig.ts` — `RXFIT_CEO_COMPANY_ID` now
aliases `RXFIT_COMPANY_ID`. There is one RxFit company, not two.

## Server-side behaviors to know (they constrain any cleanup)

1. **Hard `DELETE` 500s for entities with history.** `DELETE /api/issues/:id`
   (and by extension agents with cost_events/runs) returns 500 once the entity
   has comments/activity — a Paperclip FK-constraint bug. **Cleanup must use
   soft ops:** issues → `PATCH status:"cancelled"`, agents →
   `POST /api/agents/:id/terminate`. Do **not** rely on hard delete.
2. **Invalid status transitions 422.** Paperclip enforces the lifecycle
   (e.g. `backlog → todo → in_progress`); a direct `backlog → in_progress`
   returns 422. The Hub's Issues-tab state select should route through valid
   intermediate states (small follow-up).

## The real fix — bringing agents back online (owner / infra)

Pausing stopped the noise but the agents still can't run. To restore them,
pick one:

- **A. Install + auth the Gemini CLI on the Cloud Run image** so `gemini_cli`
  resolves to a real command, then set each agent's `adapterConfig.command`
  appropriately. (Requires a Dockerfile change + credential mount; heaviest.)
- **B. Switch agents to a hosted adapter** — reconfigure `adapterType` to an
  HTTP/gateway adapter (e.g. `http` or an OpenClaw/Hermes gateway) that calls a
  model API directly, so no host CLI is needed. Most robust for Cloud Run.
- **C. Leave paused** until the org is ready to run autonomous agents.

After whichever fix, `resume` the agents above and confirm a manual
`POST /api/agents/:id/wakeup` produces a `succeeded` run before re-enabling
heartbeats.

## Pending cleanup — AWAITING OWNER APPROVAL (not yet done)

Not executed; needs a scope decision (RxFit-only / +siblings / +archive).

- **15 duplicate agents** — Wellness / Jade CoS / SEO Agent each have an idle
  `… 2` C-suite set alongside the errored originals. Resolve via
  `terminate` (delete 500s).
- **~250 orphaned blocked tasks** — Jade CoS 138, SEO Agent 37, FridgeSnap 33,
  plus RxFit/others — stuck because no agent can complete them. Clear via
  `PATCH status:"cancelled"`.
- **5 sibling companies** — unused by the Hub; candidate for archival now that
  their `orchestration/` configs were removed from the repo.

## Test artifact left behind

One `[HUB-TEST]` issue (`93f7eb42-6255-403d-939d-0938818397e0`, RxFit) created
to verify the write path could not be hard-deleted (server 500, see quirk #1);
it was set to `cancelled`. Safe to ignore.
