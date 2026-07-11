# Protected workspaces (undeletable Paperclip companies)

Some Paperclip **companies** (a.k.a. "workspaces") are load-bearing: the Hub
pins their IDs and depends on them for agent orchestration and issue routing.
Deleting a company cascades to all of its agents, issues, and runs and is
**irreversible**. To make that mistake impossible, deletion of a protected
workspace is **refused server-side**.

## What is protected

The protected list is assembled at request time by
`hub/lib/protected-workspaces.ts` (`getProtectedCompanyIds()` /
`isProtectedCompany(id)`) from these sources:

| Source | IDs |
| --- | --- |
| `lib/paperclipConfig.ts` | `RXFIT_COMPANY_ID` (RxFit Enterprise), `RXFIT_CEO_COMPANY_ID` (CEO workspace) |
| `process.env.DEFAULT_PAPERCLIP_COMPANY_ID` | the issue-routing fallback — deleting it breaks issue creation |
| `process.env.PROTECTED_COMPANY_IDS` | optional, comma-separated extra IDs (see below) |

IDs are compared **case-insensitively** (trimmed + lowercased). Postgres
resolves UUIDs case-insensitively, so an uppercase-UUID delete targets the same
row as its lowercase form — the guard normalizes both to close that bypass
(mirrors the proxy-authz uppercase-UUID fix).

## Adding a workspace without a deploy

Set `PROTECTED_COMPANY_IDS` to a comma-separated list of company IDs, e.g. to
protect the SEO Agent workspace:

```
PROTECTED_COMPANY_IDS=11111111-2222-3333-4444-555555555555
```

The list is read **lazily on every check**, so a runtime-injected env var takes
effect without a rebuild. Empty/unset entries are ignored.

## How it is enforced

1. **Proxy (authoritative boundary)** —
   `app/api/paperclip/[...path]/route.ts` DELETE handler. A
   `DELETE /api/companies/<id>` against a protected id returns
   **403** `{ "error": "This workspace is protected and cannot be deleted.",
   "code": "PROTECTED_WORKSPACE" }` **before** forwarding upstream and
   **independent of** the admin role gate — it blocks **every** role, including
   superadmin, regardless of how the request was constructed (chat, direct
   fetch). Only company deletes are affected; deletes of issues/agents and all
   GET/POST/PATCH traffic are untouched.
2. **Server helper (defense in depth)** — `deleteCompany(id)` in
   `lib/paperclip.ts` throws for a protected id before issuing the DELETE.
3. **Client UX** — the `delete_workspace` branch of `lib/actions/executeAction.ts`
   short-circuits config-pinned protected workspaces with a friendly message so
   the user gets immediate feedback instead of a 403 round-trip. The server 403
   remains the real guard (and covers env-added ids the browser cannot see).
