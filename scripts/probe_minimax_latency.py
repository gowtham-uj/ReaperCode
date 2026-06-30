import json, os, time, urllib.request, urllib.error

api_key = os.environ.get('MINIMAX_API_KEY')
if not api_key:
    raise SystemExit('MINIMAX_API_KEY missing')
url = 'https://api.minimax.io/v1/chat/completions'

cases = [
    ('plain-64', {
        'model': 'MiniMax-M3',
        'messages': [{'role': 'user', 'content': 'Reply PONG only.'}],
        'max_tokens': 64,
    }),
    ('json-64', {
        'model': 'MiniMax-M3',
        'messages': [{'role': 'user', 'content': 'Return JSON exactly: {"ok": true}'}],
        'max_tokens': 64,
        'response_format': {'type': 'json_object'},
    }),
    ('json-1024', {
        'model': 'MiniMax-M3',
        'messages': [{'role': 'user', 'content': 'Return JSON exactly: {"ok": true, "items": [1,2,3]}'}],
        'max_tokens': 1024,
        'response_format': {'type': 'json_object'},
    }),
    ('json-8192', {
        'model': 'MiniMax-M3',
        'messages': [{'role': 'user', 'content': 'Return JSON exactly: {"ok": true, "items": [1,2,3]}'}],
        'max_tokens': 8192,
        'response_format': {'type': 'json_object'},
    }),
]

for name, body in cases:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        method='POST',
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            text = res.read().decode('utf-8', errors='replace')
            status = res.status
    except urllib.error.HTTPError as e:
        text = e.read().decode('utf-8', errors='replace')
        status = e.code
    except Exception as e:
        print(name, 'ERROR', type(e).__name__, str(e), 'elapsed', round(time.time() - start, 3), flush=True)
        continue
    elapsed = time.time() - start
    try:
        parsed = json.loads(text)
        choice = (parsed.get('choices') or [{}])[0]
        msg = choice.get('message') or {}
        content = msg.get('content') or ''
        usage = parsed.get('usage')
        finish = choice.get('finish_reason')
    except Exception:
        content = text[:300]
        usage = None
        finish = None
    print(json.dumps({
        'case': name,
        'status': status,
        'elapsed_s': round(elapsed, 3),
        'finish': finish,
        'usage': usage,
        'content_prefix': content[:180],
    }, ensure_ascii=False), flush=True)
