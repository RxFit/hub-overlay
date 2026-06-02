---
name: mckinsey-critic
version: 0.1.0
description: |
  `/mckinsey-critic` reviews decks, memos, outlines, and strategies like a
  consulting engagement manager: grade, section issues, top fixes, and what to
  preserve.
allowed-tools:
  - Read
  - AskUserQuestion
---

# /mckinsey-critic

## Inputs

Ask for the document, deck outline, memo, or strategy to review. If audience or goal is missing, ask before grading.

## Output

Return:

1. Grade: Green, Yellow, or Red
2. One-line verdict
3. Section-by-section review table
4. Top 3 fixes ranked by impact
5. One thing that works and should be protected

## Review Criteria

- Structure: argument flow and section order
- Rigor: evidence, numbers, fair comparisons
- So-what: clear takeaway per section
- Completeness: options, owners, dates, risks

## Process

1. Grade against the intended audience and goal.
2. Lead with the highest-impact problems.
3. Make fixes specific enough to execute.
4. Do not rewrite everything unless asked.

## References

Read `references/rubric.md` for full rubric details and common problems.
