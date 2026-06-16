# Vertex AI Fix + Railway Production Deploy

## Metadata
| Key | Value |
|-----|-------|
| Date | 2026-06-07T09:04:00-05:00 |
| Workspace | vibrant-chandrasekhar (Hub Overlay) |
| Conversation | 71a0e2b8 |
| Type | fix |

## Summary
Fixed complete Vertex AI (Internal Brain) pipeline failure. Root cause was a triple failure: wrong service account key in .env.local (sdm-node-pubsub from rxfit-automation instead of semantic-brain-admin from semantic-brain-desktop), single-quote wrapping on the JSON value causing JSON.parse failure, and unsupported queryExpansionSpec on a multi-datastore Discovery Engine. Also fixed the Hub chat's system prompt which was conflating Paperclip API failures with Google Workspace failures, causing the LLM to tell users "Google Drive is warming up" when only Paperclip was down.

## Key Decisions
- Swapped service account key from vault (Master .ENV/semantic-brain-desktop-key.json) rather than granting IAM cross-project permissions — simpler, correct project alignment
- Added defensive quote stripping in vertex.ts and google-auth.ts to prevent future .env copy-paste errors
- Removed queryExpansionSpec and spellCorrectionSpec from Vertex AI search body — multi-datastore engines don't support these
- Added DATA SOURCE INDEPENDENCE section to system prompt — prevents LLM from conflating Paperclip failures with Google Workspace status
- Updated Railway production env var via CLI with --stdin flag to avoid shell escaping issues with JSON

## Files Changed
- `hub/lib/vertex.ts` — defensive quote stripping, removed unsupported search params
- `hub/lib/google-auth.ts` — defensive quote stripping
- `hub/lib/gemini.ts` — added DATA SOURCE INDEPENDENCE section to system prompt
- `hub/app/api/chat/route.ts` — fixed Paperclip fallback messages, added Vertex AI empty result guidance
- `hub/.env.local` — swapped GOOGLE_SERVICE_ACCOUNT_KEY to correct SA
- Railway production `GOOGLE_SERVICE_ACCOUNT_KEY` — updated via CLI from OAuth creds (wrong) to service account (correct)

## Tags
#memory #hub-overlay #fix #vertex-ai #railway #production
