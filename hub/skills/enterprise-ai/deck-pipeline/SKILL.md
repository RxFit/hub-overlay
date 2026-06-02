---
name: deck-pipeline
version: 0.1.0
description: |
  `/deck-pipeline` runs a four-step presentation workflow: strategist, builder,
  critic, fixer. Use for high-stakes decks that need narrative structure and a
  critique pass.
allowed-tools:
  - Read
  - AskUserQuestion
---

# /deck-pipeline

## Inputs

Ask for:

- Topic
- Audience
- Desired decision or takeaway
- Known evidence
- Target length and format

## Output

Return:

1. Strategist: audience, governing thought, outline
2. Builder: slide-by-slide draft with body points and visual suggestions
3. Critic: grade and top 3 fixes
4. Fixer: revised slide titles and content changes

## Process

1. Do not build slides until the governing thought is clear.
2. Make every slide title a claim.
3. Run a critic pass before finalizing.
4. Apply only the top fixes that materially improve the deck.

## References

Read `references/agent-flow.md` for the full four-agent workflow and detailed stage expectations.
