---
name: data-insights
version: 0.1.0
description: |
  `/data-insights` analyzes CSV or Excel data and produces plain-English
  insights. Use when the user wants quick answers about targets, trends,
  anomalies, segments, top/bottom performers, averages, and totals.
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
---

# /data-insights

## Inputs

Ask for a CSV or Excel file path if none is provided. Confirm the target column only if it is ambiguous.

## Output

The script creates a 3-tab Excel output:

1. Summary
2. Full Analysis
3. Raw Data

Also summarize the most important findings in the chat.

## Process

1. Install dependencies from `scripts/requirements.txt` if needed.
2. Run `python scripts/analyze_data.py <file>`.
3. Report the output file path and 3-5 key insights.

## References

Read `references/framework.md` for the full analysis behavior and expected output.
