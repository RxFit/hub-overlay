# HUB Overlay — Antigravity CLI (agy) Orchestration

> ⚠️ **PAPERCLIP IS DEPRECATED — do not build on it, reference it, or route work through it.**
> The Paperclip orgs, agents, CLI profile, and watchdog scripts (`scripts/paperclip/`) are
> retired and being removed. The right panel that once proxied Paperclip commands/UI is
> being rebuilt on the **Antigravity CLI (`agy`) execution engine**. Historical design docs
> that mention Paperclip (`hub/docs/architecture/RIGHT_PANEL_ARCHITECTURE_2026-07-19.md`,
> `hub/docs/architecture/PHASE6_PAPERCLIP_AS_SOLUTION_2026-07-19.md`, `docs/archive/`,
> `docs/ops/paperclip-live-cleanup-2026-07-19.md`) are kept for archaeology only.

## The New Execution Engine: `agy`

The Hub runs work through the **Antigravity CLI (`agy`)** on the **subscription
allotment** (consumer OAuth), not metered API billing. `agy` already holds the
operator's MCP tools, skills, and business operations, so the Hub's execution
surface points at it instead of a separate agent platform.

### Why (one paragraph)

The right panel was a fully-built management surface starved of a working engine:
the old orchestration agents were configured with local-CLI adapters that never
existed on their Cloud Run host, so every run failed silently. Rather than revive
that layer, we point the panel at `agy`. The catch: `agy` has no headless API-key
auth, so a server spends the allotment by **replaying the OAuth token** `agy`
writes on the operator's desktop.

### Canonical documentation

| Doc | Covers |
|-----|--------|
| `scripts/agy/README.md` | Migration blueprint: why, token-replay proof (Phase 0), phase roadmap |
| `hub/docs/runbooks/agy-gateway.md` | Operating the production gateway: setup, rotation, failure classes |
| `hub/lib/agy.ts` | The gateway module itself (heavily commented — read the header) |

### How it works (summary)

- `hub/lib/agy.ts` runs single headless prompts via `agy -p … --output-format json`
  under a real pseudo-terminal (`script -qec`). **Empty output is always failure**
  (agy's silent non-TTY drop, upstream #76/#408); exit codes are never trusted.
- The binary is provisioned **at runtime, lazily** — first run per instance
  downloads it (sha512-verified) to `/tmp/agy-cli/agy`. Never at image build time
  (that broke the deploy pipeline on 2026-08-14). Steady-state RAM cost ~206MB.
- The OAuth token is minted once on a desktop (`agy login` with file-based
  storage forced via `SSH_*` env vars), stored in Secret Manager as
  `hub-agy-oauth-token`, and materialized from `AGY_OAUTH_TOKEN` at request time.
- Failures carry a typed `agyError`: `not_configured | not_installed | install |
  auth | empty | timeout | parse | spawn`. See the runbook's failure-class table.
- Health: `GET /api/admin/agy-health` (cheap) / `?probe=1` (end-to-end, spends tokens).

### Standing caveat

Driving the consumer OAuth token headless rides undocumented behavior and may
breach Antigravity's terms; the internal surface can change without notice. Keep
the metered-provider fallback (`hub/lib/gemini.ts` / `hub/lib/claude.ts`) wired so
a disruption can't dark the Hub.

## Migration Roadmap

| Phase | Status | Adds |
|-------|--------|------|
| **0 · Replay proof** | ✅ done (`scripts/agy/`) | Token replays on a keyring-less box |
| **1 · Gateway** | ✅ done (`hub/lib/agy.ts`, PRs #178–#181) | `agyGenerateText()`, runtime binary provisioning, `/api/admin/agy-health` |
| **2 · Worker + ledger** | next | Accountability-wrapped `agy` runner + Postgres runs table; chat engine integration |
| **3 · Rewire right panel** | planned | Point the panel's feed at the runs ledger |
| **4 · Reborn tooling** | planned | Re-point Interview Mode, the score-context gate, Pre-Cog, and the skills loader from "assemble a REST payload" to "brief and verify an `agy` run" |

## Right Panel — Target Structure (CLI engine version)

The panel's three-layer mental model is unchanged; only the Execution engine swaps:

- **Left panel — Context Layer.** *What* needs to happen: Google Tasks, Calendar,
  shared Drive documents, KPIs.
- **Center — AI Assistant.** Conversational control surface: Interview Mode, the
  context-sufficiency gate, Pre-Cog validation, action intents.
- **Right panel — Execution Layer.** *How* work gets done. New version represents
  the `agy` engine: the **runs ledger** (every run recorded in Postgres with
  status, typed errors, token usage, latency) replaces the old agent/org views.

Design guardrails from the old panel carry over: every write is wrapped in the AI
Assistant's guardrails (role gates, gate tokens, interview flows), and the UI is
poll-friendly.

## Orchestration Model — Hermes orchestrates, CLI workers author

Hermes (Chief of Staff) is the **orchestrator, not the author**. Coding work is
delegated to the CLI workers — **Claude Code CLI** and the **Antigravity CLI
(`agy`)** — which each run in their own local clone and deliver via branch +
real PR (Jules auto-merges on green CI). Hermes routes tasks, monitors state,
and verifies outcomes.

### Dispatch contract (hard rules for every delegated run)

1. **Worker starts from fetched `origin/master`.** Every delegated coding task
   begins with `git fetch --all --prune` and branches off the freshly fetched
   `origin/master`. A worker's local clone can be stale; the dispatch brief must
   force the fetch as step zero so no run builds on old merges.
2. **Verify via the remote, never the local filesystem.** Claude/agy completion
   claims are checked with `gh` against GitHub (`gh pr list`, `gh pr checks`,
   `gh api`), not by reading local files. Local clones — including Hermes' own
   worktree — are treated as possibly-stale snapshots.
3. **Coordination state lives on GitHub.** Open branches/PRs, CI status, and
   merge state are queried from the remote at decision time.
4. **Hermes fetch hygiene.** Any Hermes session working in this repo runs
   `git fetch --all --prune` at session start and before reasoning over code.
5. **Hermes direct edits are the exception.** Rare instruction/doc changes made
   by Hermes directly still go through branch + real PR — never left as
   uncommitted local changes that the workers can't see.

## Repo Guardrails (unchanged)

- **PRs:** always real (non-draft) PRs — automation auto-merges green PRs; CI
  (typecheck + unit + Playwright e2e) is the merge gate. See `CLAUDE.md`.
- **Deploys:** merges to `master` auto-deploy to Cloud Run (`rxfit-automation`,
  service `hub`, us-central1) via `.github/workflows/deploy.yml`.
- **App layout:** the Next.js app lives in `hub/`; run all npm/test commands there.
- **Secrets:** never commit tokens. The `agy` OAuth token lives only in Secret
  Manager / local env. Never print or log it.
