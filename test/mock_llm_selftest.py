#!/usr/bin/env python3
"""Standalone check of the mock model server: starts it, exercises every model, stops it."""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = os.environ.get("MOCK_PORT", "8098")
BASE = "http://127.0.0.1:%s" % PORT

failures = []


def check(label, got, want):
    if got != want:
        failures.append("%s: expected %r, got %r" % (label, want, got))


def post(model):
    """Returns (status, body) — an HTTP error is a result here, not an exception."""
    req = urllib.request.Request(
        BASE + "/v1/chat/completions",
        data=json.dumps({"model": model, "messages": [{"role": "user", "content": "ping"}]}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.getcode(), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def wait_until_up(proc, seconds=10):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if proc.poll() is not None:
            return "mock server exited immediately with code %s" % proc.returncode
        try:
            with urllib.request.urlopen(BASE + "/v1/models", timeout=1):
                return None
        except Exception:
            time.sleep(0.2)
    return "mock server did not answer on %s within %ss" % (BASE, seconds)


def main():
    env = dict(os.environ, MOCK_PORT=PORT)
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "mock_llm.py")], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        problem = wait_until_up(proc)
        if problem:
            print("FAIL: " + problem, file=sys.stderr)
            return 1

        with urllib.request.urlopen(BASE + "/v1/models", timeout=5) as r:
            models = [m["id"] for m in json.loads(r.read())["data"]]
        check("/v1/models", sorted(models), ["mock-broken", "mock-coder", "mock-flaky"])

        status, body = post("mock-coder")
        check("mock-coder status", status, 200)
        if "choices" not in body:
            failures.append("mock-coder body has no choices: %s" % body[:200])

        status, body = post("mock-broken")
        check("mock-broken status", status, 503)
        if "overloaded" not in body:
            failures.append("mock-broken body does not mention overloaded: %s" % body[:200])

        first, _ = post("mock-flaky")
        second, body = post("mock-flaky")
        check("mock-flaky first call", first, 503)
        check("mock-flaky second call", second, 200)
        if "choices" not in body:
            failures.append("mock-flaky second body has no choices: %s" % body[:200])
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    if failures:
        for f in failures:
            print("FAIL: " + f, file=sys.stderr)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
