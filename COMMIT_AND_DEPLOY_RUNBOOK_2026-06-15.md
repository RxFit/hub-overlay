# Hub Overlay — Commit & Deploy Runbook
**For:** IDE coding agent (Antigravity) to commit this session's work and deploy to Cloud Run.
**Date:** 2026-06-15
**Repo:** `RxFit/hub-overlay` · branch `master` · HEAD baseline `4b69d55`
**GCP project:** `rxfit-automation` (⚠️ NOT `antigravity-dashboard`) · Cloud Run service `hub` · region `us-central1`
**Status:** All changes below type-check clean (`tsc --noEmit` exit 0, verified on a clean clone).

---

## 0. Pre-flight (verify before touching anything)
```bash
git remote -v            # expect origin → github.com/RxFit/hub-overlay
git rev-parse --abbrev-ref HEAD   # expect master
gcloud config get-value project    # MUST be rxfit-automation
```
If the project is wrong: `gcloud config set project rxfit-automation`.

> The changes in sections 1–3 are **already applied** in the working copy at
> `C:\Users\danie\OneDrive\HQ Desktop\Hub Overlay\hub\`. If your IDE checkout **is** that
> folder, skip the "apply" steps and go straight to **Section 5 (commit)**. If your checkout
> is elsewhere, apply sections 1–3 as specified, then commit.

---

## 1. Patch B — parallelize the search pipeline (`hub/app/api/chat/route.ts`)
**Why:** Vertex/pgvector/Exa search currently runs *sequentially after* the Paperclip + Google
context `Promise.all`, even though it only needs the query + useCase. Running it concurrently
removes up to ~10s from worst-case pre-stream latency.

This is a **pure refactor (moves existing code)** in 3 steps:

**1a.** Add a module-level helper immediately **before** `export async function POST(`:
```ts
/**
 * Search pipeline (Vertex AI + pgvector + Exa). Depends only on query + useCase,
 * so it can run concurrently with context assembly. 10s aggregate timeout.
 */
async function runSearchPipeline(query: string, effectiveUseCase: string): Promise<string[]> {
  return withTimeout(
    (async () => {
      // MOVE the body of the existing search IIFE here VERBATIM — everything from
      //   `const searchPromises: Promise<string | null>[] = []`
      // through
      //   `return results.filter((r): r is string => r !== null)`
      // It already references only: query, effectiveUseCase, log, needsInternalSearch,
      // needsExternalSearch, breaker, CircuitOpenError, searchSemanticBrain, searchWeb,
      // and dynamic imports of tenant-context / vector-store. No other changes needed.
    })(),
    10_000,
    [] as string[],
    'search-pipeline',
  )
}
```

**1b.** Immediately **before** `const [paperclipContextResult, googleWsResult] = await Promise.all([`, insert:
```ts
  // Search depends only on the query + useCase (not on Paperclip/Google context),
  // so kick it off NOW to run CONCURRENTLY with the context fetches below.
  const effectiveUseCase = activeSkill ? 'deep_dive' : useCase
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()
  const query = lastUserMsg?.content ?? ''
  const searchPromise: Promise<string[]> = query
    ? runSearchPipeline(query, effectiveUseCase)
    : Promise.resolve([])
```

**1c.** Delete the now-duplicated old section — the old `const effectiveUseCase = ...`, the
"Intelligent Search Routing" comment, `const lastUserMsg = ...`, `const searchContextParts ...`,
and the entire `if (lastUserMsg) { ... }` search block — and replace it all with:
```ts
  const searchResults = await searchPromise
  const searchContext = searchResults.join('')
```
> Net effect: search now starts before the context `Promise.all` and is awaited after, so the
> two overlap. `lastUserMsg` is still declared (now up front) for the attachments block below.

---

## 2. Delete the dead `Hub/` stack (`hub/app/components/Hub/`)
Zero imports anywhere in `app/`/`lib/` (`useHubState.ts` was already deleted; this is the
orphaned duplicate stack). Remove all 6 files:
```bash
git rm hub/app/components/Hub/ChatPanel.tsx \
       hub/app/components/Hub/ChatWelcome.tsx \
       hub/app/components/Hub/LeftSidebar.tsx \
       hub/app/components/Hub/MobileControlBar.tsx \
       hub/app/components/Hub/MobileNav.tsx \
       hub/app/components/Hub/RightPanel.tsx
```

---

## 3. Trim the Docker image (`hub/.dockerignore`)
Replace the file contents with:
```
# Build artifacts & dependencies (reinstalled/built in the image)
node_modules
.next
out
.wrangler
.git

# ── Skill toolkit trim ──
# The app only reads each skill's SKILL.md at runtime (lib/skills-loader.ts).
# Everything below is dev tooling, never loaded by the running server.
skills/**/test/
skills/**/*.test.ts
skills/**/docs/
skills/**/scripts/
skills/**/bin/
skills/gstack/.agents/
skills/**/CHANGELOG.md
skills/**/*.tmpl

# Local env & logs
.env*.local
*.log
npm-debug.log*
```
> Safe: all 28 `SKILL.md` files live at each skill's root, separate from these subtrees.
> Removes ~2.5 MB from the build context.

---

## 4. Already in HEAD — do NOT redo
These landed in earlier commits and are present at `4b69d55`; re-applying would conflict:
- `lib/google-context.ts` (live Google Workspace fetch)
- `lib/gemini.ts` deflection scoping + `## Live Google Workspace` render + `googleWorkspaceDetail`
- `lib/auth.ts` redirect-confinement callback + `[auth] OAuth config` startup diagnostic
- `LeftPanelSections.tsx` structured task + calendar tap injection

---

## 5. Verify, commit (scoped), push
```bash
# from hub/
npm run build      # expect success; tsc clean

# commit ONLY this session's functional changes (scoped — see §6 about other dirty files)
git add hub/app/api/chat/route.ts hub/.dockerignore
# (the 6 Hub/ deletes were staged by git rm in §2)
git commit -m "perf(chat): parallelize search with context (patch B); remove dead Hub/ stack; trim docker image"
git push origin master
```

---

## 6. ⚠️ Line-ending hygiene — READ BEFORE `git add -A`
The working tree currently shows **~340 modified files**, but most are **CRLF↔LF noise**
(no `.gitattributes`, `core.autocrlf` unset; working files are CRLF, committed blobs are LF).
Example: `lib/claude.ts` reports "184 lines changed" but **0** real changes under `git diff -w`.

**Do NOT `git add -A` / commit everything** — it would bury the real changes in a 340-file
line-ending churn commit. Either:
- **(preferred)** commit only the scoped files in §5, **or**
- fix it properly first as a **separate commit**:
  ```
  # repo root — create .gitattributes:
  #   * text=auto eol=lf
  #   *.ps1 text eol=crlf
  #   *.png binary
  git add .gitattributes
  git add --renormalize .
  git commit -m "chore: normalize line endings to LF (.gitattributes)"
  ```
  Then re-check `git diff -w --stat` — there are ~60 files with *real* (non-whitespace)
  divergence from HEAD beyond this session's work (the "deployed-but-not-committed" drift).
  **Triage those before deploying** — confirm each is intended, not stale local state.

---

## 7. Deploy to Cloud Run
```powershell
# preferred — the wrapper enforces clean git + correct project + post-deploy QA
.\deploy.ps1
```
Fallback (only if not using the wrapper):
```powershell
gcloud run deploy hub --source . --project rxfit-automation --region us-central1
```
> `deploy.ps1` will refuse to run on a dirty tree — that's why §5/§6 must be clean first.

---

## 8. Post-deploy verification
1. **OAuth sanity** — in Cloud Run logs, find the line:
   `[auth] OAuth config {"nextAuthUrl":"https://hub.casatrejo.com", ...}`
   Confirm `nextAuthUrl` is the Hub (not unset, not another app) and `googleClientId` is the Hub's.
2. **Run the QA script** (the Playwright test added in `4b69d55`).
3. **Smoke test the original bug:** open the app → tap a Google Task in the left panel →
   the assistant should answer from the `## Live Google Workspace` context, **not** reply with
   "I couldn't retrieve live data from Paperclip … warming up."
4. **Latency check:** first chat token should arrive noticeably faster (patch B overlap).

---

## Summary of files in this session's commit
| File | Change |
|------|--------|
| `hub/app/api/chat/route.ts` | Patch B — `runSearchPipeline` helper + concurrent `searchPromise` |
| `hub/.dockerignore` | Skill-toolkit + env/log exclusions |
| `hub/app/components/Hub/*.tsx` (6) | **Deleted** — dead duplicate stack |
