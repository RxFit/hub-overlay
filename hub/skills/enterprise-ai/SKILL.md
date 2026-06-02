---
name: enterprise-ai
version: 0.1.0
description: |
  Antigravity-native suite of consulting, PM, strategy, prioritization, deck,
  and meeting-prep workflows. Use `/enterprise-ai` to route ambiguous business
  requests, or call a specific command such as `/decision-memo`, `/storyline`,
  `/prioritize`, `/mckinsey-critic`, `/data-insights`, or `/gamma-deck`.
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
---

# Enterprise AI

Use this suite when the user needs structured business thinking, executive communication, roadmap prioritization, meeting prep, deck narratives, document critique, or lightweight data/deck automation.

## Commands

| Command | Use when the user needs |
|---|---|
| `/scpr` | Situation, Complication, Problem, Recommendation structure |
| `/issue-tree` | MECE problem decomposition and hypotheses |
| `/decision-memo` | A 1-page yes/no decision memo |
| `/storyline` | Claim-based slide titles and deck flow |
| `/prioritize` | RICE, impact/effort, value/complexity, or weighted scoring |
| `/meeting-prep` | Pre-read, agenda, talking points, objections, rebuttals |
| `/ai-use-case-score` | Personal AI use-case scoring on Value x Feasibility x Safety |
| `/mckinsey-critic` | Consulting-style review of a deck, memo, or strategy |
| `/deck-pipeline` | Strategist -> builder -> critic -> fixer deck workflow |
| `/data-insights` | CSV/Excel analysis with plain-English insights |
| `/gamma-deck` | Gamma API deck generation from a storyline |

## Routing

If the user invokes `/enterprise-ai`, choose the smallest relevant command:

- "Structure this argument" -> `/scpr`
- "Break down this problem" -> `/issue-tree`
- "Help me get approval" -> `/decision-memo` or `/meeting-prep`
- "Make this into slides" -> `/storyline`, then `/deck-pipeline` if they want a fuller draft/review loop
- "Rank these features" -> `/prioritize`
- "What should I AI-ify?" -> `/ai-use-case-score`
- "Review this before I send it" -> `/mckinsey-critic`
- "Analyze this file" -> `/data-insights`
- "Generate a PPTX" -> `/gamma-deck`

## Token Discipline

Read only the specific sub-skill `SKILL.md` needed for the user's request. Do not load full references unless the sub-skill says to, the user asks for explanation, or output quality depends on an example/rubric.

## Guardrails

- Ask for missing decision-critical inputs before drafting.
- Keep outputs decision-oriented and concise.
- Make assumptions explicit when data is missing.
- Do not invent sources or benchmarks; label estimates as estimates.
