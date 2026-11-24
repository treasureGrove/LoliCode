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
    node, cli = (str(Path(argument).resolve()) for argument in sys.argv[1:3])
    with tempfile.TemporaryDirectory(prefix="lolicode-cli-pty-") as temporary:
        root = Path(temporary)
        project = root / "project with spaces"
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
                    if "PTY_DRAFT_9017" in prompt:
                        delta, reason = {"content": "DRAFT_OK"}, "stop"
                    elif following_tool:
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
            os.chdir(root)
            environment = {**{name: value for name, value in os.environ.items() if not name.startswith("LOLICODE_")}, "LOLICODE_HOME": str(root / "home"),
                           "TERM": "xterm-256color"}
            os.execve(node, [node, cli, "mini", str(project), "--no-animation"], environment)
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
            wait_for(str(project))
            wait_for("you ›")
            os.write(descriptor, b"PTY_DRAFT_9017\n")
            wait_for("已保留草稿")
            wait_for("you ›")
            assert not requests, "Unconnected input reached the provider"
            os.write(descriptor, b"/help\npretend-pasted-api-key\n")
            wait_for("/connect")
            wait_for("you ›")
            assert b"pretend-pasted-api-key" not in transcript, "Pasted input echoed between prompts"
            os.write(descriptor, b"/help\n")
            wait_for("/connect")
            wait_for("you ›")
            os.write(descriptor, b"/conn")
            wait_for("/conn")
            os.write(descriptor, b"\t")
            wait_for("ect")
            os.write(descriptor, b"\n")
            wait_for("选择服务商")
            wait_for("› 1")
            os.write(descriptor, b"4\n")
            wait_for("API 地址")
            os.write(descriptor, f"http://127.0.0.1:{server.server_port}/v1\n".encode())
            wait_for("选择接口协议")
            wait_for("› 1")
            os.write(descriptor, b"\n")
            wait_for("模型 ID:")
            os.write(descriptor, b"fixture\n")
            wait_for("API Key（输入隐藏")
            os.write(descriptor, b"pty-fixture-key\n")
            wait_for("you ›")
            assert b"pty-fixture-key" not in transcript, "Secret echoed to terminal"
            assert "pty-fixture-key" not in (root / "home/config.json").read_text(), "Secret persisted in config"
            assert not requests, "Connecting sent a model request before /send"
            os.write(descriptor, b"/send\n")
            wait_for("DRAFT_OK")
            wait_for("you ›")
            os.write(descriptor, b"/models\n")
            wait_for("选择模型")
            wait_for("› 1")
            os.write(descriptor, b"\n")
            wait_for("you ›")
            os.write(descriptor, b"\x1b[A\x15")
            os.write(descriptor, b"/model does_not_exist\n")
            wait_for("Unknown channel")
            wait_for("you ›")
            os.write(descriptor, b"/connect separate\n")
            wait_for("API 地址")
            os.write(descriptor, f"http://127.0.0.1:{server.server_port}/other\n".encode())
            wait_for("模型名称:")
            os.write(descriptor, b"fixture\n")
            wait_for("密钥环境变量名称")
            os.write(descriptor, b"\n")
            wait_for("协议 [openai-completions]:")
            os.write(descriptor, b"\n")
            wait_for("API Key（输入隐藏")
            os.write(descriptor, b"/cancel\n")
            wait_for("you ›")
            os.write(descriptor, b"PTY_REJECT_TASK_9017\n")
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
            assert b"pty-fixture-key" not in transcript
            print(json.dumps({"platform": "linux", "terminal": "pty", "firstRunStaysOpen": True, "projectArgument": True, "slashCompletion": True, "connectWizard": True, "secretHidden": True, "secretNotInHistory": True, "invalidModelRecoverable": True, "approvalReject": True, "approvalAllow": True, "structuredQuestion": True, "ctrlC": True, "result": "passed"}))
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
