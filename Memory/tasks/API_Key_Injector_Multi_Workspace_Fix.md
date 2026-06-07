# API Key Injector — Multi-Workspace Fix

## Metadata
| Key | Value |
|-----|-------|
| Date | 2026-06-07T16:11:00Z |
| Workspace | vibrant-chandrasekhar |
| Conversation | 78b906a4 |
| Type | fix |

## Summary
Audited and fixed the Hub's API key injector (Connected Services panel) to correctly scope key injection to the selected Paperclip workspace. Previously, all keys were silently injected into the default company (RxFit Enterprise) regardless of which workspace the admin intended to target, because the frontend never passed `companyId` to any API call.

## Key Decisions
- Added a workspace dropdown selector to the Connected Services section header, visible when the admin has access to multiple workspaces
- All CRUD operations (GET/POST/DELETE on `/api/settings/keys`) now pass `companyId` explicitly
- Single-workspace users see a static label instead of a dropdown (no UX clutter)
- The `resolveCompanyId()` backend function was already correct — the bug was entirely in the frontend omitting the parameter

## Bugs Found
1. **CRITICAL:** Frontend never passed `companyId` — all keys went to `DEFAULT_PAPERCLIP_COMPANY_ID`
2. **MEDIUM:** Both admin and superadmin get `assignedProjects: ['*']` in auth.ts, so without explicit `companyId` the `['*']` branch always falls through to the default company
3. **LOW:** GET (load secrets) also lacked `companyId` — admins saw the wrong workspace's keys

## Files Changed
- `hub/app/settings/page.tsx` — Added workspace selector UI, wired `companyId` to all fetch calls (GET, POST, DELETE)
- No backend changes needed — `resolveCompanyId()` already handled `requestedId` correctly

## Tags
#memory #vibrant-chandrasekhar #fix #multi-tenant #paperclip #api-keys
