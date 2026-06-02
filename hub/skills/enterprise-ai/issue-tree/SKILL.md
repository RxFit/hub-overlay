---
name: issue-tree
version: 0.1.0
description: |
  `/issue-tree` breaks a complex problem into MECE branches and testable
  hypotheses. Use before analysis, work planning, strategy decomposition, or
  case-style problem solving.
allowed-tools:
  - Read
  - AskUserQuestion
---

# /issue-tree

## Inputs

Ask for:

- Governing question
- Target metric or decision
- Known constraints
- Any existing hypotheses or data

## Output

Return:

1. Governing question
2. 3-5 Level 1 branches
3. 2-3 testable hypotheses under each branch
4. MECE check
5. Recommended first branch to analyze and why

## Process

1. Tighten the governing question.
2. Decompose to fundamentals, not actions.
3. Keep the tree two levels deep unless the user asks otherwise.
4. Make terminal leaves testable with data.
5. Prioritize the starting point by impact, effort, and confidence.

## References

Read `references/framework.md` when the user needs examples, visual tree patterns, or a full issue-tree explanation.
