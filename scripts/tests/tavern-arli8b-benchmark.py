"""Reproducible local RP benchmark. All servers bind to loopback and exit on completion.

Requires Windows, a verified GGUF and portable llama.cpp runtime from the bootstrap.
Uses Windows PDH GPU process counters (not whole-desktop VRAM subtraction), process
working set/private commit, and NVML global VRAM as a separate cross-check.
"""

import argparse
from collections import Counter
import ctypes as C
from ctypes import wintypes as W
import datetime as dt
import json
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

MIB = 1024**2
PROFILES = {
    "16k-q8-full": (16384, "q8_0", 99),
    "32k-q8-full": (32768, "q8_0", 99),
    "16k-q8-budget": (16384, "q8_0", 28),
    "32k-q8-budget": (32768, "q8_0", 24),
    "16k-q4-full": (16384, "q4_0", 99),
    "32k-q4-full": (32768, "q4_0", 99),
    "32k-q8-ffn": (32768, "q8_0", 99),
}

COMPANION = """你扮演林晚，28岁的独立书店店员，与成年用户是熟悉的朋友。你温和、细心，也会轻轻开玩笑。
始终使用自然的简体中文，像私聊一样回应；每次60到180个汉字，不列清单，不说教，不给用户贴诊断标签。
可以有一句简短的动作描写，但不要替用户说话、行动、做决定，不能凭空捏造用户经历或你们过去的约定。
不知道的事直接说不知道。只输出当前角色的回应，不输出人物分析、规则说明或英文翻译。"""

ROLEPLAY = """你扮演沈砚，29岁，栖灯客栈掌柜，曾行医，沉稳克制，偶尔说干巴巴的笑话。
背景是没有手机、电力和现代医学仪器的架空古代。成年旅客由用户扮演。当前是雨夜，客栈大堂有一盏油灯。
只用简体中文输出沈砚的动作、感知与台词，每次100到220个汉字，不用列表。不要扮演用户、替用户行动、替用户答话或描述用户的内心。
只知道剧情已经提供的信息。你手头只有普通草药和绷带，没有万能治疗术，也不能突然拿出未出现的道具。
保持人设，尊重用户明确拒绝的动作，不把正常对话强行变成亲密互动。"""

SCENARIOS = [
    {"id": "companion", "system": COMPANION, "turns": [
        "今天开了一整天会，回家什么都不想干。先别给我建议，就陪我坐一会儿吧。",
        "叫我阿澈就好。我喜欢白桃乌龙，不喜欢牛奶，也不喜欢被叫宝贝。",
        "刚才其实有点委屈：我准备了很久的方案没有被采用。我不想听鸡汤。",
        "我是不是很没用？要不明天我直接辞职算了。你不用一味顺着我。",
        "换个轻松的话题吧。你店里今天有没有什么有趣的小事？",
        "如果给我留一杯喝的和一张小纸条，你会怎么写？还记得该怎么叫我、哪些称呼不要用吗？",
    ]},
    {"id": "roleplay", "system": ROLEPLAY, "turns": [
        "*我把一枚青铜燕子钥匙放在柜台上。* 我叫许澈，住北廊第三间。孟九说让我把钥匙交给你，暗号是雨停再开灯。",
        "别碰我的行李，我自己收拾。我只想先喝口热水。",
        "*我把一封没有署名的信推过来。* 信里写着：孟九今晚不会来了。你以前见过这种信纸吗？",
        "先别猜是谁写的。请只根据我们已经知道的事情，说说哪里不对劲。",
        "*我看向窗外，没有回答你刚才的问题。* 你准备怎么办？别替我作决定。",
        "钥匙是谁托我带来的，我住哪一间，暗号是什么？请边收好钥匙边自然地回答我。",
    ]},
]

FACTS = [
    ("昵称", "阿澈", "旅客明确希望被称作阿澈，不要叫宝贝。"),
    ("房间", "北廊第三间", "许澈入住北廊第三间，不是南廊，也不是第二间。"),
    ("托付人", "孟九", "青铜燕子钥匙由孟九托许澈带来。"),
    ("钥匙藏处", "青釉茶罐", "沈砚将青铜燕子钥匙收进柜台下的青釉茶罐。"),
    ("过敏", "桂花", "许澈说自己对桂花过敏，茶饮和点心都不能放桂花。"),
    ("会面地点", "西桥", "双方约定在周五下午三点于西桥会面。"),
    ("借书", "云边札记", "沈砚借给许澈的书名是《云边札记》。"),
    ("房费", "三十七", "本次房费总计三十七枚铜钱，已经结清。"),
    ("当前暗号", "潮落听钟声", "旧暗号雨停再开灯已经作废。双方明确改成潮落听钟声，以后只认新暗号。"),
]

