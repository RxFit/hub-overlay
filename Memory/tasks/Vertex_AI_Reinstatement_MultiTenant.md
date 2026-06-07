# Vertex AI Reinstatement and Multi-Tenant Filtering

## Metadata
| Key | Value |
|-----|-------|
| Date | 2026-06-07T13:51:00-05:00 |
| Workspace | vibrant-chandrasekhar (Hub Overlay) |
| Conversation | 71a0e2b8 |
| Type | refactor |

## Summary
Reversed the deprecation of Vertex AI per user request. Vertex AI is reinstated as the primary semantic search tool for internal knowledge. To ensure multi-tenant security when indexing Drive files in a shared Vertex datastore, I implemented Option A (Metadata Filtering).

## Key Decisions
- **Restored Vertex AI:** Reverted `hub/app/api/chat/route.ts` to use `searchSemanticBrain`.
- **Metadata Filtering:** Updated `hub/lib/vertex.ts` to dynamically append `tenantId="<tenant_id>"` to the `body.filter` payload when querying Vertex AI Discovery Engine. This strictly silos search results to the requesting client.
- **Query Expansion:** Kept `queryExpansionSpec` and `spellCorrectionSpec` disabled in `vertex.ts`, as they are incompatible with multi-datastore filtering and return `400 INVALID_ARGUMENT`.

## Files Changed
- `hub/app/api/chat/route.ts` — Restored Vertex AI search and passed `tenantId`.
- `hub/lib/vertex.ts` — Implemented custom metadata filtering (`filter = tenantId="rxfit"`).

## Tags
#memory #hub-overlay #refactor #vertex-ai #multi-tenant #security
