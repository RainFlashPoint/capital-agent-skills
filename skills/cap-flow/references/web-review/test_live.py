#!/usr/bin/env python3
"""web-review Live Mode 长轮询测试(stdlib only,零依赖)。
跑: python3 test_live.py
验证 server.py 的 /wait 长轮询:① 被 POST 即时释放 ② 不死锁 ③ 超时回 204 ④ submit-before-wait 不丢。
"""
import json, os, socket, subprocess, sys, threading, time, unittest
import urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, 'server.py')


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http_get(url, timeout=20):
    try:
        r = urllib.request.urlopen(url, timeout=timeout)
        return r.getcode(), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def http_post(url, data, timeout=20):
    req = urllib.request.Request(url, data=data, method='POST',
                                 headers={'Content-Type': 'application/json'})
    r = urllib.request.urlopen(req, timeout=timeout)
    return r.getcode(), r.read()


class LiveServer:
    """以子进程起 server.py,退出时清理进程 + feedback.json。"""
    def __enter__(self):
        self.port = free_port()
        self.base = 'http://127.0.0.1:%d' % self.port
        self.proc = subprocess.Popen([sys.executable, SERVER, str(self.port)],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):  # 等起来(GET 一个一定存在的静态文件)
            try:
                urllib.request.urlopen(self.base + '/server.py', timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        return self

    def __exit__(self, *a):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=3)
        except Exception:
            self.proc.kill()
        fb = os.path.join(HERE, 'feedback.json')
        if os.path.exists(fb):
            os.remove(fb)


class TestWaitLongPoll(unittest.TestCase):
    def test_wait_released_by_feedback(self):
        """挂起的 /wait 被 POST /feedback 即时释放,且回的就是提交内容。"""
        with LiveServer() as s:
            out = {}

            def waiter():
                out['code'], out['body'] = http_get(s.base + '/wait?t=10')

            t = threading.Thread(target=waiter)
            t.start()
            time.sleep(0.4)  # 确保 /wait 已挂起
            payload = json.dumps({'verdict': 'approve', 'annotations': []}).encode()
            code, _ = http_post(s.base + '/feedback', payload)
            self.assertEqual(code, 200)
            t.join(timeout=5)
            self.assertFalse(t.is_alive(), '/wait 未被释放(疑似死锁)')
            self.assertEqual(out['code'], 200)
            self.assertEqual(json.loads(out['body'])['verdict'], 'approve')

    def test_no_deadlock_during_wait(self):
        """/wait 挂起期间,其它请求仍能立即响应(证明 ThreadingHTTPServer)。"""
        with LiveServer() as s:
            t = threading.Thread(target=lambda: http_get(s.base + '/wait?t=10'))
            t.start()
            time.sleep(0.4)
            start = time.time()
            code, _ = http_get(s.base + '/server.py', timeout=3)
            self.assertEqual(code, 200)
            self.assertLess(time.time() - start, 2.0, '挂起的 /wait 堵死了其它请求 → 死锁')
            http_post(s.base + '/feedback', b'{}')  # 释放 waiter
            t.join(timeout=5)

    def test_wait_timeout_204(self):
        """无人提交时 /wait 到超时回 204(让 agent re-arm)。"""
        with LiveServer() as s:
            code, _ = http_get(s.base + '/wait?t=1', timeout=5)
            self.assertEqual(code, 204)

    def test_submit_before_wait(self):
        """用户在 agent arm /wait 之前就提交 → 下个 /wait 立即拿到,不丢。"""
        with LiveServer() as s:
            http_post(s.base + '/feedback', json.dumps({'verdict': 'changes'}).encode())
            time.sleep(0.2)
            code, body = http_get(s.base + '/wait?t=5')
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)['verdict'], 'changes')


if __name__ == '__main__':
    unittest.main(verbosity=2)
