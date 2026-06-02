---
name: scpr
version: 0.1.0
description: |
  `/scpr` structures business arguments using Situation, Complication, Problem,
  Recommendation. Use for executive summaries, strategy framing, memo structure,
  and turning messy context into a clear recommendation.
allowed-tools:
  - Read
  - AskUserQuestion
---

# /scpr

## Inputs

Ask for any missing essentials:

- Situation: stable current state and baseline facts
- Complication: what changed and why it matters now
- Problem: the specific question to answer
- Recommendation: proposed action, owner, and timing

## Output

Return:

1. `Situation` - essential context only
2. `Complication` - recent change or pressure
3. `Problem` - one specific, answerable question
4. `Recommendation` - 2-4 MECE actions with timing
5. `Sharpness check` - what is weak, missing, or assumed

## Process

1. Extract facts into S/C/P/R.
2. Rewrite the Problem as a crisp question.
3. Make Recommendations MECE and time-bound.
4. Flag missing numbers or evidence.

## References

Read `references/framework.md` only if the user asks for the full framework, examples, or a deeper critique.
