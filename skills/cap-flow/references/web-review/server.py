#!/usr/bin/env python3
"""spec-web-review 回收服务器(零依赖) + Live Mode 长轮询。
GET  /            → index.html(批注页)
GET  /rev         → 静态 rev 文件(页面自动刷新轮询用,见 build.py 注入的 poller)
GET  /wait[?t=N]  → 长轮询:挂起请求,直到 POST /feedback 唤醒(回批注 JSON);
                    或 N 秒(默认 540)超时回 204,让 agent re-arm。
POST /feedback    → 写 feedback.json(durable 兜底) + 唤醒挂起的 /wait
用法: python3 server.py [port]
"""
import http.server, os, sys, threading, json
from urllib.parse import urlparse, parse_qs

DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777

_slot = {'data': None}      # 最近一次提交的 body
_event = threading.Event()  # POST /feedback set,/wait 等它
_lock = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIR, **k)

    def _json(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.rstrip('/') == '/wait':
            qs = parse_qs(parsed.query)
            try:
                timeout = float(qs.get('t', ['540'])[0])
            except ValueError:
                timeout = 540.0
            if _event.wait(timeout=timeout):
                with _lock:
                    data = _slot['data'] or b'{}'
                    _slot['data'] = None
                    _event.clear()
                self._json(200, data)           # 释放挂起请求,回批注
            else:
                self.send_response(204)          # 超时 → agent re-arm
                self.end_headers()
        else:
            super().do_GET()                     # index.html / /rev / 其它静态

    def do_POST(self):
        if self.path.rstrip('/') == '/feedback':
            n = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(n)
            with open(os.path.join(DIR, 'feedback.json'), 'wb') as f:
                f.write(body)                    # 仍写盘 = durable / file 兜底(最新一次)
            # 历史保留:每次提交追加一行到 feedback-history.jsonl(不覆盖,多轮可回溯)
            try:
                rec = json.loads(body.decode('utf-8'))
                with open(os.path.join(DIR, 'feedback-history.jsonl'), 'a', encoding='utf-8') as hf:
                    hf.write(json.dumps(rec, ensure_ascii=False) + '\n')
            except (ValueError, OSError):
                pass
            with _lock:
                _slot['data'] = body
                _event.set()                     # 唤醒挂起的 /wait
            self._json(200, b'{"ok":true}')
            print('[feedback] received %d bytes -> feedback.json + released /wait' % len(body))
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, *a):
        pass  # 静默普通请求日志


# 必须多线程:挂起的 /wait 否则会堵死后续 POST /feedback → 死锁
http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler) as httpd:
    print('spec-web-review (live) serving on http://127.0.0.1:%d  (Ctrl+C 停止)' % PORT)
    httpd.serve_forever()
