# Vertex AI vs pgvector Architecture Analysis

## Metadata
| Key | Value |
|-----|-------|
| Date | 2026-06-07T14:55:01-05:00 |
| Workspace | vibrant-chandrasekhar |
| Conversation | 26bfbe50 |
| Type | research |

## Summary
Executed an architecture analysis via `/rxharden` protocol to determine why both Vertex AI semantic search and `pgvector` were implemented. Found that they were originally built to serve different scopes (broad knowledge vs Obsidian-style targeted memory), but Vertex AI has since been deprecated to prevent "dual truth confusion".

## Key Decisions
- Queried local `Memory/tasks` as the Vertex AI MCP (`vertex-ai-search`) failed with a network resolution error.
- Verified that `pgvector` is now the single source of truth for the system's memory vault.

## Files Changed
- N/A (Research only)

## Tags
#memory #vibrant-chandrasekhar #research #vertex-ai #pgvector #architecture
