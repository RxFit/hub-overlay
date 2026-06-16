# Hub Overlay — Dead Code & Efficiency Audit

**Date:** 2026-06-15
**Scope:** Whole repo (`hub/` + `orchestration/`, `scripts/`, `railway/`, root). Analysis run against a clean clone of `RxFit/hub-overlay` @ `4b69d55` in an isolated environment (no OneDrive truncation), so the findings are reliable.
**Deliverable:** Report + safe fixes applied to the local folder. Riskier wins are listed as ready-to-apply patches, not auto-applied.

---

## ✅ Applied now (safe, verified)

| Fix | What | Impact |
|-----|------|--------|
| **Deleted `app/components/Hub/`** | The dead duplicate chat stack (`ChatPanel.tsx`, `ChatWelcome`, `LeftSidebar`, `MobileControlBar`, `MobileNav`, `RightPanel` — ~33 KB, 6 files). Zero imports anywhere in `app/`/`lib/`; `useHubState.ts` was already deleted. | Removes the stack that derailed three prior audits. Type-check clean after removal. |
| **Expanded `hub/.dockerignore`** | Excludes the skill toolkit's non-runtime subtrees (`skills/**/test/`, `*.test.ts`, `docs/`, `scripts/`, `bin/`, `gstack/.agents/`, `CHANGELOG.md`, `*.tmpl`) plus `.env*.local`/logs. | ~2.5 MB out of the Docker build context. The app only reads each skill's `SKILL.md` at runtime (all 28 confirmed present at skill root), so nothing functional is lost. |

Both verified with `tsc --noEmit` (exit 0) on the clean clone.

---

## Dead code

- **[Fixed] `app/components/Hub/`** — gone.
- **Legacy `streamGeminiChat` export (`lib/gemini.ts`)** — no importers anywhere; superseded by `streamChat`. Safe to delete (~10 lines). *Not auto-removed* — `gemini.ts` is hot/sensitive and it's tiny; remove on your next touch of that file.
- **Hardcoded RxFit constants (`lib/paperclipConfig.ts`)** — `RXFIT_COMPANY_ID`, `RXFIT_COO/CTO/CMO/CFO_AGENT_ID` show no references. Likely dead after the multi-tenancy work, but config constants can be referenced indirectly — verify before removing.
- **Root-level cruft** — `audit-output*.txt`, `fix-script.js`, `csuite_modal_screenshot_fixed.png`, `paperclip_logs.txt`, `ceo_comments.txt` sit at repo root. Already excluded from the deploy by `.gcloudignore`, but they're repo noise. Safe to delete from git if you don't need them.
- **Heads-up — noisy "unused export" scans:** a blanket exported-symbol scan flags ~40 names (e.g. `chatMessagesToContents`, `INTERNAL_WORD_SIGNALS`), but most are used *internally* or by *test files*, so they are NOT dead. Don't bulk-delete exports off a grep — that's how you break a build. Use `ts-prune` or `knip` (see Tooling) for a real list.

## Chat / API latency

- **Search runs *after* the context fetch, not alongside it.** `route.ts` parallelizes Paperclip + Google Workspace via `Promise.all` (line 65, good), but the search pipeline (`withTimeout`, line 204, up to 10 s) then runs sequentially *after*. Search only needs the user's query — it has no dependency on the context results — so it can join the same parallel wave. **Potential win: up to ~10 s off worst-case pre-stream latency.** Fold the search block into the top-level `Promise.all`. (Moderate refactor — patch sketch below.)
- **`getRuns` N+1 fan-out.** Building "Recent Agent Runs" fetches issues, then runs per-issue (up to 3 companies × N issues) inside the 8 s context budget — a latency bomb when Paperclip is slow. Cap issues-per-company (e.g. 3) and/or add a per-fetch `AbortSignal.timeout`.
- **Google Workspace context is re-fetched every message.** `buildGoogleWorkspaceContext` hits 4 Google APIs on every turn. A short per-user in-memory TTL cache (~30–60 s) would cut steady-state chat latency noticeably with negligible staleness.

## Bundle & page-load

- **No bloated third-party deps** — no recharts/framer/lucide/moment/lodash in `package.json`. Bundle weight is hand-written code, which is the healthier problem to have.
- **Very large client components:** `app/settings/page.tsx` (1,877 lines / 84 KB) and `app/page.tsx` (1,488 lines / 62 KB) are single `'use client'` files shipped whole. Biggest page-load lever: split non-critical UI (modals, settings sub-tabs, the tool panel) behind `next/dynamic` so it's not in the initial chunk. 41 `'use client'` files total — fine, but the two giant ones dominate.
- **`app/globals.css` is ~0.2 MB** — large for a single stylesheet loaded on every page. Worth auditing for dead selectors (`purgecss`/Tailwind content scanning if applicable).

## Build / deploy

- **[Fixed] `.dockerignore`** trimmed (above).
- **Single-stage Dockerfile + no `output: 'standalone'`.** The Dockerfile is `FROM node:20-slim → COPY . . → npm run build`, and `next.config.js` doesn't set `output: 'standalone'`. The runtime image therefore carries the full `node_modules` + all source. Switching to standalone + a multi-stage build is the biggest image-size/cold-start win. **Important caveat:** the app reads `skills/**/SKILL.md` from `process.cwd()` at runtime, and Next's file tracing won't include those data files — the Dockerfile must explicitly `COPY skills ./skills` (and `public`) into the standalone stage, or skill loading breaks. Patch below — test before relying on it; you just got deploys stable.

---

## Ready-to-apply patches (not auto-applied)

**A. Standalone image (next.config.js):**
```js
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  async headers() { /* unchanged */ },
}
```
**Multi-stage Dockerfile (must copy `skills/` + `public/` explicitly):**
```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/skills ./skills   # runtime SKILL.md reads
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
```

**B. Parallelize search with context (route.ts)** — move the `searchResults` `withTimeout(...)` block into the top-level `Promise.all([...])` alongside the Paperclip and Google branches (it only depends on `lastUserMsg`, already known before the block), then read `searchContextParts` from the resolved tuple.

## Recommended tooling (catches this automatically going forward)
- `npx knip` or `npx ts-prune` — real dead-export/file/dependency detection (replaces the noisy grep).
- `npx depcheck` — unused dependencies in `package.json`.
- Add `output: 'standalone'` + multi-stage build to shrink the image.
- A bundle analyzer (`@next/bundle-analyzer`) to confirm the page-split wins before/after.

## Verification & commit
- Applied changes (`Hub/` deletion, `.dockerignore`) type-check clean on the clean clone.
- Commit + push via `deploy.ps1` so local/GitHub/Cloud Run stay in sync. Note: the `auth.ts` redirect-confinement + OAuth diagnostic from the prior session is also local-only until committed.
