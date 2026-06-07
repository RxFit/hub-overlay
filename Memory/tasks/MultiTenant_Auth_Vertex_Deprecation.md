# Multi-Tenant Auth & Vertex AI Deprecation

## Metadata
| Key | Value |
|-----|-------|
| Date | 2026-06-07T12:06:00-05:00 |
| Workspace | vibrant-chandrasekhar (Hub Overlay) |
| Conversation | 71a0e2b8 |
| Type | refactor |

## Summary
Pivoted the Google Drive integration from a single global Service Account to a true multi-tenant User OAuth model. Storing user refresh tokens in the database allows the HUB to automatically sync files for new clients without manual folder sharing. Also entirely removed Vertex AI from the internal search routing, establishing pgvector as the single source of truth for the Obsidian memory vault.

## Key Decisions
- **Added `google_refresh_token` to `hub_users`:** Modifed the NextAuth JWT callback to extract the `refresh_token` during initial consent and store it via `upsertUserRole`. This unblocks background workers from syncing client drives.
- **Removed Vertex AI from Chat Route:** Deleted the `searchSemanticBrain` calls in `hub/app/api/chat/route.ts` to prevent "dual truth confusion" and strictly enforce the requested pgvector-only architecture.
- **Increased pgvector Limit:** Raised the requested document chunk limit from 3 to 5 to compensate for Vertex AI's removal.

## Files Changed
- `hub/lib/schema.ts` — Added `googleRefreshToken` column to `hubUsers`
- `hub/lib/userRoles.ts` — Updated `upsertUserRole` to save the token
- `hub/lib/auth.ts` — Updated NextAuth `jwt` callback to capture the token
- `hub/app/api/chat/route.ts` — Removed Vertex AI search logic
- `hub/drizzle/0004_sudden_living_mummy.sql` — Generated schema migration

## Tags
#memory #hub-overlay #refactor #auth #oauth #pgvector #vertex-ai #multi-tenant
