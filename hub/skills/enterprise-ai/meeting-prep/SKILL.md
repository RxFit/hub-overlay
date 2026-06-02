---
name: meeting-prep
version: 0.1.0
description: |
  `/meeting-prep` prepares outcome-driven meetings with a 3-bullet pre-read,
  time-boxed agenda, top talking points, and likely objections with rebuttals.
allowed-tools:
  - Read
  - AskUserQuestion
---

# /meeting-prep

## Inputs

Ask for:

- Attendees and roles
- Meeting length
- Topic
- Desired outcome
- What attendees care about
- Evidence, options, or prior alignment

## Output

Return:

1. Pre-read: 3 bullets, each under 30 words
2. Time-boxed agenda
3. Top 3 talking points in spoken language
4. Top 3 objections with owner and rebuttal
5. Final ask

## Process

1. Reverse-engineer from the desired outcome.
2. Reserve decision time at the end.
3. Make talking points speakable.
4. Keep only content that helps win the outcome.

## References

Read `references/playbook.md` when the meeting is high stakes or the user asks for examples.
