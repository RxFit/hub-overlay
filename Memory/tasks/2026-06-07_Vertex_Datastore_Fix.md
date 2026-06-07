# Vertex Datastore Parameters Fix

## Metadata
| Key | Value |
|-----|-------|
| Date | 2026-06-07T13:56:00Z |
| Workspace | RxFit/hub-overlay |
| Conversation | d0fe5c4d |
| Type | fix |

## Summary
Disabled queryExpansionSpec and spellCorrectionSpec parameters in Vertex search requests. These parameters are unsupported on multi-datastore engines and returned 400 INVALID_ARGUMENT responses on the server.

## Key Decisions
- Commented out queryExpansionSpec and spellCorrectionSpec from searchSemanticBrain payloads to restore operational query functionality on the search API.

## Files Changed
- `hub/lib/vertex.ts` — Commented out queryExpansionSpec and spellCorrectionSpec.

## Tags
#memory #rxfit #fix
