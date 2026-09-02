#!/usr/bin/env python3
"""Minimal OpenAI-compatible mock so we can exercise opencode end-to-end for free."""
import json, time, os, sys, re, traceback, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Opt-in request log. It used to be a hard-coded path from the machine this was
# written on, which made the mock crash on every request everywhere else.
LOG = os.environ.get("MOCK_LLM_LOG")

# Counter for mock-flaky to track requests
flaky_request_count = 0
flaky_lock = threading.Lock()

def sse(obj):
    return ("data: " + json.dumps(obj) + "\n\n").encode()

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # without this the response ends by closing the
                                    # socket, which strict HTTP clients call an error
    def log_message(self, *a): pass

    def _send(self, body, ctype, status=200):
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            self._send(json.dumps({"object":"list","data":[{"id":"mock-coder","object":"model","owned_by":"mock"},{"id":"mock-broken","object":"model","owned_by":"mock"},{"id":"mock-flaky","object":"model","owned_by":"mock"}]}).encode(),
                       "application/json")
        else:
            self.send_response(404); self.send_header("Content-Length","0"); self.end_headers()

    def do_POST(self):
        try:
            self._handle_post()
        except Exception:
            tb = traceback.format_exc()
            sys.stderr.write("mock_llm crashed handling %s:\n%s\n" % (self.path, tb))
            sys.stderr.flush()
            try:
                self._send(json.dumps({"error": {"message": tb[-500:], "type": "mock_crash"}}).encode(),
                           "application/json")
            except Exception:
                pass

    def _handle_post(self):
        n = int(self.headers.get("Content-Length","0"))
        raw = self.rfile.read(n)
        try: req = json.loads(raw)
        except Exception: req = {}
        if LOG:
            try:
                # The derived fields go first and the raw body last: the body is
                # truncated to keep the log readable, and `tools` sits behind a
                # multi-kilobyte system prompt, so logging the body alone would
                # silently drop exactly the field a permission test needs.
                entry = {
                    "path": self.path,
                    "model": req.get("model"),
                    "tools": [t.get("function", {}).get("name") for t in (req.get("tools") or [])],
                    "body": json.dumps(req)[:4000],
                }
                with open(LOG, "a") as f:
                    f.write(json.dumps(entry) + "\n")
            except OSError as e:
                sys.stderr.write("mock_llm: cannot write MOCK_LLM_LOG (%s)\n" % e)

        model = req.get("model", "mock-coder")
        
        # Handle mock-broken and mock-flaky models
        if model == "mock-broken":
            error_body = json.dumps({
                "error": {
                    "message": "The model is overloaded. Please try again later.",
                    "type": "server_error",
                    "code": 503
                }
            }).encode()
            self._send(error_body, "application/json", status=503)
            return
            
        if model == "mock-flaky":
            global flaky_request_count
            with flaky_lock:
                flaky_request_count += 1
                if flaky_request_count == 1:
                    # First request fails with 503
                    error_body = json.dumps({
                        "error": {
                            "message": "The model is overloaded. Please try again later.",
                            "type": "server_error",
                            "code": 503
                        }
                    }).encode()
                    self._send(error_body, "application/json", status=503)
                    return

        msgs = req.get("messages",[])
        tools = [t.get("function",{}).get("name") for t in (req.get("tools") or [])]
        # write once per user turn: tool result after the last user message => answer with text
        last_user = max([i for i,m in enumerate(msgs) if m.get("role")=="user"] or [-1])
        already_used_tool = any(m.get("role")=="tool" for m in msgs[last_user+1:])
        blob = json.dumps(msgs)
        m = (re.findall(r"TARGET=([\w./-]+)", blob) or [None])[-1]
        target = m if m else os.environ.get("MOCK_TARGET_FILE","src/greet.js")
        m2 = (re.findall(r'CONTENT=([^;\\]{1,80};)', blob) or [None])[-1]
        new_content = (m2 if m2 else "export function greet(name) {\n  return `Hallo, ${name}!`;\n}") + "\n"

        chunks = []
        cid = "chatcmpl-mock"
        base = {"id":cid,"object":"chat.completion.chunk","created":int(time.time()),"model":req.get("model","mock-coder")}

        if not already_used_tool and "write" in tools:
            args = json.dumps({"filePath": target, "content": new_content})
            chunks.append({**base,"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write","arguments":""}}]},"finish_reason":None}]})
            for piece in [args[i:i+20] for i in range(0,len(args),20)]:
                chunks.append({**base,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":piece}}]},"finish_reason":None}]})
            chunks.append({**base,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
        else:
            for piece in ["DONE: ","created ", os.path.basename(target), ". Summary: worker finished the task."]:
                chunks.append({**base,"choices":[{"index":0,"delta":{"role":"assistant","content":piece},"finish_reason":None}]})
            chunks.append({**base,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})

        chunks.append({**base,"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280}})

        if req.get("stream"):
            # send the whole event stream as one sized body — the harness tests the
            # fleet, not incremental delivery, and this cannot be mistaken for a
            # dropped connection
            body = b"".join(sse(c) for c in chunks) + b"data: [DONE]\n\n"
            self._send(body, "text/event-stream")
        else:
            msg = {"role":"assistant","content":"DONE: mock reply"}
            self._send(json.dumps({"id":cid,"object":"chat.completion","created":int(time.time()),
                "model":req.get("model"),"choices":[{"index":0,"message":msg,"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280}}).encode(),
                "application/json")

if __name__ == "__main__":
    port = int(os.environ.get("MOCK_PORT", "8099"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    srv.daemon_threads = True
    srv.serve_forever()
