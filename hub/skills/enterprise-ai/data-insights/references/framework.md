---
name: data-insights
description: Analyzes data and answers 7 key questions in plain English
---

# Data Insights Skill

## Description

Upload any CSV or Excel file with your data. Get answers to 7 key questions in plain English.

No formulas. No jargon. Just clear insights you can act on.

## What It Does

Answers these 7 questions:

1. **Did you hit your targets?** - Compares actual vs goal (if you have Target/Goal columns)
2. **What's the trend?** - Going up or down from start to finish
3. **Any unusual spikes or drops?** - Flags changes >30%
4. **Which segments perform best?** - Compares groups (regions, products, etc.)
5. **Who are the top/bottom performers?** - Shows top 25% vs bottom 25%
6. **What's typical?** - Simple averages
7. **What's the total?** - Overall numbers

Everything in plain English. No statistics terminology.

## Output

Clean 3-tab Excel file:

1. **Summary** - 3-5 key bullets + one action
2. **Full Analysis** - All 7 analyses with supporting tables
3. **Raw Data** - Your original data

## Usage

```bash
python scripts/analyze_data.py your_file.csv
```

Or just upload your CSV/Excel and say "analyze this data"

## Example

Input: Health tracker data (exercise minutes, calories, heart rate)

Executive Summary:
- ✅ Duration_min: Beat target by 39%
- 📈 Trending up: Increased 33% from start to end
- 🏆 Best segment: Cycling (total: 130)
- 💡 Action: Sustain current momentum

## What It Handles

- CSV and Excel files
- Messy data (duplicates, currency symbols, percentages)
- Any business metrics (sales, revenue, NPS, customers, etc.)
- Any personal data (fitness, habits, budgets, etc.)

Built for anyone who needs quick insights without being a data scientist.
