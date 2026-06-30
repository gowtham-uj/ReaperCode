import json, os, time, urllib.request

api_key = os.environ.get('MINIMAX_API_KEY')
url = 'https://api.minimax.io/v1/chat/completions'
base_prompt = 'Return JSON with exactly this shape: {"steps":[{"id":"s1","title":"t","instructions":"i","successCriteria":["c"],"tool_calls":[]}],"testGuidance":"run tests","installs":[]}.'
large_prompt = base_prompt + '\nContext:\n' + ('Build a full stack task management app. ' * 2000)

for name, stream, prompt in [
    ('small-nonstream', False, base_prompt),
    ('small-stream', True, base_prompt),
    ('large-nonstream', False, large_prompt),
    ('large-stream', True, large_prompt),
]:
    body = {
        'model': 'MiniMax-M3',
        'messages': [{'role': 'user', 'content': prompt}],
        'max_tokens': 8192,
        'response_format': {'type': 'json_object'},
    }
    if stream:
        body['stream'] = True
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}, method='POST')
    start=time.time(); first=None; total_bytes=0; status=None
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            status=res.status
            while True:
                chunk=res.read(4096)
                if not chunk: break
                total_bytes += len(chunk)
                if first is None: first=time.time()-start
                if not stream and total_bytes>0:
                    # continue reading whole body
                    pass
    except Exception as e:
        print(json.dumps({'case':name,'error':type(e).__name__+': '+str(e),'elapsed_s':round(time.time()-start,3),'first_s': None if first is None else round(first,3)}), flush=True)
        continue
    print(json.dumps({'case':name,'status':status,'prompt_chars':len(prompt),'elapsed_s':round(time.time()-start,3),'first_s': None if first is None else round(first,3),'bytes':total_bytes}), flush=True)
