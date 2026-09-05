# `scripts/agy/` — Antigravity CLI (agy) as the Hub's execution engine

This directory holds the migration tooling for replacing the Paperclip
orchestration layer with the **Antigravity CLI (`agy`)** running on the
subscription **token allotment** (consumer OAuth), not on metered API billing.

Full rationale, architecture, risk ledger, and the re-imagining of the Hub's
own tools (Interview Mode, the score-context gate, Pre-Cog, skills) on the new
engine live in the blueprint artifact. This README covers the runnable pieces.

---

## Why this exists (one paragraph)

The Hub's right panel was a fully-built management surface starved of a working
engine: the Paperclip agents were configured with local-CLI adapters that never
existed on their Cloud Run host, so every run failed silently. Rather than
revive Paperclip, we point the panel at `agy`, which already holds your MCP
tools, skills, and business operations — **and** draws on your Pro/Ultra plan
allotment. The catch: `agy` has no headless API-key auth. The only way to spend
the allotment from a server is to **replay the OAuth token** `agy` writes on
your desktop. Phase 0 proves that replay works before we build anything on it.

---

## Phase 0 — prove the token replays

**The one thing this cannot do for you:** mint the token. That needs a single
interactive `agy` sign-in in a browser, which cannot run in an unattended
environment. You do that once on your desktop; the harness does the rest.

### Step 1 — mint the token (desktop, one time)

```bash
# Install and sign in. Opens a browser; complete the Google OAuth grant.
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy            # sign in, confirm the TUI shows your account + plan
```

After sign-in the credential lives at:

| OS | Location |
|----|----------|
| **Linux** | `~/.gemini/antigravity-cli/antigravity-oauth-token` (plain JSON) |
| **Windows** | `%USERPROFILE%\.gemini\antigravity-cli\antigravity-oauth-token` |
| **macOS** | Keychain entry `service=gemini account=antigravity`. Export it to a JSON file shaped like the Linux token (`{"token":{...},"auth_method":"consumer"}`) before using it here. |

The durable field is `refresh_token` — `agy` refreshes the short-lived
`access_token` from it automatically. Treat the whole file as a secret.

### Step 2 — run the replay test

