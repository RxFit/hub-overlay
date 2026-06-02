# Gamma Deck Workflow

Use `/gamma-deck` after `/storyline` when the user wants to turn a storyline or content file into a Gamma presentation and exported PPTX.

## Prerequisites

1. Gamma account with API access.
2. `GAMMA_API_KEY` set in the shell environment.
3. Python dependencies installed:

```bash
pip install -r antigravity/enterprise-ai/gamma-deck/scripts/requirements.txt
```

## Basic Usage

```bash
python antigravity/enterprise-ai/gamma-deck/scripts/gamma_deck_generator.py \
  --input-file storyline.txt
```

## Advanced Usage

```bash
python antigravity/enterprise-ai/gamma-deck/scripts/gamma_deck_generator.py \
  --input-file storyline.txt \
  --theme Chisel \
  --output pitch_deck.pptx \
  --tone "professional, strategic" \
  --audience "executives, investors" \
  --image-style "minimalist, charts and graphs, clean"
```

## Options

| Option | Description |
|---|---|
| `--input-file` | Required storyline/content file |
| `--output` | Output PPTX filename |
| `--theme` | Gamma theme ID/name, if supported |
| `--slides` | Number of slides/cards |
| `--tone` | Presentation tone |
| `--audience` | Target audience |
| `--text-mode` | `preserve`, `generate`, or `condense` |
| `--image-style` | AI image style |

## Recommended Flow

1. Use `/storyline` to create claim-based slide titles.
2. Save the storyline to a text file.
3. Run `/gamma-deck` with that file.
4. Return the Gamma URL and local PPTX path to the user.

## Security

Never write API keys into scripts or docs. Require `GAMMA_API_KEY` from the environment.
