---
name: gamma-deck
version: 0.1.0
description: |
  `/gamma-deck` generates a Gamma presentation from a storyline or content file.
  Use after `/storyline` when the user wants a PPTX or Gamma URL.
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
---

# /gamma-deck

## Inputs

Ask for:

- Input storyline/content file
- Output filename, optional
- Theme, optional
- Tone and audience, optional
- Image style, optional

Require `GAMMA_API_KEY` in the environment. Do not ask the user to paste secrets into a file.

## Output

Return:

1. Gamma URL if generated
2. Local PPTX path if exported
3. Any failure reason and next step

## Process

1. Verify `GAMMA_API_KEY` is set.
2. Install dependencies from `scripts/requirements.txt` if needed.
3. Run `python scripts/gamma_deck_generator.py --input-file <file>`.
4. Summarize generated artifacts.

## References

Read `references/gamma-workflow.md` for usage details and `examples/sample_storyline.txt` for sample input.
