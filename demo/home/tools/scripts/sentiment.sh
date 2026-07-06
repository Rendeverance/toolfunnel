#!/usr/bin/env bash
# sentiment.sh - crude positive/negative word tally. Args arrive as JSON in
# TOOLFUNNEL_TOOL_ARGS; the result is one JSON object on stdout.
set -euo pipefail
text=$(printf '%s' "${TOOLFUNNEL_TOOL_ARGS:-{}}" | tr '[:upper:]' '[:lower:]')
pos=$(printf '%s' "$text" | grep -o -E 'good|great|love|excellent|happy|nice' | wc -l | tr -d ' ')
neg=$(printf '%s' "$text" | grep -o -E 'bad|awful|hate|terrible|sad|broken' | wc -l | tr -d ' ')
if [ "$pos" -gt "$neg" ]; then verdict=positive; elif [ "$neg" -gt "$pos" ]; then verdict=negative; else verdict=neutral; fi
printf '{"positive":%s,"negative":%s,"verdict":"%s"}\n' "$pos" "$neg" "$verdict"
