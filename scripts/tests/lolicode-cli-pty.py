#!/usr/bin/env python3
"""Exercise the actual CLI prompt, approvals, questions and Ctrl+C through a PTY."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import sys
import tempfile
import threading
import time


def main():
    node, cli = map(str, map(Path, sys.argv[1:3]))
    with tempfile.TemporaryDirectory(prefix="lolicode-cli-pty-") as temporary:
        root = Path(temporary)
        project = root / "project"
        project.mkdir()
        errors = []
        requests = []

        class Model(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    requests.append({"path": self.path, "length": self.headers.get("Content-Length")})
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    prompt = next(message["content"] for message in reversed(body["messages"]) if message["role"] == "user")
                    prompt = str(prompt)
                    if "PTY_HANG_TASK_9017" in prompt:
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.end_headers()
                        for _ in range(30):
                            try:
                                self.wfile.write(b": waiting\n\n")
                                self.wfile.flush()
                            except (BrokenPipeError, ConnectionResetError):
                                break
                            time.sleep(0.3)
                        return
                    following_tool = body["messages"][-1]["role"] == "tool"
                    if following_tool:
                        result = str(body["messages"][-1])
                        if "PTY_QUESTION_TASK_9017" in prompt:
                            assert "rose" in result, result
                            text = "QUESTION_OK"
                        else:
                            text = "APPROVED_OK" if "PTY_ALLOW_TASK_9017" in prompt else "REJECTED_OK"
                        delta, reason = {"content": text}, "stop"
                    else:
                        question = "PTY_QUESTION_TASK_9017" in prompt
                        arguments = {"questions": [{"id": "color", "question": "Choose a color", "options": [{"label": "rose"}, {"label": "cream"}]}]} if question else {
                            "file_path": str(project / ("approved.txt" if "PTY_ALLOW_TASK_9017" in prompt else "rejected.txt")),
                            "content": "approved by a real terminal user",
                        }
                        delta = {"tool_calls": [{"index": 0, "id": "pty_call", "type": "function", "function": {
                            "name": "ask_user_question" if question else "write", "arguments": json.dumps(arguments),
                        }}]}
                        reason = "tool_calls"
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for value, finish in [({"role": "assistant"}, None), (delta, None), ({}, reason)]:
                        chunk = {"id": "pty_fixture", "object": "chat.completion.chunk", "created": 1700000000, "model": "fixture", "choices": [{"index": 0, "delta": value, "finish_reason": finish}]}
                        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception as error:
                    errors.append(str(error))
                    self.send_error(500, str(error))

        server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        pid, descriptor = pty.fork()
        if pid == 0:
            os.chdir(project)
            environment = {**os.environ, "LOLICODE_HOME": str(root / "home"),
                           "LOLICODE_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
                           "LOLICODE_MODEL": "fixture", "LOLICODE_API_KEY": "pty-fixture-key",
                           "TERM": "xterm-256color"}
            os.execve(node, [node, cli, "PTY_REJECT_TASK_9017", "--no-animation"], environment)
        transcript = bytearray()
        cursor = 0

        def wait_for(text):
            nonlocal cursor
            deadline = time.monotonic() + 40
            encoded = text.encode()
            while time.monotonic() < deadline:
                position = transcript.find(encoded, cursor)
                if position >= 0:
                    cursor = position + len(encoded)
                    return
                if select.select([descriptor], [], [], 0.2)[0]:
                    try:
                        chunk = os.read(descriptor, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    transcript.extend(chunk)
            journals = []
            for file in (root / "home/harness").rglob("*.jsonl"):
                events = []
                for line in file.read_text().splitlines():
                    try:
                        entry = json.loads(line)
                        events.append(entry.get("type") or list(entry)[:3])
                    except ValueError:
                        pass
                journals.append({"file": file.name, "events": events[-12:]})
            raise AssertionError(f"Missing terminal output {text!r}. Requests: {requests}. Model errors: {errors}. Journals: {journals}. Terminal: {transcript.decode(errors='replace')}")

        try:
            wait_for("允许这一次？[y/N]")
            os.write(descriptor, b"n\n")
            wait_for("REJECTED_OK")
            wait_for("you ›")
            assert not (project / "rejected.txt").exists()
            os.write(descriptor, b"PTY_ALLOW_TASK_9017\n")
            wait_for("允许这一次？[y/N]")
            os.write(descriptor, b"y\n")
            wait_for("APPROVED_OK")
            wait_for("you ›")
            assert (project / "approved.txt").read_text() == "approved by a real terminal user"
            os.write(descriptor, b"PTY_QUESTION_TASK_9017\n")
            wait_for("Choose a color")
            wait_for("> ")
            os.write(descriptor, b"rose\n")
            wait_for("QUESTION_OK")
            wait_for("you ›")
            os.write(descriptor, b"PTY_HANG_TASK_9017\n")
            time.sleep(0.5)
            os.write(descriptor, b"\x03")
            wait_for("you ›")
            os.write(descriptor, b"/exit\n")
            deadline = time.monotonic() + 10
            status = None
            while time.monotonic() < deadline:
                ended, result = os.waitpid(pid, os.WNOHANG)
                if ended:
                    status = result
                    break
                time.sleep(0.1)
            assert status == 0, f"CLI did not exit successfully: {status}"
            assert not errors, errors
            decoded = transcript.decode(errors="replace")
            print(re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", decoded))
            print(json.dumps({"platform": "linux", "terminal": "pty", "approvalReject": True, "approvalAllow": True, "structuredQuestion": True, "ctrlC": True, "result": "passed"}))
        finally:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(descriptor)
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
