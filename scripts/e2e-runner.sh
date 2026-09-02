#!/bin/bash
# E2E runner: sends each question to the openclaw agent, collects replies.
# Runs on the Mac host; writes answers next to the openclaw data dir.
OUT=/Users/xiang/dockers/openclaw_xiang/data/e2e-answers.md
C=openclaw_xiang-openclaw-gateway-1
N=0
while IFS= read -r q; do
  N=$((N+1))
  echo "" >> "$OUT"
  echo "────────────────────────────────" >> "$OUT"
  echo "### Q$N: $q" >> "$OUT"
  echo "时间: $(date -u +%H:%M:%SZ)" >> "$OUT"
  docker exec $C openclaw agent --agent main --session-key agent:main:e2e-dota --message "$q" --json 2>/dev/null \
    | python3 -c '
import json,sys
try:
  d=json.load(sys.stdin)
  texts=[p.get("text","") for p in d.get("result",{}).get("payloads",[])]
  print(("\n".join(t for t in texts if t)) or json.dumps(d)[:500])
except Exception as e:
  print("PARSE_ERROR", e)
' >> "$OUT"
  echo "Q$N done $(date -u +%H:%M:%SZ)" >&2
  sleep 2
done < /Users/xiang/dockers/openclaw_xiang/data/e2e-questions.txt
echo "ALL_DONE" >&2
