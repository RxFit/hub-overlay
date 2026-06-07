# GCS Bucket & pgvector Stale Data Fix

## Metadata
| Key | Value |
|-----|-------|
| Date | 2026-06-07T09:31:00-05:00 |
| Workspace | vibrant-chandrasekhar (Hub Overlay) |
| Conversation | 71a0e2b8 |
| Type | audit |

## Summary
Full architecture audit of the HUB knowledge system revealed the GCS bucket `sb-drive-962367` has been frozen since May 19, 2026 (366 docs, never synced since). pgvector has only 1 debug chunk. The "Obsidian-style memory vault" was never populated. The Google Drive API is not enabled on the `semantic-brain-desktop` GCP project, which blocks the service account from querying Drive directly.

## Key Decisions
- Reverted the Google Drive API fallback in the chat route — user wants the designed system (Vertex AI + pgvector) working, not band-aids
- Identified that the GCS bucket was a one-time manual export, not an automated pipeline
- Created a bulk ingestion script for Drive → pgvector but it's blocked by Drive API not being enabled on the GCP project
- Determined that both the GCS sync AND the Drive webhook pipeline need the Drive API enabled first

## Files Changed
- `hub/app/api/chat/route.ts` — Reverted Drive API fallback (git revert)
- `hub/lib/vertex.ts` — Removed unsupported queryExpansionSpec/spellCorrectionSpec
- Railway GOOGLE_SERVICE_ACCOUNT_KEY — Updated to correct service account

## Tags
#memory #hub-overlay #audit #vertex-ai #pgvector #architecture
