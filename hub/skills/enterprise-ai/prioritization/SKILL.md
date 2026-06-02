---
name: prioritization
version: 0.1.0
description: |
  `/prioritize` scores features, initiatives, or tasks using RICE,
  impact/effort, value/complexity, or weighted scoring. Use for roadmap,
  sprint, and resource trade-off decisions.
allowed-tools:
  - Read
  - AskUserQuestion
---

# /prioritize

## Inputs

Ask for:

- Items to prioritize
- Goal or decision context
- Available data: reach, impact, confidence, effort, revenue, risk
- Preferred framework, if any
- Time horizon and constraints

## Output

Return:

1. Recommended framework and why
2. Scored table
3. Ranked recommendation
4. Assumptions to validate
5. What to defer or avoid

## Process

1. Choose the lightest framework that fits available data.
2. If data is missing, ask targeted questions or provide labeled estimates.
3. Use consistent scoring across all items.
4. Explain ranking changes driven by confidence or effort.

## References

Read `references/frameworks.md` for full scoring tables, examples, or framework selection detail.
