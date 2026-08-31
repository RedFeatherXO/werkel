#!/usr/bin/env python3
"""Minimal OpenAI-compatible mock so we can exercise opencode end-to-end for free."""
import json, time, os, sys, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = "/home/claude/lab/mock_requests.log"

def sse(obj):
    return ("data: " + json.dumps(obj) + "\n\n").encode()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            body = json.dumps({"object":"list","data":[{"id":"mock-coder","object":"model","owned_by":"mock"}]}).encode()
            self.send_response(200); self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length","0"))
        raw = self.rfile.read(n)
        try: req = json.loads(raw)
        except Exception: req = {}
        with open(LOG,"a") as f:
            f.write(json.dumps({"path":self.path,"body":req})[:20000] + "\n")

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
            self.send_response(200)
            self.send_header("Content-Type","text/event-stream")
            self.send_header("Cache-Control","no-cache"); self.end_headers()
            for c in chunks:
                self.wfile.write(sse(c)); self.wfile.flush(); time.sleep(0.02)
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
        else:
            msg = {"role":"assistant","content":"DONE: mock reply"}
            body = json.dumps({"id":cid,"object":"chat.completion","created":int(time.time()),
                "model":req.get("model"),"choices":[{"index":0,"message":msg,"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280}}).encode()
            self.send_response(200); self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8099), H).serve_forever()
