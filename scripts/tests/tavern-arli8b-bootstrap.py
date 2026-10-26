"""Fetch pinned benchmark artifacts; never install system-wide packages."""

import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile


def fetch(item, root):
    name = item.get("name", item.get("file"))
    destination = root / name
    expected = item.get("sha256", item.get("digest", "").removeprefix("sha256:"))
    size = item.get("size", item.get("bytes"))
    if not destination.exists() or destination.stat().st_size != size:
        subprocess.run([
            "curl.exe", "--fail", "--location", "--silent", "--show-error",
            "--retry", "3", "--connect-timeout", "25", "--speed-limit", "1024",
            "--speed-time", "60", "--continue-at", "-", "--output", str(destination),
            item.get("url", item.get("browser_download_url")),
        ], check=True)
    actual = hashlib.file_digest(destination.open("rb"), "sha256").hexdigest()
    if destination.stat().st_size != size or actual != expected:
        raise RuntimeError(f"Checksum or size mismatch: {name}")
    print(json.dumps({"verified": name, "bytes": size, "sha256": actual}), flush=True)
    return destination


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--include-controls", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((args.root / "manifest.json").read_text(encoding="utf-8-sig"))
    items = [manifest["model"], *manifest["runtime"]["assets"]]
    if args.include_controls:
        items.extend(manifest.get("controls", []))
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        paths = list(pool.map(lambda item: fetch(item, args.root), items))
    runtime = args.root / "runtime"
    runtime.mkdir(exist_ok=True)
    for path in paths:
        if path.suffix != ".zip":
            continue
        with zipfile.ZipFile(path) as archive:
            for member in archive.infolist():
                if not (runtime / member.filename).resolve().is_relative_to(runtime.resolve()):
                    raise RuntimeError("Unsafe archive path")
            archive.extractall(runtime)
    print(json.dumps({"ready": str(runtime)}), flush=True)


if __name__ == "__main__":
    main()
