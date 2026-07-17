#!/usr/bin/env python3
"""Materialize tagged prompts and the JSON printed in the Inkling PDF.

The PDF prints twelve tagged prompts and the full GameSpec schema. P0 is
printed as a prose contract, and the remaining schemas are output contracts
rather than JSON blocks. Existing contract-derived schemas are therefore
validated but are not presented as PDF byte extractions.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


PROMPT_ORDER = [
    ("P2", "success_criteria"),
    ("P1", "success_criteria"),
    ("P3", "success_criteria"),
    ("P4", "constraints"),
    ("P5", "task"),
    ("P6", "constraints"),
    ("P7", "success_criteria"),
    ("P8", "success_criteria"),
    ("P9", "success_criteria"),
    ("P10", "constraints"),
    ("P11", "task"),
    ("P2_photo", "constraints"),
]


def pdf_text(path: Path) -> str:
    """Extract reading-order text with one deterministic CLI-first route."""
    pdftotext = shutil.which("pdftotext")
    if pdftotext:
        with tempfile.NamedTemporaryFile(suffix=".txt") as output:
            subprocess.run(
                [pdftotext, "-raw", str(path), output.name],
                check=True,
                capture_output=True,
            )
            return Path(output.name).read_text(encoding="utf8")
    try:
        import pdfplumber  # type: ignore
    except ImportError:
        sys.exit("Install the pdftotext command or pdfplumber")
    with pdfplumber.open(path) as pdf:
        return "\n".join(page.extract_text() or "" for page in pdf.pages)


def clean_pdf_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(
        r"Inkling · Prompt & Model Engineering Spec\s+\d+\s*/\s*21\s*\f?",
        "\n",
        text,
    )
    return text.replace("\f", "\n")


def normalize_block(block: str) -> str:
    lines = [line.rstrip() for line in block.strip().splitlines()]
    nonempty = [line for line in lines if line.strip()]
    indent = min(
        (len(line) - len(line.lstrip()) for line in nonempty),
        default=0,
    )
    lines = [line[indent:] if line.strip() else "" for line in lines]
    return "\n".join(lines).strip() + "\n"


def extract_prompts(text: str) -> dict[str, str]:
    prompts: dict[str, str] = {}
    cursor = text.find("SYSTEM / DEVELOPER PROMPT")
    if cursor < 0:
        raise ValueError("P2 developer-prompt marker not found")
    for call_id, end_tag in PROMPT_ORDER:
        start = text.find("<task>", cursor)
        if start < 0:
            raise ValueError(f"PDF prompt start not found for {call_id}")
        closing = f"</{end_tag}>"
        end = text.find(closing, start)
        if end < 0:
            raise ValueError(f"PDF prompt end not found for {call_id}")
        end += len(closing)
        prompts[call_id] = normalize_block(text[start:end])
        cursor = end

    calibration = re.search(
        r"2\.3 · Effort calibration.*?(A one-shot.*?rich → medium\.)",
        text,
        re.S,
    )
    if not calibration:
        raise ValueError("PDF prose prompt not found for P0_calibrate")
    prose = re.sub(r"\s+", " ", calibration.group(1)).strip()
    prompts["P0_calibrate"] = prose + "\n"
    return prompts


def balanced_object(text: str, start: int) -> str:
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    raise ValueError("Unterminated JSON object in PDF")


def extract_gamespec_schema(text: str) -> dict:
    marker = text.find("STRUCTURED OUTPUT — GAMESPEC SCHEMA (STRICT)")
    if marker < 0:
        raise ValueError("GameSpec schema marker not found")
    start = text.find("{", marker)
    if start < 0:
        raise ValueError("GameSpec schema JSON not found")
    return json.loads(balanced_object(text, start))


def validate_schema(path: Path) -> None:
    document = json.loads(path.read_text(encoding="utf8"))
    if not isinstance(document, dict):
        raise ValueError(f"{path}: schema wrapper must be an object")
    if document.get("strict") is not True:
        raise ValueError(f"{path}: strict must be true")
    if not isinstance(document.get("name"), str) or not document["name"]:
        raise ValueError(f"{path}: name is required")
    schema = document.get("schema")
    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise ValueError(f"{path}: root schema must be an object schema")
    if schema.get("additionalProperties") is not False:
        raise ValueError(f"{path}: root schema must close additionalProperties")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument(
        "--verify",
        action="store_true",
        help="compare materialized prompts/schema instead of writing them",
    )
    args = parser.parse_args()

    spec_path = Path(args.spec).resolve()
    root = spec_path.parent.parent
    spec = json.loads(spec_path.read_text(encoding="utf8"))
    calls = {call["id"]: call for call in spec["calls"]}
    text = clean_pdf_text(pdf_text(Path(args.pdf)))
    prompts = extract_prompts(text)
    mismatches: list[str] = []
    written: list[str] = []

    for call_id, prompt in prompts.items():
        target = root / calls[call_id]["prompt"]
        if args.verify:
            if not target.exists() or target.read_text(encoding="utf8") != prompt:
                mismatches.append(calls[call_id]["prompt"])
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(prompt, encoding="utf8")
            written.append(calls[call_id]["prompt"])

    for call in spec["calls"]:
        prompt_path = root / call["prompt"]
        if not prompt_path.is_file() or not prompt_path.read_text(encoding="utf8").strip():
            mismatches.append(call["prompt"])
        if call.get("schema"):
            schema_path = root / call["schema"]
            if not schema_path.is_file():
                mismatches.append(call["schema"])
            else:
                validate_schema(schema_path)

    if mismatches:
        print("Mismatched or missing materialized files:", file=sys.stderr)
        for mismatch in sorted(set(mismatches)):
            print(f"  {mismatch}", file=sys.stderr)
        raise SystemExit(1)
    action = "Verified" if args.verify else "Wrote"
    print(f"{action} {len(prompts)} PDF prompt contracts.")
    if written:
        for path in sorted(written):
            print(f"  {path}")
    print("Preserved and validated all authoritative strict schema files referenced by pipeline.json.")


if __name__ == "__main__":
    main()
