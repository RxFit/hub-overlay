#!/usr/bin/env python3
"""Generate a Gamma presentation from a storyline/content file."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests


BASE_URL = "https://public-api.gamma.app/v1.0"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Gamma presentation from a file")
    parser.add_argument("--input-file", required=True, help="Path to file containing storyline/content")
    parser.add_argument("--theme", default=None, help="Gamma theme ID/name, if enabled for your account")
    parser.add_argument("--slides", type=int, help="Number of slides/cards; auto if omitted")
    parser.add_argument("--output", default=None, help="Output PPTX filename; defaults to <input>.pptx")
    parser.add_argument("--tone", default="professional", help="Presentation tone")
    parser.add_argument("--audience", default="executives", help="Target audience")
    parser.add_argument(
        "--text-mode",
        default="preserve",
        choices=["preserve", "generate", "condense"],
        help="How Gamma should process source text",
    )
    parser.add_argument(
        "--image-style",
        default="professional, clean, business",
        help="AI image style description",
    )
    parser.add_argument("--poll-interval", type=int, default=5, help="Seconds between status checks")
    parser.add_argument("--max-polls", type=int, default=60, help="Maximum status checks before timeout")
    return parser.parse_args()


def read_input(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"Input file not found: {path}")
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError(f"Input file is empty: {path}")
    return text


def build_payload(args: argparse.Namespace, input_text: str) -> dict:
    payload = {
        "inputText": input_text,
        "textMode": args.text_mode,
        "format": "presentation",
        "exportAs": "pptx",
        "textOptions": {
            "amount": "medium",
            "tone": args.tone,
            "audience": args.audience,
            "language": "en",
        },
        "imageOptions": {
            "source": "aiGenerated",
            "model": "flux-1-pro",
            "style": args.image_style,
        },
    }
    if args.theme:
        payload["themeId"] = args.theme
    if args.slides:
        payload["numCards"] = args.slides
    return payload


def api_headers(api_key: str) -> dict:
    return {
        "Content-Type": "application/json",
        "X-API-KEY": api_key,
    }


def create_generation(api_key: str, payload: dict) -> str:
    response = requests.post(
        f"{BASE_URL}/generations",
        headers=api_headers(api_key),
        json=payload,
        timeout=60,
    )
    response.raise_for_status()
    result = response.json()
    return result["generationId"]


def poll_generation(api_key: str, generation_id: str, poll_interval: int, max_polls: int) -> dict:
    for poll_count in range(1, max_polls + 1):
        response = requests.get(
            f"{BASE_URL}/generations/{generation_id}",
            headers={"X-API-KEY": api_key},
            timeout=60,
        )
        response.raise_for_status()
        status = response.json()

        if status["status"] in {"completed", "failed"}:
            return status

        print(f"Still generating... ({poll_count * poll_interval}s elapsed)", end="\r")
        time.sleep(poll_interval)

    raise TimeoutError(f"Generation took too long. Generation ID: {generation_id}")


def download_pptx(export_url: str, output_path: Path) -> None:
    response = requests.get(export_url, timeout=120)
    response.raise_for_status()
    output_path.write_bytes(response.content)


def main() -> int:
    args = parse_args()

    api_key = os.getenv("GAMMA_API_KEY")
    if not api_key:
        print("Error: GAMMA_API_KEY environment variable is required.", file=sys.stderr)
        print("Create a Gamma API key in Gamma settings, then export it before running.", file=sys.stderr)
        return 1

    input_path = Path(args.input_file)
    output_path = Path(args.output) if args.output else input_path.with_suffix(".pptx")

    try:
        input_text = read_input(input_path)
        payload = build_payload(args, input_text)

        print("Creating Gamma presentation...")
        print(f"Input file: {input_path}")
        print(f"Content: {len(input_text)} characters")
        print(f"Theme: {args.theme or 'default'}")
        print(f"Text mode: {args.text_mode}")
        print(f"Image style: {args.image_style}")
        print(f"Slides: {args.slides or 'auto'}")

        generation_id = create_generation(api_key, payload)
        print(f"Generation started: {generation_id}")

        status = poll_generation(api_key, generation_id, args.poll_interval, args.max_polls)
        if status["status"] == "failed":
            print("Generation failed.")
            print(json.dumps(status, indent=2))
            return 1

        print("\nPresentation is ready.")
        print(f"Gamma URL: {status.get('gammaUrl', 'not returned')}")

        credits = status.get("credits")
        if credits:
            print(f"Credits used: {credits.get('deducted', 'unknown')}")
            print(f"Credits remaining: {credits.get('remaining', 'unknown')}")

        export_url = status.get("exportUrl")
        if export_url:
            download_pptx(export_url, output_path)
            print(f"Local PPTX: {output_path}")
        else:
            print("No exportUrl returned. Use the Gamma URL to access the deck.")

        return 0
    except (OSError, ValueError, KeyError, TimeoutError, requests.RequestException) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
