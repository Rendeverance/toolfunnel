#!/usr/bin/env python3
"""summarize.py - first-sentence summary + word count. Args arrive as JSON in
TOOLFUNNEL_TOOL_ARGS; the result is one JSON object on stdout."""
import json
import os
import re

args = json.loads(os.environ.get("TOOLFUNNEL_TOOL_ARGS") or "{}") or {}
text = str(args.get("text", "")).strip()
first = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)[0] if text else ""
print(json.dumps({"summary": first, "words": len(text.split())}))
