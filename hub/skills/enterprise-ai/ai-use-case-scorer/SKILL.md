---
name: ai-use-case-scorer
version: 0.1.0
description: |
  `/ai-use-case-score` scores personal AI use cases on Value x Feasibility x
  Safety and tiers them into Do Now, Do This Quarter, Park, or Avoid.
allowed-tools:
  - Read
  - AskUserQuestion
---

# /ai-use-case-score

## Inputs

Ask for:

- Candidate use cases, or the user's recurring workflow
- Personal goals
- Time spent today
- Data sensitivity
- Quality risk if AI is wrong
- Available tools and implementation effort

## Output

Return:

1. Scored table: Value, Feasibility, Safety, final score, tier
2. Top 3 Do Now use cases
3. First step for each Do Now item, doable in under 1 hour
4. Park/Avoid list with revisit triggers

## Process

1. Brainstorm 8-12 candidates if the user gives only a workflow.
2. Score each axis 1-5.
3. Final score = Value x Feasibility x Safety.
4. Prefer practical, this-week automation over speculative builds.

## References

Read `references/scoring-model.md` for the full rubric, examples, and thresholds.
