"""Resume pinned GGUF downloads with independently verified byte ranges."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time


def fetch_range(item, part, start, end):
    """Short connections survive CDN transfers that stall without closing."""
    for attempt in range(120):
        have = part.stat().st_size if part.exists() else 0
        remaining = end-start+1-have
        if remaining == 0:
            return
        if remaining < 0:
            raise RuntimeError(f"Oversized range: {part}")
        chunk_end = min(end, start+have+16*1024**2-1)
        incoming = part.with_suffix(part.suffix + ".incoming")
        command = ["curl.exe", "--fail", "--location", "--silent", "--show-error",
                   "--connect-timeout", "15", "--max-time", "50", "--speed-limit", "1024", "--speed-time", "10",
                   "--range", f"{start+have}-{chunk_end}", "--output", str(incoming),
                   item["url"] + f"?download=true&range_start={start+have}&range_end={chunk_end}"]
        response = subprocess.run(command, capture_output=True)
        received = incoming.stat().st_size if incoming.exists() else 0
        if received > chunk_end-start-have+1:
            raise RuntimeError("Server did not honor range")
        if received:
            with part.open("ab") as output, incoming.open("rb") as source:
                shutil.copyfileobj(source, output)
            incoming.unlink()
        if response.returncode and not received:
            time.sleep(1)
        # Progress is retained even on a timed-out transfer.
        if part.exists() and part.stat().st_size == end-start+1:
            return
    raise RuntimeError(f"Range incomplete after 120 requests: {part}")


def assemble(item, target, parts):
    for part, size in parts:
        if part.stat().st_size != size:
            raise RuntimeError(f"Server did not honor byte range: {part}")
    with target.open("ab") as output:
        for part, _ in parts:
            with part.open("rb") as source:
                shutil.copyfileobj(source, output, length=8*1024**2)
    with target.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if target.stat().st_size != item["size"] or actual != item["sha256"]:
        raise RuntimeError(f"SHA256 mismatch: {target}")
    print(json.dumps({"verified": item["id"], "bytes": item["size"], "sha256": actual}), flush=True)
    for part, _ in parts:
        part.unlink()


def main():
    root = Path(sys.argv[1]).resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    plans = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=18) as pool:
        jobs = []
        for item in manifest["models"]:
            target = root / item["id"] / item["file"]
            have = target.stat().st_size if target.exists() else 0
            if have > item["size"]:
                raise RuntimeError("Unexpected existing file size")
            if have == item["size"]:
                assemble(item, target, [])
                continue
            parts = []
            for index in range(6):
                start = have + (item["size"]-have)*index//6
                end = have + (item["size"]-have)*(index+1)//6 - 1
                if end < start:
                    continue
                part = target.with_suffix(f".part{index}")
                incoming = part.with_suffix(part.suffix + ".incoming")
                if incoming.exists():
                    if incoming.stat().st_size > min(16*1024**2, end-start+1-(part.stat().st_size if part.exists() else 0)):
                        raise RuntimeError("Unexpected interrupted incoming range")
                    with part.open("ab") as output, incoming.open("rb") as source:
                        shutil.copyfileobj(source, output)
                    incoming.unlink()
                parts.append((part, end-start+1))
                jobs.append((pool.submit(fetch_range, item, part, start, end), item["id"], index))
            plans[item["id"]] = (item, target, parts)
        pending = {key: len(plan[2]) for key, plan in plans.items()}
        by_future = {job[0]: job[1:] for job in jobs}
        for future in concurrent.futures.as_completed(by_future):
            model, index = by_future[future]
            future.result()
            print(json.dumps({"range_complete": model, "part": index}), flush=True)
            pending[model] -= 1
            if pending[model] == 0:
                assemble(*plans[model])


if __name__ == "__main__":
    main()
