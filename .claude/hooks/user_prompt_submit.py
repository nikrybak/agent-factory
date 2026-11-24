#!/usr/bin/env python3
"""UserPromptSubmit routing hints. The keys and messages live in routing_hints.json, shared with dispatch.js."""
import json
import sys
from pathlib import Path


def hints(text):
    """The routing hint lines for the lower-cased payload text."""
    data = json.loads((Path(__file__).resolve().parent / "routing_hints.json").read_text(encoding="utf-8"))
    for hint in data["hints"]:
        if any(key in text for key in hint["keys"]):
            yield hint["message"]


def main():
    # The prompt arrives as UTF-8; Python on Windows would decode stdin as cp1252 and no Russian key would ever match.
    try:
        payload = json.loads(sys.stdin.buffer.read().decode('utf-8', errors='replace'))
    except Exception:
        payload = {}
    for hint in hints(json.dumps(payload, ensure_ascii=False).lower()):
        print(hint)
    return 0


if __name__ == '__main__':
    sys.exit(main())
