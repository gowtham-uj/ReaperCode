#!/usr/bin/env python3
from pathlib import Path
import json,re

RUN='2026-06-23T18-56-50-768Z-5c4068a8'
log=Path(f'/workspace/reaper_eval/workspaces/initial-task-1/{RUN}/.reaper/logs/langfuse-events.jsonl')
events=[json.loads(l) for l in log.read_text(errors='ignore').splitlines() if l.strip().startswith('{')] if log.exists() else []
mr=[e for e in events if e.get('name')=='reaper.model_request']
big=[e for e in mr if (e.get('metadata') or {}).get('promptChars',0) > 80000]
e = big[0]
content = e.get('input', {}).get('prompt', '')
# Print Feedback and PatchRequest sections
for sec_name in ['Feedback', 'Parent PatchRequest', 'Reaper Optimization Frame']:
    m = re.search(rf'# {sec_name}\n(.*?)(?=\n# |\Z)', content, re.DOTALL)
    if m:
        sec = m.group(1)
        print(f"\n=== {sec_name} ({len(sec)} chars) ===")
        print(sec[:2500])
        if len(sec) > 2500:
            print(f"... ({len(sec)-2500} more chars)")
        print()