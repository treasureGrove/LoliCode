from datetime import date
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("glm_research", Path(__file__).with_name("glm_research.py"))
glm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(glm)


def story(url="https://openai.com/index/new-model", published="2026-10-27", **changes):
    return {"title": "官方模型更新", "url": url, "publishedAt": published,
            "summary": "来源明确公布了新的模型版本。", **changes}


def events(news, *, tool="glm_search_webSearchPrime", output=None, status="completed", error=False):
    parts = [{"type": "step_start", "part": {"type": "step-start"}}]
    if tool is not None:
        parts.append({"type": "tool_use", "part": {"tool": tool,
            "state": {"status": status, "output": output if output is not None else json.dumps(news), "isError": error}}})
    parts.append({"type": "text", "part": {"text": json.dumps({"news": news}, ensure_ascii=False)}})
    return "\n".join(json.dumps(event, ensure_ascii=False) for event in parts)


def external_evidence(news=None):
    return [{"server": glm.SEARCH_ENDPOINT, "tool": "web_search_prime", "completed": True,
             "result": {"content": [{"type": "text", "text": json.dumps(news or [story()])}]}}]


class NewsValidationTests(unittest.TestCase):
    def parse(self, data, **kwargs):
        return glm.parse_events(data, today="2026-10-28", **kwargs)

    def test_actual_tool_evidence_and_dates_are_required(self):
        expected = story()
        result = self.parse(events([expected]))
        self.assertEqual(result["news"], [expected])
        self.assertEqual(result["toolCalls"], 1)
        with self.assertRaisesRegex(glm.ResearchError, "no successful"):
            self.parse(events([expected], tool=None))
        with self.assertRaisesRegex(glm.ResearchError, "no successful"):
            self.parse(events([expected], status="error"))
        with self.assertRaisesRegex(glm.ResearchError, "no successful"):
            self.parse(events([expected], error=True))
        self.assertEqual(self.parse(events([expected], output="No results"))["news"], [])

    def test_untrusted_hosts_credentials_ports_dates_and_shapes_are_dropped(self):
        invalid = [
            story("https://evil.example/new"), story("http://openai.com/new"),
            story("https://openai.com.evil.example/new"), story("https://user:pass@openai.com/new"),
            story("https://openai.com:8443/new"), story("https://127.0.0.1/new"),
            story("https://localhost/new"), story("https://huggingface.co/random-user/model"),
            story("https://huggingface.co/openai/../random-user/model"),
            story("https://openai.com/future", "2026-10-29"),
            story("https://openai.com/old", "2026-10-20"),
            story("https://openai.com/date", "yesterday"),
            story("https://openai.com/control", title="bad\ncontrol"),
            story("https://openai.com/extra", composite=100),
            {"title": "missing fields"},
        ]
        self.assertEqual(self.parse(events(invalid))["news"], [])

    def test_official_accounts_duplicates_and_maximum_eight(self):
        valid = [story(f"https://openai.com/index/new-{i}") for i in range(10)]
        valid.extend([story("https://huggingface.co/deepseek-ai/DeepSeek-V4"),
                      story("https://github.com/QwenLM/Qwen3"), valid[0]])
        result = self.parse(events(valid))
        self.assertEqual(len(result["news"]), 8)
        self.assertEqual(len({item["url"] for item in result["news"]}), 8)
        accounts = self.parse(events(valid[-3:-1]))["news"]
        self.assertEqual(len(accounts), 2)

    def test_fragment_and_json_tool_outputs_are_canonicalized(self):
        item = story("https://www.openai.com/index/model#details")
        output = {"content": [{"type": "text", "text": json.dumps({"url": "https://www.openai.com/index/model"})}]}
        result = self.parse(events([item], tool="glm_reader_webReader", output=output))
        self.assertEqual(result["news"][0]["url"], "https://www.openai.com/index/model")

    def test_memory_before_tools_cannot_be_the_final_answer(self):
        before = json.dumps({"type": "text", "part": {"text": json.dumps({"news": [story()]})}})
        tool = json.dumps({"type": "tool_use", "part": {"tool": "glm_search_webSearchPrime", "state": {"status": "completed", "output": story()["url"]}}})
        with self.assertRaisesRegex(glm.ResearchError, "required news JSON"):
            self.parse(before + "\n" + tool)

    def test_errors_do_not_echo_secrets_or_raw_output(self):
        secret = "private-test-key"
        with self.assertRaises(glm.ResearchError) as caught:
            self.parse(json.dumps({"type": "error", "error": secret}))
        self.assertNotIn(secret, str(caught.exception))
        self.assertEqual(self.parse(events([story(summary=secret)]), api_key=secret)["news"], [])
        with self.assertRaisesRegex(glm.ResearchError, "Unexpected tool"):
            self.parse(events([story()], tool="bash"))
        with self.assertRaisesRegex(glm.ResearchError, "event stream"):
            self.parse(secret)
        with self.assertRaisesRegex(glm.ResearchError, "exceeded"):
            self.parse("x" * (glm.MAX_OUTPUT_BYTES + 1))

    def test_external_evidence_is_explicit_and_does_not_forge_cli_events(self):
        output = events([story()], tool=None)
        result = self.parse(output, external_evidence=external_evidence())
        self.assertEqual(result["news"], [story()])
        self.assertEqual(result["toolCalls"], 1)
        self.assertEqual(self.parse(events([story("https://openai.com/not-in-evidence")], tool=None), external_evidence=external_evidence())["news"], [])
        bad = external_evidence(); bad[0]["server"] = "https://evil.example/mcp"
        with self.assertRaisesRegex(glm.ResearchError, "Invalid external"):
            self.parse(output, external_evidence=bad)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(glm, "collect_search_evidence", return_value=external_evidence())
        self.search = patcher.start()
        self.addCleanup(patcher.stop)

    def test_isolated_cli_permissions_key_reference_and_cleanup(self):
        key = "do-not-log-this-test-subscription-key"
        captured = {}
        def fake_run(command, **kwargs):
            captured.update(command=command, **kwargs)
            config = json.loads(kwargs["env"]["OPENCODE_CONFIG_CONTENT"])
            self.assertNotIn(key, json.dumps(command))
            self.assertNotIn(key, json.dumps(config))
            self.assertEqual(kwargs["env"]["GLM_API_KEY"], key)
            self.assertNotIn("UNRELATED_SECRET", kwargs["env"])
            self.assertEqual(config["permission"], glm.PERMISSIONS)
            self.assertEqual(config["agent"][glm.AGENT]["permission"], glm.PERMISSIONS)
            self.assertEqual(config["agent"][glm.AGENT]["steps"], 2)
            self.assertEqual(config["provider"][glm.PROVIDER]["models"][glm.MODEL]["limit"]["output"], 4096)
            self.assertEqual(config["provider"][glm.PROVIDER]["models"][glm.MODEL]["options"]["thinking"]["type"], "disabled")
            self.assertEqual(config["permission"], {"*": "deny"})
            self.assertEqual(config["mcp"]["servers"], {})
            self.assertIn("--standalone", command)
            self.assertGreater(kwargs["timeout"], 590)
            self.assertLessEqual(kwargs["timeout"], 600)
            self.assertIs(kwargs["stdin"], subprocess.DEVNULL)
            self.assertTrue(Path(kwargs["cwd"]).is_dir())
            if os.name == "posix":
                self.assertEqual(Path(kwargs["env"]["HOME"]).stat().st_mode & 0o777, 0o700)
            self.assertIn("2026-10-28", command[-1])
            self.assertIn("实际MCP检索结果", command[-1])
            return subprocess.CompletedProcess(command, 0, events([story()], tool=None), "")
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(os.environ, {"UNRELATED_SECRET": "not-for-child"}), patch.object(glm.subprocess, "run", side_effect=fake_run):
                result = glm.research_news({"models": [{"name": "Example"}]}, api_key=key,
                    binary="/private/opencode", work_dir=temporary, today=date(2026, 10, 28))
            self.assertEqual(len(result["news"]), 1)
            self.assertEqual(list(Path(temporary).iterdir()), [])
            self.assertFalse(Path(captured["cwd"]).exists())

    def test_timeout_nonzero_exit_and_missing_binary_are_sanitized(self):
        key = "never-include-this-key-in-errors"
        cases = [subprocess.TimeoutExpired([key], 1, output=key, stderr=key),
                 subprocess.CompletedProcess([key], 1, key, key), OSError(key)]
        with tempfile.TemporaryDirectory() as temporary:
            for case in cases:
                fake = {"side_effect": case} if isinstance(case, Exception) else {"return_value": case}
                with self.subTest(case=type(case).__name__), patch.object(glm.subprocess, "run", **fake):
                    with self.assertRaises(glm.ResearchError) as caught:
                        glm.research_news({}, api_key=key, binary="/private/opencode", work_dir=temporary, today="2026-10-28")
                    self.assertNotIn(key, str(caught.exception))
                    for directory in Path(temporary).iterdir():
                        self.assertTrue(directory.name.startswith("glm-diagnostics-"))
                        for path in directory.iterdir():
                            self.assertNotIn(key, path.read_text(encoding="utf-8"))
                            if os.name == "posix":
                                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_invalid_successful_output_retains_only_redacted_private_diagnostics(self):
        key = "this-key-must-never-appear-in-files"
        output = subprocess.CompletedProcess([], 0, key, "Authorization: Bearer " + key)
        with tempfile.TemporaryDirectory() as temporary, patch.object(glm.subprocess, "run", return_value=output):
            with self.assertRaises(glm.ResearchError):
                glm.research_news({}, api_key=key, binary="/private/opencode", work_dir=temporary, today="2026-10-28")
            diagnostics = list(Path(temporary).glob("glm-diagnostics-*"))
            self.assertEqual(len(diagnostics), 1)
            self.assertEqual((diagnostics[0] / "stdout.jsonl").read_text(encoding="utf-8"), "[redacted]")
            self.assertNotIn(key, (diagnostics[0] / "stderr.log").read_text(encoding="utf-8"))

    def test_invalid_credentials_or_inputs_do_not_start_cli(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(glm.subprocess, "run") as run:
            for key in ("", " ", "secret\nvalue", "secret\x00value"):
                with self.assertRaises(glm.ResearchError):
                    glm.research_news({}, api_key=key, binary="opencode", work_dir=temporary, today="2026-10-28")
            with self.assertRaises(glm.ResearchError):
                glm.research_news({}, api_key="fake", binary="opencode", work_dir=temporary, today="yesterday")
            with self.assertRaises(glm.ResearchError):
                glm.research_news({}, api_key="fake", binary="opencode", work_dir=temporary, today="2026-10-28", timeout=601)
            run.assert_not_called()


class FakeResponse(io.BytesIO):
    def __init__(self, payload, *, streaming=False, session=False):
        raw = json.dumps(payload).encode()
        if streaming:
            raw = b': keep-alive\n\ndata: ' + raw + b'\n\n'
        super().__init__(raw)
        self.headers = {"Content-Type": "text/event-stream" if streaming else "application/json"}
        if session:
            self.headers["Mcp-Session-Id"] = "owned-test-session"


class FakeMcpOpener:
    def __init__(self, *, tool="web_search_prime", streaming=False, unsupported=False, error=False):
        self.requests = []
        self.tool = tool
        self.streaming = streaming
        self.unsupported = unsupported
        self.error = error

    def open(self, request, **kwargs):
        body = json.loads(request.data)
        self.requests.append((request, body, kwargs))
        method = body["method"]
        if method == "initialize":
            result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}}
        elif method == "notifications/initialized":
            return FakeResponse({})
        elif method == "tools/list":
            props = {"search_query": {"type": "string"},
                     "search_recency_filter": {"type": "string", "description": "oneDay/oneWeek/noLimit"},
                     "content_size": {"type": "string", "enum": ["medium", "high"]}}
            required = ["search_query"]
            if self.unsupported:
                required.append("unknown_required")
            result = {"tools": [{"name": self.tool, "inputSchema": {"type": "object", "properties": props,
                "required": required, "additionalProperties": False}}]}
        elif method == "tools/call":
            result = {"isError": self.error, "content": [{"type": "text", "text": json.dumps(story())}]}
        else:
            raise AssertionError("Unexpected MCP method")
        return FakeResponse({"jsonrpc": "2.0", "id": body["id"], "result": result},
                            streaming=self.streaming, session=method == "initialize")


