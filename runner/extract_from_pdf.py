#!/usr/bin/env python3
"""
extract_from_pdf.py
-------------------
Bootstraps the prompt + schema files the runner expects, straight from the
Inkling spec PDF — so you never copy-paste a prompt by hand.

It pulls every fenced code block out of the PDF text, classifies each as a
PROMPT (contains <task>) or a SCHEMA (parses as JSON), and writes them to the
paths named in spec/pipeline.json. Run once to seed; Codex then verifies each
file against the PDF per the /goal.

Usage:
    python runner/extract_from_pdf.py \
        --pdf docs/Inkling-Prompt-and-Model-Engineering-Spec.pdf \
        --spec spec/pipeline.json
"""
import argparse, json, re, sys
from pathlib import Path

def pdf_text(path: Path) -> str:
    try:
        import pdfplumber
    except ImportError:
        sys.exit("pip install pdfplumber")
    with pdfplumber.open(path) as pdf:
        return "\n".join(p.extract_text() or "" for p in pdf.pages)

def code_blocks(text: str):
    """Yield candidate code blocks. PDF text has no ``` fences, so we segment
    on prompt/schema signatures used in the doc."""
    # Prompts always contain a <task> ... block; schemas start with '{' and 'name'/'schema'.
    # Split on the call headers (e.g. 'P2 — GameSpec Extraction') to scope each block.
    sections = re.split(r"\n(?=P\d+[\w_]*\s*[—-])", text)
    for sec in sections:
        header = re.match(r"(P\d+[\w_]*)", sec)
        cid = header.group(1) if header else None
        # prompt block
        for m in re.finditer(r"(<task>.*?</success_criteria>|<task>.*?</constraints>|<task>.*?</mapping>)",
                             sec, re.S):
            yield ("prompt", cid, m.group(1).strip())
        # schema / json block
        for m in re.finditer(r"(\{[\s\S]*?\"strict\"\s*:\s*true[\s\S]*?\})", sec):
            yield ("schema", cid, m.group(1).strip())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--spec", required=True)
    args = ap.parse_args()

    spec = json.loads(Path(args.spec).read_text())
    root = Path(args.spec).parent.parent
    by_id = {c["id"]: c for c in spec["calls"]}

    text = pdf_text(Path(args.pdf))
    written = []
    for kind, cid, body in code_blocks(text):
        if not cid or cid not in by_id:
            continue
        call = by_id[cid]
        target = call["prompt"] if kind == "prompt" else call.get("schema")
        if not target:
            continue
        out = root / target
        out.parent.mkdir(parents=True, exist_ok=True)
        if kind == "schema":
            try:
                body = json.dumps(json.loads(body), indent=2)  # normalize
            except json.JSONDecodeError:
                pass
        out.write_text(body + "\n")
        written.append(str(target))

    print(f"Wrote {len(written)} files:")
    for w in sorted(set(written)):
        print("  ", w)
    missing = [c["id"] for c in spec["calls"]
               if not (root / c["prompt"]).exists()]
    if missing:
        print("\n⚠ No prompt extracted for:", ", ".join(missing),
              "\n  -> copy these blocks from the PDF section manually, "
              "then re-run the verifier.")

if __name__ == "__main__":
    main()
