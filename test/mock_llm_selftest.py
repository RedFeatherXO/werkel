#!/usr/bin/env python3
"""Self-test for mock_llm extensions."""
import os
import urllib.request
import urllib.error
import json

def test_mock_llm():
    port = os.environ.get("MOCK_PORT", "8098")
    base_url = f"http://localhost:{port}"
    
    # Test /v1/models lists three models
    models_resp = urllib.request.urlopen(f"{base_url}/v1/models")
    models_data = json.loads(models_resp.read())
    assert models_data["object"] == "list"
    assert len(models_data["data"]) == 3
    model_ids = [model["id"] for model in models_data["data"]]
    assert "mock-coder" in model_ids
    assert "mock-broken" in model_ids
    assert "mock-flaky" in model_ids
    
    # Test mock-coder returns 200 with proper content
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps({
            "model": "mock-coder",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": False
        }).encode(),
        headers={"Content-Type": "application/json"}
    )
    coder_resp = urllib.request.urlopen(req)
    assert coder_resp.getcode() == 200
    coder_data = json.loads(coder_resp.read())
    assert "choices" in coder_data
    
    # Test mock-broken returns 503 with proper error
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps({
            "model": "mock-broken",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": False
        }).encode(),
        headers={"Content-Type": "application/json"}
    )
    try:
        broken_resp = urllib.request.urlopen(req)
        assert False, "Expected 503 error"
    except urllib.error.HTTPError as e:
        assert e.code == 503
        error_data = json.loads(e.read())
        assert "error" in error_data
        assert "overloaded" in error_data["error"]["message"]
    
    # Test mock-flaky - first call should fail with 503
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps({
            "model": "mock-flaky",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": False
        }).encode(),
        headers={"Content-Type": "application/json"}
    )
    try:
        flaky_resp = urllib.request.urlopen(req)
        assert False, "Expected 503 error on first call"
    except urllib.error.HTTPError as e:
        assert e.code == 503
        error_data = json.loads(e.read())
        assert "error" in error_data
        assert "overloaded" in error_data["error"]["message"]
    
    # Second call should succeed
    flaky_resp = urllib.request.urlopen(req)
    assert flaky_resp.getcode() == 200
    flaky_data = json.loads(flaky_resp.read())
    assert "choices" in flaky_data
    
    print("OK")

if __name__ == "__main__":
    test_mock_llm()