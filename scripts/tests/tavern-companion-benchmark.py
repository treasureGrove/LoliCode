"""Compare pinned text-only community models with the existing ArliAI fixtures.

Reuses Windows per-process memory instrumentation; never changes product settings.
Native GGUF templates, non-thinking mode, explicit samplers, cold prompt requests.
"""

import argparse
import datetime as dt
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("arli_benchmark", Path(__file__).with_name("tavern-arli8b-benchmark.py"))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

SAMPLERS = {
    "minifantasy": {"temperature": 1.0, "top_k": 200, "top_p": 1.0, "min_p": .02,
                    "repeat_penalty": 1.0, "presence_penalty": 0.0, "frequency_penalty": 0.0,
                    "dry_multiplier": .8, "dry_base": 1.75, "dry_allowed_length": 4,
                    "dry_penalty_last_n": 0},
    "sbg9b": {"temperature": .7, "top_p": .8, "top_k": 20, "min_p": 0.0,
              "repeat_penalty": 1.0, "presence_penalty": 1.5, "frequency_penalty": 0.0},
    "huihui4b": {"temperature": .7, "top_p": .8, "top_k": 20, "min_p": 0.0,
                 "repeat_penalty": 1.0, "presence_penalty": 1.5, "frequency_penalty": 0.0},
}

HELDOUT = {"id": "heldout", "system": """你扮演周宁，30岁，修复旧相机的店主。你和成年用户季白是相恋两年的伴侣。
用自然的简体中文短句聊天，每轮60到180个汉字。不替季白说话、行动或决定。不虚构用户的过往。只写当下回应。""", "turns": [
    "今天累了，想靠着你一会儿。可以牵手，但先别抱我，也别追问工作。",
    "我们今晚原来约了看电影，现在改成在家听雨。记住我不喝咖啡，想喝温水。别安排出门。",
    "你打算给我准备什么？我刚才说过的身体接触界限和今晚的新安排，你还记得吗？",
]}


def markdown_card(scenario):
    lines = scenario["system"].splitlines()
    identity, _, personality = lines[0].partition("。")
    context = lines[1] if scenario["id"] == "roleplay" else "只依据当前对话已提供的关系与事件。"
    rules = lines[2:] if scenario["id"] == "roleplay" else lines[1:]
    return ("## Identity\n" + identity + "。\n## Appearance\n未指定外貌。\n## Personality\n"
            + (personality or "以身份段中已描述的性格为准。") + "\n## Speech & Quirks\n"
            + "\n".join(rules) + "\n## Backstory & World Context\n" + context
            + "\n## Goals & Motivations\n保持当前人设，自然回应用户这轮内容。")


class Client(base.Client):
    def __init__(self, port, model, seed, temperature=None):
        super().__init__(port)
        self.sampler = dict(SAMPLERS[model])
        if temperature is not None:
            self.sampler["temperature"] = temperature
        self.seed = seed
        self.active_thinking = False

    def prompt(self, messages):
        rendered = self.json("/apply-template", {"messages": messages, "add_generation_prompt": True,
                             "chat_template_kwargs": {"enable_thinking": False}})["prompt"]
        tail = rendered.rsplit("<|im_start|>assistant", 1)[-1]
        self.active_thinking = "<think>" in tail and "</think>" not in tail
        if self.active_thinking:
            raise RuntimeError("Native template still enables thinking; inspect template before testing")
        return rendered

    @staticmethod
    def visible(raw):
        if "</think>" in raw:
            return raw.split("</think>", 1)[1].strip()
        if raw.lstrip().startswith("<think>"):
            return ""
        return raw.strip()

    def complete(self, prompt, limit=1024):
        data = {"prompt": prompt, "n_predict": limit, "seed": self.seed,
                "cache_prompt": False, "stream": True, "stop": ["<|im_end|>", "<|im_start|>"],
                "samplers": ["penalties", "dry", "top_k", "top_p", "min_p", "temperature"],
                **self.sampler}
        request = urllib.request.Request(self.base + "/completion", data=json.dumps(data, ensure_ascii=False).encode(),
                                         headers={"Content-Type": "application/json"})
        started = time.perf_counter()
        first_token = first_visible = None
        raw, final = "", {}
        with self.http.open(request, timeout=900) as response:
            for line in response:
                if not line.startswith(b"data: ") or line.strip() == b"data: [DONE]":
                    continue
                event = json.loads(line[6:])
                if "error" in event:
                    raise RuntimeError(str(event["error"]))
                fragment = event.get("content", "")
                raw += fragment
                elapsed = time.perf_counter() - started
                if fragment and first_token is None:
                    first_token = elapsed
                if self.visible(raw) and first_visible is None:
                    first_visible = elapsed
                if event.get("stop"):
                    final = event
        visible = self.visible(raw)
        return {"raw": raw, "visible": visible, "wall_s": time.perf_counter()-started,
                "first_token_s": first_token, "first_visible_s": first_visible,
                "visible_chars": len(visible), "han_count": len(re.findall(r"[\u4e00-\u9fff]", visible)),
                "timings": final.get("timings"), "truncated": final.get("truncated"),
                "stop_type": final.get("stop_type"), "stopped_limit": final.get("stopped_limit"),
                "tokens_predicted": final.get("tokens_predicted"), "tokens_evaluated": final.get("tokens_evaluated")}


