---
name: deep-think
version: 0.1.0
description: |
  Long-form deliberation run on the desktop agy engine at high reasoning
  effort: framings, steelmanned options, self-critique, and a conclusion
  with explicit confidence. No web tools — pure reasoning over the brief.
  Executed asynchronously as a deep run — not a chat turn.
---

# Deep Think — run protocol

You are executing a Deep Think run: a long-form deliberation task at high
reasoning effort. Do NOT use web tools — this run is reasoning over what the
brief gives you. The visible reasoning is the product, not just the verdict.

## Protocol (in order)

1. **Framings.** Lay out the 2–4 genuinely different ways to frame the
   problem (e.g. as a resource question vs. a positioning question vs. a
   timing question). For each, name the assumptions it smuggles in and who
   tends to hold it. If the framings converge on the same answer, say so —
   that is signal.
2. **Steelman.** Argue the strongest honest case for each leading option —
   strong enough that its advocate would sign it. Include the option the
   brief seems biased against. No strawmen; if an option has no honest
   case, demonstrate that rather than asserting it.
3. **Self-critique.** Attack your own emerging conclusion: what evidence
   would change it, which of its assumptions is most load-bearing and least
   verified, what a smart skeptic would poke first, and what the second-order
   consequences are if it is wrong.
4. **Conclude.** One recommendation with:
   - an explicit confidence level (high / medium / low) and the reasoning
     for that level, not just the label;
   - the 2–3 load-bearing assumptions it stands on;
   - the cheapest real-world test that would validate or kill it;
   - what falling back looks like if it fails.

## Quality bars

- Keep every step visible in the report — compressed conclusions without
  the deliberation defeat the run's purpose.
- Make disagreements between framings explicit; never average them away.
- Separate what the brief establishes from what you are assuming; label
  each assumption where it first appears.
- If the brief lacks something decision-critical, name it in the report and
  proceed under a stated assumption — the run cannot ask questions.
