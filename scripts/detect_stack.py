#!/usr/bin/env python3
"""Compatibility wrapper around the canonical evidence-based Node detector."""

import json
from pathlib import Path
import subprocess
import sys


def main() -> int:
    root = Path.cwd()
    cli = Path(__file__).parents[1] / "cli" / "bin" / "infra.js"
    result = subprocess.run(
        ["node", str(cli), "detect", "--project", str(root), "--json"],
        shell=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=60,
    )
    if result.returncode not in (0, 4):
        print(json.dumps({"stack": [], "error": result.stderr.strip() or "detector failed"}, ensure_ascii=False, indent=2))
        return 1
    envelope = json.loads(result.stdout)
    details = envelope.get("data", {})
    families = sorted({component.get("family") for component in details.get("components", []) if component.get("family")})
    print(json.dumps({"stack": families, "details": details}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