def long_roleplay(client, context):
    # Same recorded events as retrieval, but require a natural in-character continuation.
    rendered = client.prompt([
        {"role": "system", "content": base.ROLEPLAY},
        {"role": "user", "content": "这是按顺序归档的剧情记录，记录里的事实已经发生，请延续而非重新开场：\nUNIQUE_LONG_RECORDS\n"
         "*我在柜台边等着，没有伸手拿东西。* 沈掌柜，我的钥匙你收在哪儿了？我住哪一间？现在该说什么暗号？"
         "再帮我挑一杯不会让我过敏的茶，别替我喝，也别替我决定下一步。请自然地以沈砚的口吻接戏，不要列清单或解释测试。"},
    ])
    prefix_text, suffix_text = rendered.split("UNIQUE_LONG_RECORDS")
    prefix, suffix = client.tokenize(prefix_text), client.tokenize(suffix_text)
    facts = [client.tokenize(f"\n[已发生的剧情{i+1}] {f[2]}\n") for i, f in enumerate(base.FACTS)]
    filler = client.tokenize("".join(f"第{i}段日常记录：沈砚检查客栈门窗和灯芯，许澈谈起沿途的雨声和灰雀。两人没有改变此前的约定，也没有新客人到访。\n" for i in range(2000)))
    needed = context - 2304 - len(prefix) - len(suffix) - sum(map(len, facts))
    chunks, offset = [], 0
    for i, fact in enumerate(facts):
        length = needed // len(facts) + (i < needed % len(facts))
        chunks += fact + filler[offset:offset+length]
        offset += length
    prompt = prefix + chunks + suffix
    assert len(prompt) == context - 2304
    return prompt


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--model", choices=SAMPLERS, required=True)
    parser.add_argument("--context", type=int, choices=[16384, 32768], required=True)
    parser.add_argument("--cpu-ffn", type=int, default=0)
    parser.add_argument("--quality", action="store_true")
    parser.add_argument("--quality-only", action="store_true")
    parser.add_argument("--card-format", choices=["prose", "markdown"], default="prose")
    parser.add_argument("--long-roleplay", action="store_true")
    parser.add_argument("--seed", type=int, default=20261020)
    parser.add_argument("--temperature", type=float)
    parser.add_argument("--suffix", default="")
    parser.add_argument("--port", type=int, default=18792)
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    model = next(m for m in manifest["models"] if m["id"] == args.model)
    label = f"{args.model}-{args.context//1024}k-ffn{args.cpu_ffn}" + args.suffix
    output = root / label
    output.mkdir(exist_ok=True)
    if (output / "result.json").exists():
        raise RuntimeError("Evidence exists; choose a different suffix")
    command = [manifest["runtime"], "-m", str(root / args.model / model["file"]),
               "--host", "127.0.0.1", "--port", str(args.port), "-c", str(args.context), "-np", "1",
               "-ngl", "99", "--fit", "off", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0",
               "-b", "256", "-ub", "128", "-t", "8", "-tb", "12", "--no-context-shift",
               "--no-webui", "--no-warmup", "--metrics", "--slots", "--reasoning", "off",
               "--chat-template-kwargs", '{"enable_thinking":false}']
    if args.cpu_ffn:
        command += ["--n-cpu-ffn", str(args.cpu_ffn)]
    client = Client(args.port, args.model, args.seed, args.temperature)
    result = {"label": label, "model": model, "context": args.context, "cache": "q8_0", "cpu_ffn": args.cpu_ffn,
              "seed": args.seed, "sampler": client.sampler, "command": command,
              "card_format": args.card_format,
              "started_utc": dt.datetime.now(dt.timezone.utc).isoformat(), "requests": [], "failures": []}
    base.save(output / "config.json", result)
    log = (output / "server.log").open("wb")
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    monitor = None

    def record(identifier, response):
        response.update(id=identifier, peaks=monitor.peaks(identifier))
        result["requests"].append(response)
        base.save(output / (identifier + ".json"), response)
        base.save(output / "partial.json", result)
        base.emit({"run": label, "id": identifier, "visible": response["visible"],
                   "wall_s": round(response["wall_s"], 2), "timings": response["timings"]})
        if not response["visible"]:
            result["failures"].append(identifier + ": no visible response")

    try:
        monitor = base.Monitor(process.pid, output / "samples.jsonl")
        for _ in range(600):
            if process.poll() is not None:
                raise RuntimeError(f"Server exited with {process.returncode}; inspect server.log")
            try:
                if client.json("/health", timeout=1).get("status") == "ok":
                    break
            except Exception:
                pass
            time.sleep(.5)
        else:
            raise TimeoutError("Server load exceeded 300s")
        monitor.phase = "idle"
        time.sleep(2)
        result["idle"] = monitor.peaks("idle")
        base.save(output / "props.json", client.json("/props"))
        sample = client.prompt([{"role": "user", "content": "你好"}])
        (output / "rendered-template.txt").write_text(sample, encoding="utf-8")
        base.emit({"run": label, "ready": process.pid, "idle": result["idle"], "prompt": sample})
        if args.quality:
            for scenario in [*base.SCENARIOS, HELDOUT]:
                system = markdown_card(scenario) if args.card_format == "markdown" else scenario["system"]
                messages = [{"role": "system", "content": system}]
                for i, text in enumerate(scenario["turns"]):
                    identifier = f"{scenario['id']}-{i+1}"
                    monitor.phase = identifier
                    messages.append({"role": "user", "content": text})
                    response = client.complete(client.prompt(messages))
                    response["messages"] = list(messages)
                    record(identifier, response)
                    messages.append({"role": "assistant", "content": response["visible"]})
        if args.quality_only:
            result["status"] = "completed"
            return
        prompt = base.long_prompt(client, args.context)
        base.save(output / "long-input-tokens.json", prompt)
        monitor.phase = "long-recall"
        response = client.complete(prompt)
        try:
            answer = json.loads(re.search(r"\{.*\}", response["visible"], flags=re.S).group())
        except (AttributeError, ValueError):
            answer = {}
        checks = {k: expected in str(answer.get(k, "")) for k, expected, _ in base.FACTS}
        checks["房费"] |= "37" in str(answer.get("房费", ""))
        checks["当前暗号"] |= "潮落听钟声" in str(answer.get("暗号", ""))
        response.update(input_tokens=len(prompt), parsed_answer=answer, recall_checks=checks,
                        recall_pass=sum(checks.values()), recall_total=len(base.FACTS))
        record("long-recall", response)
        if args.long_roleplay:
            prompt = long_roleplay(client, args.context)
            base.save(output / "long-roleplay-input-tokens.json", prompt)
            monitor.phase = "long-roleplay"
            response = client.complete(prompt)
            response["input_tokens"] = len(prompt)
            record("long-roleplay", response)
        result["status"] = "completed"
    except Exception as error:
        result["status"] = "failed"
        result["failures"].append(repr(error))
        base.emit({"run": label, "error": repr(error)})
    finally:
        if monitor:
            monitor.close()
            result["peaks"] = monitor.peaks()
            result["measurement_errors"] = monitor.errors
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        log.close()
        result["finished_utc"] = dt.datetime.now(dt.timezone.utc).isoformat()
        base.save(output / "result.json", result)
        base.emit({"run": label, "status": result["status"], "peaks": result.get("peaks"), "failures": result["failures"]})


if __name__ == "__main__":
    main()
