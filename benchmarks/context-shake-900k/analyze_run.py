#!/usr/bin/env python3
import json, sys
from pathlib import Path
if len(sys.argv) != 2:
    print('usage: analyze_run.py <run_dir>')
    sys.exit(2)
run_dir = Path(sys.argv[1])
traj = run_dir / 'logs' / 'reaper-trajectory.jsonl'
shakes=[]; tools=0; failed=0
if traj.exists():
    for line in traj.read_text().splitlines():
        try: d=json.loads(line)
        except Exception: continue
        if d.get('kind') == 'tool_call':
            tools += 1
            if d.get('status') == 'failed': failed += 1
        if d.get('kind') == 'context_shake': shakes.append(d)
print('run_dir', run_dir)
print('tool_calls', tools)
print('failed_tool_calls', failed)
print('shake_events', len(shakes))
print('total_shaken_results', sum(s.get('shaken_results',0) for s in shakes))
print('total_saved_chars', sum(s.get('saved_chars',0) for s in shakes))
print('total_saved_tokens_est', sum(s.get('saved_chars',0) for s in shakes)//4)
for i,s in enumerate(shakes[:20],1):
    print(f'shake {i}: results={s.get("shaken_results")} saved_chars={s.get("saved_chars")}')
mc_dir = run_dir / 'model-calls'
mc = sorted(mc_dir.glob('*.json')) if mc_dir.exists() else []
print('model_calls', len(mc))
if mc:
    seen=set()
    sample = list(range(0, len(mc), max(1, len(mc)//10))) + [len(mc)-1]
    for idx in sample:
        if idx in seen: continue
        seen.add(idx)
        p=mc[idx]
        d=json.loads(p.read_text())
        msgs=d.get('request',{}).get('messages',[])
        chars=sum(len(str(m.get('content',''))) for m in msgs)
        tool_chars=sum(len(str(m.get('content',''))) for m in msgs if m.get('role')=='tool')
        placeholders=sum(1 for m in msgs if m.get('role')=='tool' and str(m.get('content','')).startswith('['))
        print(p.name, 'msgs', len(msgs), 'chars', chars, 'tok_est', chars//4, 'tool_chars', tool_chars, 'placeholders', placeholders)
summary = run_dir.parents[1] / 'benchmark-output' / 'context-shake-summary.json'
print('summary_exists', summary.exists())
if summary.exists():
    data=json.loads(summary.read_text())
    print('summary_files_read', data.get('files_read'))
    print('summary_facts', len(data.get('facts',[])))