RECALL_SYSTEM = """这是中文长上下文记忆检索测试。资料来自虚构成年角色沈砚和旅客许澈的剧情。
请从完整资料中提取明确事实，不要继续扮演角色，不要猜测。只输出合法JSON对象，字段与用户要求完全一致。
字段值写具体事实；房费写金额，不能只写已经结清。遇到约定变更时使用最后一次明确更新。未提供的信息写不知道。"""


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


class ProcessMemory(C.Structure):
    _fields_ = [("cb", W.DWORD), ("PageFaultCount", W.DWORD)] + [
        (name, C.c_size_t) for name in (
            "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
            "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage",
            "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]


class CounterUnion(C.Union):
    _fields_ = [("longValue", W.LONG), ("doubleValue", C.c_double), ("largeValue", C.c_longlong)]


class CounterValue(C.Structure):
    _anonymous_ = ("value",)
    _fields_ = [("status", W.DWORD), ("value", CounterUnion)]


class CounterItem(C.Structure):
    _fields_ = [("name", W.LPWSTR), ("value", CounterValue)]


class NvMemory(C.Structure):
    _fields_ = [("total", C.c_ulonglong), ("free", C.c_ulonglong), ("used", C.c_ulonglong)]


class Monitor:
    def __init__(self, pid, path):
        self.pid, self.path, self.phase = pid, path, "loading"
        self.samples, self.errors, self.done = [], [], threading.Event()
        self.kernel = C.WinDLL("kernel32", use_last_error=True)
        self.kernel.OpenProcess.restype = W.HANDLE
        self.kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
        self.kernel.CloseHandle.argtypes = [W.HANDLE]
        self.handle = self.kernel.OpenProcess(0x0400 | 0x0010, False, pid)
        self.psapi = C.WinDLL("psapi", use_last_error=True)
        self.psapi.GetProcessMemoryInfo.argtypes = [W.HANDLE, C.POINTER(ProcessMemory), W.DWORD]
        self.pdh = C.WinDLL("pdh")
        self.pdh.PdhOpenQueryW.argtypes = [W.LPCWSTR, C.c_size_t, C.POINTER(W.HANDLE)]
        self.pdh.PdhAddEnglishCounterW.argtypes = [W.HANDLE, W.LPCWSTR, C.c_size_t, C.POINTER(W.HANDLE)]
        self.pdh.PdhGetFormattedCounterArrayW.argtypes = [W.HANDLE, W.DWORD, C.POINTER(W.DWORD), C.POINTER(W.DWORD), C.c_void_p]
        self.pdh.PdhCollectQueryData.argtypes = [W.HANDLE]
        self.pdh.PdhCloseQuery.argtypes = [W.HANDLE]
        self.query = W.HANDLE()
        self.pdh.PdhOpenQueryW(None, 0, C.byref(self.query))
        self.counters = {}
        for label, counter in [("gpu_dedicated_mib", "Dedicated Usage"), ("gpu_shared_mib", "Shared Usage")]:
            handle = W.HANDLE()
            result = self.pdh.PdhAddEnglishCounterW(self.query, f"\\GPU Process Memory(*)\\{counter}", 0, C.byref(handle))
            if result:
                self.errors.append(f"PDH {counter}: {result}")
            else:
                self.counters[label] = handle
        self.nvml = C.WinDLL("nvml.dll")
        self.nvml.nvmlInit_v2()
        self.device = C.c_void_p()
        self.nvml.nvmlDeviceGetHandleByIndex_v2(0, C.byref(self.device))
        self.nvml.nvmlDeviceGetMemoryInfo.argtypes = [C.c_void_p, C.POINTER(NvMemory)]
        self.started = time.perf_counter()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def gpu_counter(self, handle):
        size, count = W.DWORD(), W.DWORD()
        self.pdh.PdhGetFormattedCounterArrayW(handle, 0x400, C.byref(size), C.byref(count), None)
        if not size.value:
            return None
        buffer = C.create_string_buffer(size.value)
        result = self.pdh.PdhGetFormattedCounterArrayW(handle, 0x400, C.byref(size), C.byref(count), buffer)
        if result:
            return None
        items = C.cast(buffer, C.POINTER(CounterItem))
        selected = [items[i].value.largeValue for i in range(count.value)
                    if items[i].name.startswith(f"pid_{self.pid}_") and items[i].value.status in (0, 1)]
        return sum(selected) / MIB if selected else None

    def run(self):
        with self.path.open("w", encoding="utf-8") as output:
            while not self.done.is_set():
                sample = {"elapsed_s": round(time.perf_counter() - self.started, 3), "phase": self.phase}
                memory = ProcessMemory(cb=C.sizeof(ProcessMemory))
                if self.psapi.GetProcessMemoryInfo(self.handle, C.byref(memory), C.sizeof(memory)):
                    sample.update(rss_mib=memory.WorkingSetSize/MIB, private_commit_mib=memory.PrivateUsage/MIB,
                                  process_peak_rss_mib=memory.PeakWorkingSetSize/MIB)
                self.pdh.PdhCollectQueryData(self.query)
                for label, handle in self.counters.items():
                    sample[label] = self.gpu_counter(handle)
                global_memory = NvMemory()
                if self.nvml.nvmlDeviceGetMemoryInfo(self.device, C.byref(global_memory)) == 0:
                    sample.update(gpu_global_used_mib=global_memory.used/MIB, gpu_global_free_mib=global_memory.free/MIB)
                self.samples.append(sample)
                output.write(json.dumps(sample) + "\n")
                output.flush()
                self.done.wait(0.25)

    def close(self):
        self.done.set()
        self.thread.join(timeout=3)
        self.pdh.PdhCloseQuery(self.query)
        self.kernel.CloseHandle(self.handle)
        self.nvml.nvmlShutdown()

    def peaks(self, phase=None):
        samples = [s for s in self.samples if phase is None or s["phase"] == phase]
        keys = ("gpu_dedicated_mib", "gpu_shared_mib", "rss_mib", "private_commit_mib", "gpu_global_used_mib")
        return {key: max((s[key] for s in samples if s.get(key) is not None), default=None) for key in keys}


class Client:
    def __init__(self, port, template="auto"):
        self.base = f"http://127.0.0.1:{port}"
        self.template = template
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def json(self, route, data=None, timeout=30):
        body = None if data is None else json.dumps(data, ensure_ascii=False).encode()
        request = urllib.request.Request(self.base + route, data=body, headers={"Content-Type": "application/json"})
        try:
            with self.http.open(request, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"HTTP {error.code}: {error.read().decode(errors='replace')[:1000]}") from error

    def prompt(self, messages):
        # The quantizer's README says ChatML, but original tokenizer_config and
        # embedded GGUF both specify DeepSeek. Keep ChatML as an explicit control.
        if self.template == "auto":
            rendered = self.json("/apply-template", {"messages": messages, "add_generation_prompt": True})["prompt"]
            return rendered if rendered.endswith("<think>\n") else rendered + "<think>\n"
        return "".join(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n" for m in messages) + "<|im_start|>assistant\n<think>\n"

    def tokenize(self, text):
        return self.json("/tokenize", {"content": text, "add_special": False, "parse_special": True})["tokens"]

    def complete(self, prompt, limit=2048, seed=20261019, temperature=1.0):
        data = {"prompt": prompt, "n_predict": limit, "temperature": temperature, "min_p": 0.02,
                "top_k": 40, "top_p": 1.0, "repeat_penalty": 1.0, "seed": seed,
                "cache_prompt": False, "stream": True,
                "stop": (["<｜end▁of▁sentence｜>", "<｜User｜>"] if self.template == "auto"
                         else ["<|im_end|>", "<|im_start|>"])}
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
                now = time.perf_counter() - started
                if fragment and first_token is None:
                    first_token = now
                if "</think>" in raw and raw.split("</think>", 1)[1].strip() and first_visible is None:
                    first_visible = now
                if event.get("stop"):
                    final = event
        visible = raw.split("</think>", 1)[1].strip() if "</think>" in raw else ""
        han = len(re.findall(r"[\u4e00-\u9fff]", visible))
        latin = len(re.findall(r"[A-Za-z]", visible))
        return {"raw": raw, "visible": visible, "reasoning_closed": "</think>" in raw,
                "wall_s": time.perf_counter()-started, "first_token_s": first_token,
                "first_visible_s": first_visible, "han_fraction_of_letters": han/max(1, han+latin),
                "visible_chars": len(visible), "timings": final.get("timings"),
                "truncated": final.get("truncated"), "stop_type": final.get("stop_type"),
                "stopped_limit": final.get("stopped_limit"), "stopped_eos": final.get("stopped_eos"),
                "tokens_predicted": final.get("tokens_predicted"), "tokens_evaluated": final.get("tokens_evaluated")}


def long_prompt(client, context):
    rendered = client.prompt([
        {"role": "system", "content": RECALL_SYSTEM},
        {"role": "user", "content": "以下是按顺序保存的过往剧情记录。请据此回答最后的问题。\nUNIQUE_LONG_RECORDS\n请只输出一个JSON对象，回答以下字段："
         + "、".join(f[0] for f in FACTS) + "。以最新明确约定为准；找不到就写不知道。"},
    ])
    prefix_text, suffix_text = rendered.split("UNIQUE_LONG_RECORDS")
    prefix, suffix = client.tokenize(prefix_text), client.tokenize(suffix_text)
    facts = [client.tokenize(f"\n[关键对话记录{i+1}] {fact[2]}\n") for i, fact in enumerate(FACTS)]
    distractors = []
    topics = ["修理院里的竹篱笆", "核对杂货铺送来的灯芯", "整理旧地图上的山路", "晾晒雨中打湿的外衣", "听说书人讲一段旧游记", "给庭院里的石阶扫落叶", "记录厨房柴火的用量"]
    for i in range(1600):
        distractors.append(f"第{i+1}段闲谈：两人谈起{topics[i%len(topics)]}。沈砚记下第{i+17}号木牌，说明这只是日常杂事，与旅客身份和双方约定无关。许澈说今天路上见到几只灰雀，雨声忽大忽小，街边摊子早早收了。两人没有更改先前说定的事情。\n")
    filler = client.tokenize("".join(distractors))
    target = context - 2304
    needed = target - len(prefix) - len(suffix) - sum(map(len, facts))
    chunks, offset = [], 0
    for i, fact in enumerate(facts):
        chunks += fact
        length = needed // len(facts) + (1 if i < needed % len(facts) else 0)
        chunks += filler[offset:offset+length]
        offset += length
    prompt = prefix + chunks + suffix
    assert len(prompt) == target
    return prompt


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--profile", choices=PROFILES, required=True)
    parser.add_argument("--quality", action="store_true")
    parser.add_argument("--template", choices=["auto", "chatml"], default="auto")
    parser.add_argument("--quant", choices=["IQ4_XS", "Q4_K_M"], default="IQ4_XS")
    parser.add_argument("--output-suffix", default="")
    parser.add_argument("--seed", type=int, default=20261019)
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--port", type=int, default=18791)
    args = parser.parse_args()
    context, cache, gpu_layers = PROFILES[args.profile]
    root = args.root.resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8-sig"))
    if args.quant == "Q4_K_M":
        manifest["model"] = {**manifest["model"], **manifest["controls"][0]}
    output = root / (args.profile + ("-chatml" if args.template == "chatml" else "")
                     + ("-Q4_K_M" if args.quant == "Q4_K_M" else "") + args.output_suffix)
    output.mkdir(exist_ok=True)
    if (output / "result.json").exists():
        raise RuntimeError("Results already exist; select a new output root to avoid overwriting evidence.")
    command = [str(root / "runtime" / "llama-server.exe"), "-m", str(root / manifest["model"]["file"]),
               "--host", "127.0.0.1", "--port", str(args.port), "-c", str(context), "-np", "1",
               "-ngl", str(gpu_layers), "--fit", "off", "-fa", "on", "-ctk", cache, "-ctv", cache,
               "-b", "256", "-ub", "128", "-t", "8", "-tb", "12", "--no-context-shift",
               "--no-webui", "--no-warmup", "--metrics", "--slots", "--reasoning-format", "deepseek"]
    cpu_ffn = 20 if args.profile == "32k-q8-ffn" else 0
    if cpu_ffn:
        command += ["--n-cpu-ffn", str(cpu_ffn)]
    result = {"profile": args.profile, "context": context, "cache": cache, "gpu_layers": gpu_layers,
              "template": args.template,
              "seed": args.seed, "temperature": args.temperature,
              "cpu_ffn_layers": cpu_ffn,
              "command": command, "started_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
              "model": manifest["model"], "requests": [], "failures": []}
    save(output / "config.json", result)
    log = (output / "server.log").open("wb")
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    monitor = None
    client = Client(args.port, args.template)
    try:
        monitor = Monitor(process.pid, output / "samples.jsonl")
        for _ in range(600):
            if process.poll() is not None:
                raise RuntimeError(f"Server exited with {process.returncode}; see server.log")
            try:
                if client.json("/health", timeout=1).get("status") == "ok":
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            raise TimeoutError("Server not ready in 300s")
        emit({"profile": args.profile, "ready": process.pid})
        monitor.phase = "idle"
        time.sleep(2)
        result["idle"] = monitor.peaks("idle")
        save(output / "props.json", client.json("/props"))
        if args.quality:
            for scenario in SCENARIOS:
                messages = [{"role": "system", "content": scenario["system"]}]
                for i, text in enumerate(scenario["turns"]):
                    label = f"{scenario['id']}-{i+1}"
                    monitor.phase = label
                    messages.append({"role": "user", "content": text})
                    request_result = client.complete(client.prompt(messages), seed=args.seed, temperature=args.temperature)
                    repeated = Counter(line.strip() for line in request_result["visible"].splitlines() if len(line.strip()) >= 8)
                    request_result["max_identical_line_count"] = max(repeated.values(), default=0)
                    raw_sentences = Counter(re.findall(r"[^。！？\n]{8,}[。！？]", request_result["raw"]))
                    request_result["max_identical_raw_sentence_count"] = max(raw_sentences.values(), default=0)
                    request_result.update(id=label, messages=list(messages), peaks=monitor.peaks(label))
                    result["requests"].append(request_result)
                    save(output / f"{label}.json", request_result)
                    save(output / "partial.json", result)
                    emit({"profile": args.profile, "id": label, "visible": request_result["visible"][:420],
                          "wall_s": round(request_result["wall_s"], 2), "first_visible_s": request_result["first_visible_s"],
                          "timings": request_result["timings"]})
                    if not request_result["visible"]:
                        result["failures"].append(f"{label}: no visible response")
                    if request_result["max_identical_line_count"] >= 4:
                        result["failures"].append(f"{label}: repeated identical line 4+ times; scenario stopped")
                        break
                    if not request_result["visible"] and request_result["max_identical_raw_sentence_count"] >= 4:
                        result["failures"].append(f"{label}: reasoning loop without visible response; scenario stopped")
                        break
                    messages.append({"role": "assistant", "content": request_result["visible"]})
        prompt = long_prompt(client, context)
        save(output / "long-input-tokens.json", prompt)
        monitor.phase = "long-recall"
        response = client.complete(prompt, limit=2048, seed=args.seed, temperature=args.temperature)
        try:
            answer = json.loads(re.search(r"\{.*\}", response["visible"], flags=re.S).group())
        except (AttributeError, ValueError):
            answer = {}
        checks = {key: expected in str(answer.get(key, "")) for key, expected, _ in FACTS}
        if "37" in str(answer.get("房费", "")):
            checks["房费"] = True
        semantic_checks = dict(checks)
        if "潮落听钟声" in str(answer.get("暗号", "")):
            semantic_checks["当前暗号"] = True
        response.update(id="long-recall", input_tokens=len(prompt), recall_checks=checks,
                        parsed_answer=answer, recall_pass=sum(checks.values()), recall_total=len(FACTS),
                        semantic_recall_checks=semantic_checks, semantic_recall_pass=sum(semantic_checks.values()),
                        peaks=monitor.peaks("long-recall"))
        result["requests"].append(response)
        save(output / "long-recall.json", response)
        emit({"profile": args.profile, "id": "long-recall", "input_tokens": len(prompt),
              "visible": response["visible"], "recall_checks": checks, "timings": response["timings"]})
        if not response["visible"]:
            result["failures"].append("long-recall: no visible response")
        result["status"] = "completed"
    except Exception as error:
        result["status"] = "failed"
        result["failures"].append(repr(error))
        emit({"profile": args.profile, "error": repr(error)})
    finally:
        if monitor:
            monitor.close()
            result["peaks"] = monitor.peaks()
            result["measurement_errors"] = monitor.errors
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        log.close()
        result["server_exit_code"] = process.returncode
        result["finished_utc"] = dt.datetime.now(dt.timezone.utc).isoformat()
        save(output / "result.json", result)
        emit({"profile": args.profile, "status": result["status"], "peaks": result.get("peaks"), "failures": result["failures"]})


if __name__ == "__main__":
    main()