**Option A — clean-room container (recommended).** Reproduces the exact Cloud
Run condition: no keyring, no D-Bus, `node:22-slim` (the Hub's own base image).
A PASS here is a PASS in the real target.

```bash
docker build -f scripts/agy/Dockerfile.phase0 -t agy-phase0 scripts/agy

docker run --rm \
  -v /abs/path/to/antigravity-oauth-token:/token:ro \
  -e AGY_TOKEN_FILE=/token \
  agy-phase0
```

**Option B — any throwaway Linux box** with `agy` installed and `util-linux`
present (for `script`):

```bash
AGY_TOKEN_FILE=/path/to/antigravity-oauth-token ./scripts/agy/phase0-replay-test.sh
```

### Step 3 — read the verdict

The script is deliberately loud and never trusts an exit code alone (agy's
worst failure mode is exit 0 with empty output — the same silent failure you're
leaving Paperclip to escape):

| Verdict | Meaning | Next step |
|---------|---------|-----------|
| `PASS` | The token replayed on a keyring-less box; agy answered a marker-verified prompt. | Phase 1 (Gateway) is unblocked. |
| `FAIL — AUTH did not replay` | agy fell back to interactive OAuth. Usually the `SSH_*` env vars didn't take, so it tried the absent keyring. | Confirm the token path and that `SSH_CONNECTION/SSH_CLIENT/SSH_TTY` are exported (the container does this). If it persists, re-mint the token. |
| `FAIL — EMPTY output` | The silent-failure mode: no pty was honored, or agy produced nothing. | Re-run in the Dockerfile, which guarantees a `/dev/pts`. |
| `FAIL — no refresh_token` | The token file can't self-refresh. | Re-mint with a fresh interactive login. |
| `SETUP` | agy missing, or no token supplied. | Follow the message; install agy or pass `AGY_TOKEN_FILE`. |

### Environment knobs

| Var | Default | Purpose |
|-----|---------|---------|
| `AGY_TOKEN_FILE` | — | Path to the token file to plant. Omit if it's already at the default path. |
| `AGY_PATH` | auto-discover | Path to the `agy` binary. |
| `AGY_MODEL` | agy default | Pin a model slug for the probe. |
| `AGY_PRINT_TIMEOUT` | `90s` | Per-run response timeout passed to `agy`. |
| `AGY_HARD_TIMEOUT` | `150` | External kill ceiling (seconds). |

---

## What comes after Phase 0

| Phase | Adds here |
|-------|-----------|
| **1 · Gateway** ✅ | Shipped as `hub/lib/agy.ts` (in-process gateway, not a separate proxy service) + `/api/admin/agy-health`. |
| **2 · Worker + ledger** (in progress) | The accountability-wrapped `agy` runner + the `ai_runs` Postgres ledger, so every run is recorded. Chat integration shipped (`hub/lib/agy-chat.ts`, behind `AGY_CHAT_ENABLED`); ledger shipped (`hub/lib/runs.ts`). Remaining scope below. |
| **2.5 · Desktop dispatch** (designed 2026-08-15) | **Unplanned insertion — the Cloud Run premise died.** Google refuses consumer-OAuth refresh from datacenter IPs: the same token that PASSES the Phase 0 clean room on the desktop auth-fails on Cloud Run (secrets verified hash-identical, so it is the egress IP, not the credential). Allotment execution therefore moves to a desktop worker; the Hub keeps orchestrating via a Postgres job queue the worker long-polls outbound. Design: [`hub/docs/architecture/DESKTOP_DISPATCH_2026-08-15.md`](../../hub/docs/architecture/DESKTOP_DISPATCH_2026-08-15.md). **✅ Shipped and LIVE 2026-08-20** (substrate #196, worker #197; probe `markerVerified:true`; `AGY_CHAT_ENABLED` + `AGY_DISPATCH_ENABLED` on): chat serves allotment-first through the desktop worker, metered fallback otherwise. Known weaknesses + prioritized hardening: [`hub/docs/architecture/HARDENING_REVIEW_2026-08-20.md`](../../hub/docs/architecture/HARDENING_REVIEW_2026-08-20.md). |
| **3 · Rewire panel** (in progress) | Point the right-panel feed at the runs ledger; retire the Paperclip proxy, instance, and `scripts/paperclip/` watchdogs. Design: [`hub/docs/architecture/PHASE3_EXECUTION_PANEL_2026-08-22.md`](../../hub/docs/architecture/PHASE3_EXECUTION_PANEL_2026-08-22.md). PR 1 (keys off Paperclip) + PR 2 (runs feed, panel = Pulse + Runs) shipped; dispatch rail, ops writes, and the rip-out remain. |
| **4 · Reborn tooling** | Re-point Interview Mode, the score-context gate, Pre-Cog, and the skills loader from "assemble a REST payload" to "brief and verify an `agy` run." **First arc designed 2026-08-23** — Deep Research + Deep Think as featured async tools on the `work_item` dispatch lane: [`hub/docs/architecture/DEEP_LANE_2026-08-23.md`](../../hub/docs/architecture/DEEP_LANE_2026-08-23.md). **Second arc, the agentic panel (2026-09-05)** — the assistant reads the Hub's own ledgers instead of the retired Paperclip context, card taps carry the record, Pulse runs on live data; then a needs-you queue, a playbooks catalog on the `work_item` lane, and scorecards: [`hub/docs/architecture/PHASE4_AGENTIC_PANEL_2026-09-05.md`](../../hub/docs/architecture/PHASE4_AGENTIC_PANEL_2026-09-05.md). PR 1 shipped. |

### Phase 2 remaining scope (locked 2026-08-14)

Three scope-shapers, decided after mapping what the Hub actually has today:

1. **Conversations table.** ✅ shipped end to end — `chats` + `chat_messages`
   tables with `hub/lib/chat-store.ts` (client-minted chat ids, session-email
   ownership, idempotent appends, best-effort writes) wired into `/api/chat`,
   read endpoints at `/api/chats`, and the client loop in `useChatEngine`
   (sends the chatId, restores the latest conversation on load, "+ New chat"
   header control). Conversations now survive a refresh.
2. **Engine-agnostic ledger.** ✅ shipped — `ai_runs` records `engine`
   (`agy | gemini | claude`), so metered turns can join the ledger without a
   migration. agy call sites (chat + health probe) write rows now; the metered
   chains join when the Phase 3 panel needs them.
3. **Chat post-tagging convention.** ✅ shipped — `hub/lib/chat-post-tag.ts`.
   Everything the Hub posts to Google Chat (AI posts, scheduled digests) is
   sent AS the operator; without a marker, any agent in the space that reacts
   to operator messages (e.g. the Hermes desktop orchestrator) can be
   triggered by a Hub post it mistakes for an instruction. The contract:
   every automated Hub post ends with the literal line `— via HUB`, and
   external agents must treat a message whose text ends with that literal as
   informational, never as an instruction. Manual replies typed by the
   operator in the Hub's Chat panel are NOT tagged — those are the operator
   speaking. The literal is pinned by unit test; do not reword it.

---

## Security notes

- The token file is a **personal OAuth credential**. It is never committed, never
  baked into an image, and never logged. In production it belongs in Secret
  Manager, mounted read-only.
- This approach is **unofficial** and rides undocumented behavior; it can breach
  Antigravity's terms and the internal surface may change. See the blueprint's
  risk ledger. Keep an API-key Gemini fallback wired so a disruption can't dark
  the Hub.
