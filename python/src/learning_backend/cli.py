from __future__ import annotations

import argparse
import json
from pathlib import Path


def ingest(input_path: Path, output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    suffix = input_path.suffix.lower()
    if suffix == ".pdf":
        quality = {
            "status": "warning",
            "warnings": ["PDF extraction is scaffolded in this MVP; wire PyMuPDF text-layer extraction next."],
        }
        chunks = []
        method = "pending-pdf-text-layer"
    else:
        text = input_path.read_text(encoding="utf-8")
        chunks = [
            {
                "id": f"{input_path.stem}-chunk-001",
                "headingPath": [input_path.stem],
                "locator": "document",
                "kind": "body",
                "text": text[:4000],
                "confidence": 0.9,
            }
        ]
        quality = {"status": "good", "warnings": []}
        method = "python-text-ingest"

    manifest = {
        "id": input_path.stem,
        "title": input_path.stem,
        "sourceType": "pdf" if suffix == ".pdf" else "markdown" if suffix in {".md", ".markdown"} else "text",
        "extractionMethod": method,
        "quality": quality,
    }
    manifest_path = output_dir / "source_manifest.json"
    chunks_path = output_dir / "source_chunks.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    chunks_path.write_text(json.dumps(chunks, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "manifestPath": str(manifest_path), "chunksPath": str(chunks_path), "quality": quality}


def main() -> None:
    parser = argparse.ArgumentParser(prog="learning_backend")
    sub = parser.add_subparsers(dest="command", required=True)
    ingest_parser = sub.add_parser("ingest")
    ingest_parser.add_argument("--input", required=True)
    ingest_parser.add_argument("--output", required=True)
    args = parser.parse_args()

    if args.command == "ingest":
        print(json.dumps(ingest(Path(args.input), Path(args.output)), ensure_ascii=False))


if __name__ == "__main__":
    main()
