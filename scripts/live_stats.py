#!/usr/bin/env python3
import re
from pathlib import Path
import json
import os

run = sorted(Path('/workspace/reaper_eval/run_logs/initial-task-1/').iterdir())[-1].name
ws = Path(f'/workspace/reaper_eval/workspaces/initial-task-1/{run}')
plan = ws / '.reaper' / 'PLAN.md'
print(f"run={run}")
if plan.exists():
    text = plan.read_text()
    completed = re.findall(r'\[x\] \d+\.', text)
    current = re.findall(r'\[>\] \d+\.', text)
    pending = re.findall(r'\[ \] \d+\.', text)
    print(f"PLAN.md: completed={len(completed)} current={len(current)} pending={len(pending)}")
log = Path(f'{ws}/.reaper/logs/langfuse-events.jsonl')
if log.exists():
    events = [json.loads(l) for l in log.read_text(errors='ignore').splitlines() if l.strip().startswith('{')]
    mr = [e for e in events if e.get('name') == 'reaper.model_request']
    tc = [e for e in events if e.get('name') == 'reaper.tool_call']
    print(f"model_request={len(mr)} tool_call={len(tc)}")
sm = Path(f'/workspace/reaper_eval/run_logs/initial-task-1/{run}/summary.json')
print(f"summary exists={sm.exists()}")