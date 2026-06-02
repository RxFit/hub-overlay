---
name: storyline
version: 0.1.0
description: |
  `/storyline` creates a claim-based presentation storyline where each line can
  become a slide title. Use for decks, board updates, pitches, and strategic
  presentations.
allowed-tools:
  - Read
  - AskUserQuestion
---

# /storyline

## Inputs

Ask for:

- Audience
- Desired decision or takeaway
- Topic and context
- Known data points
- Target slide count, if any

## Output

Return:

1. Audience and governing thought
2. Narrative blocks: Situation, Complication, Resolution
3. Numbered slide-title storyline
4. Evidence needed per slide
5. Weak spots or missing data

## Process

1. Define the governing thought first.
2. Write each slide title as a claim, not a topic label.
3. Make the title trail readable as the full argument.
4. Keep each slide doing one job.

## References

Read `references/templates.md` when selecting a template, calibrating slide flow, or building a longer deck.
