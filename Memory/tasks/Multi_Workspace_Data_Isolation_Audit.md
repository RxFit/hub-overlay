# Multi-Workspace Data Isolation Audit & Fixes

## Metadata
| Key | Value |
|-----|-------|
| Date | 2026-06-07T16:27:00Z |
| Workspace | vibrant-chandrasekhar |
| Conversation | 78b906a4 |
| Type | audit |

## Summary
Ran a full /RxHarden /Pre-Cog audit of every API route, frontend component, and data flow in the Hub for multi-workspace data isolation issues. Found 12 issues (5 CRITICAL, 5 MEDIUM, 2 LOW). Implemented 7 fixes across 5 files and deployed. Root cause: shared Paperclip service account means ALL isolation must be enforced by the Hub — and 5 routes were not filtering by user's assignedProjects.

## Key Decisions
- Admin/superadmin continue to see ALL workspaces (they have `['*']`) — only staff users are filtered
- KPI multi-tenancy deferred to P2 (requires DB migration)
- Active workspace resolved from the project dropdown in the header, falling back to first available company
- COO agent for communications is now found dynamically per-workspace instead of hardcoded

## Bugs Fixed (7)
1. **Activity Feed** — leaked ALL companies to ALL users → now scoped by assignedProjects
2. **Chat Context** — injected ALL companies into LLM prompt → now scoped
3. **send_communication** — hardcoded RXFIT_COMPANY_ID + RXFIT_COO_AGENT_ID → dynamic resolution
4. **Inbox URLs** — hardcoded /RXF/inbox/mine → dynamic company identifier
5. **create_paperclip_issue** — missing companyId → passes active workspace ID
6. **Issues route** — no bodyCompanyId validation → staff can't target arbitrary workspaces
7. **CEO Pulse** — defaulted to alphabetical first company → scoped to user's workspaces

## Files Changed
- `hub/app/api/feed/route.ts` — Added assignedProjects filtering + onboarding guard
- `hub/app/api/chat/route.ts` — Added assignedProjects filtering to context injection
- `hub/app/page.tsx` — Added useCompanies, resolveActiveCompany(), dynamic COO lookup, dynamic inbox URLs, companyId in issue creation
- `hub/app/api/paperclip/issues/route.ts` — Added bodyCompanyId authorization check
- `hub/app/api/paperclip/ceo-pulse/route.ts` — Added assignedProjects filtering

## Audit Process
- 3 parallel research subagents (backend route auditor, frontend component auditor, proxy deep audit)
- Direct orchestrator audit of all critical paths
- Paperclip issue HUB-9 created for tracking

## Tags
#memory #vibrant-chandrasekhar #audit #multi-tenant #security #data-isolation #paperclip
