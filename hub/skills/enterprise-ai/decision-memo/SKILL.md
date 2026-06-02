---
name: decision-memo
version: 0.1.0
description: |
  `/decision-memo` drafts a 1-page decision memo that forces a yes/no call:
  context, complication, options, recommendation, risks, and ask.
allowed-tools:
  - Read
  - AskUserQuestion
---

# /decision-memo

## Inputs

Ask for missing decision-critical inputs:

- Reader and decision owner
- Decision needed and deadline
- 2-3 real options
- Preferred recommendation, if any
- Evidence: numbers, quotes, dates, constraints

## Output

Draft a memo with:

1. Title under 10 words, naming the decision
2. Context
3. Complication
4. Options
5. Recommendation
6. Risks and mitigations
7. The Ask: one yes/no line with owner and date
8. Memo DNA check

## Process

1. Interview before drafting if core inputs are missing.
2. Keep the memo around 400 words.
3. Make options mutually exclusive.
4. Support claims with evidence or mark assumptions.
5. End with a concrete yes/no ask.

## References

Read `references/memo-dna.md` for full examples, anti-patterns, or when revising a high-stakes memo.
