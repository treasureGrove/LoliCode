"""Summarize raw benchmark evidence without changing or scoring model responses."""

import argparse
import json
from pathlib import Path
import statistics
import sys


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    runs, transcripts = [], []
    for path in sorted(root.glob("*/result.json")):
        result = read(path)
        requests = result.get("requests", [])
        recall = next((r for r in requests if r["id"] == "long-recall"), None)
        diagnostic = (path.parent / "diagnostic-note.json").exists()
        row = {key: result.get(key) for key in ("profile", "context", "cache", "gpu_layers", "cpu_ffn_layers", "template", "seed", "temperature", "status", "peaks", "failures")}
        row.update(directory=path.parent.name, diagnostic=diagnostic, result_path=path.as_posix(),
                   model_file=result["model"]["file"], started_utc=result["started_utc"], finished_utc=result["finished_utc"])
        if recall:
            facts = dict(recall["recall_checks"])
            # Separate fact recovery from exact JSON key adherence. Preserve both.
            answer = recall.get("parsed_answer", {})
            if "潮落听钟声" in str(answer.get("暗号", "")):
                facts["当前暗号"] = True
            row["recall"] = {
                "facts_found": sum(facts.values()), "facts_total": recall["recall_total"],
                "exact_keys_found": recall["recall_pass"], "input_tokens": recall["input_tokens"],
                "checks": facts, "visible": recall["visible"], "wall_s": recall["wall_s"],
                "first_visible_s": recall["first_visible_s"], "timings": recall["timings"],
                "path": (path.parent / "long-recall.json").as_posix(),
            }
        quality = [r for r in requests if r["id"] != "long-recall"]
        if quality:
            latency = [r["first_visible_s"] for r in quality if r["first_visible_s"] is not None]
            row["quality_summary"] = {"turns": len(quality), "no_visible": sum(not r["visible"] for r in quality),
                                      "median_visible_latency_s": statistics.median(latency) if latency else None}
            for scenario in ("companion", "roleplay"):
                turns = [{"id": r["id"], "user": r["messages"][-1]["content"], "assistant": r["visible"],
                          "first_visible_s": r["first_visible_s"], "wall_s": r["wall_s"],
                          "stop_type": r["stop_type"], "tokens_predicted": r["tokens_predicted"],
                          "path": (path.parent / (r["id"] + ".json")).as_posix()}
                         for r in quality if r["id"].startswith(scenario + "-")]
                if turns:
                    transcripts.append({"directory": path.parent.name, "scenario": scenario, "turns": turns})
        runs.append(row)
    summary = {"hardware": read(root / "hardware.json"), "manifest": read(root / "manifest.json"),
               "runs": runs, "transcripts": transcripts,
               "method": {"resource_sampling_seconds": 0.25, "gpu_metric": "Windows PDH GPU Process Memory / Dedicated Usage by server PID",
                          "ram_metric": "GetProcessMemoryInfo WorkingSetSize (RSS) and PrivateUsage (commit)",
                          "inference": "Single slot, batch=256, ubatch=128, CPU threads=8/12, Flash Attention enabled, no context shift",
                          "cache": "Cold prompt ingestion (cache_prompt=false); 2,304 tokens reserved for output/headroom",
                          "limitation": "Measured on RTX 5060 Ti 16GB and 64GB RAM; layer offload profiles evaluate a 6GB allocation budget, not an actual 6GB GPU or 16GB host."}}
    destination = root / "summary.json"
    destination.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"path": str(destination), "runs": len(runs), "turns": sum(len(t["turns"]) for t in transcripts)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