class McpTests(unittest.TestCase):
    def collect(self, opener):
        with patch.object(glm.urllib.request, "build_opener", return_value=opener):
            return glm.collect_search_evidence("fake-private-key", today=date(2026, 10, 28), deadline=time.monotonic() + 20)

    def test_live_advertised_snake_tool_schema_session_and_two_queries(self):
        opener = FakeMcpOpener()
        evidence = self.collect(opener)
        self.assertEqual(len(evidence), 2)
        self.assertEqual([x[1]["method"] for x in opener.requests], ["initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call"])
        for request, body, kwargs in opener.requests:
            headers = {key.lower(): value for key, value in request.header_items()}
            self.assertEqual(request.full_url, glm.SEARCH_ENDPOINT)
            self.assertEqual(headers["authorization"], "Bearer fake-private-key")
            self.assertEqual(headers["accept"], "application/json, text/event-stream")
            if body["method"] != "initialize":
                self.assertEqual(headers["mcp-session-id"], "owned-test-session")
                self.assertEqual(headers["mcp-protocol-version"], "2025-03-26")
            if body["method"] == "tools/call":
                self.assertEqual(body["params"]["name"], "web_search_prime")
                self.assertEqual(body["params"]["arguments"]["search_recency_filter"], "oneWeek")
                self.assertEqual(body["params"]["arguments"]["content_size"], "medium")
                self.assertLessEqual(len(body["params"]["arguments"]["search_query"]), 70)

    def test_camel_tool_and_sse_responses_are_supported(self):
        result = self.collect(FakeMcpOpener(tool="webSearchPrime", streaming=True))
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["tool"], "webSearchPrime")

    def test_unknown_tool_required_fields_and_tool_errors_are_rejected(self):
        for opener in [FakeMcpOpener(tool="execute_command"), FakeMcpOpener(unsupported=True), FakeMcpOpener(error=True)]:
            with self.subTest(tool=opener.tool), self.assertRaises(glm.ResearchError):
                self.collect(opener)

    def test_http_failures_are_redacted_and_redirects_refused(self):
        opener = FakeMcpOpener()
        opener.open = lambda *args, **kwargs: (_ for _ in ()).throw(urllib.error.HTTPError(glm.SEARCH_ENDPOINT, 401, "fake-private-key", {}, None))
        with self.assertRaisesRegex(glm.ResearchError, "HTTP 401") as error:
            self.collect(opener)
        self.assertNotIn("fake-private-key", str(error.exception))
        self.assertIsNone(glm._NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.example"))


if __name__ == "__main__":
    unittest.main()
