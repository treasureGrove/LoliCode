#!/usr/bin/env python3
"""Publish the CLI page and add its navigation link to the current live homepage."""

from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


BATCH = "20261120-cli-alpha1-v1"
PAYLOAD = Path("/root/lolicode-" + BATCH)
SITE = Path("/var/www/lolicode-site/releases") / BATCH
SNIPPET = Path("/etc/nginx/snippets/lolicode-home-production-20261016-home-v3.conf")
TEST = Path("/etc/nginx/sites-available/test.conf")
MAIN = Path("/etc/nginx/sites-available/lolicode.conf")
PREVIEW = Path("/etc/nginx/snippets/lolicode-cli-preview-20261120.conf")
LOCK = Path("/run/lock/lolicode-forum-maintenance.lock")
FLAG = Path("/var/www/ops/MAINTENANCE_ON")
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
DOWNLOAD_PATH = "/cli/downloads/lolicode-cli-0.1.0-alpha.1.tgz"
DOWNLOAD_URL = "https://github.com/treasureGrove/LoliCode-Releases/releases/download/lolicode-cli-v0.1.0-alpha.1/lolicode-cli-0.1.0-alpha.1.tgz"
NS = "http://www.sitemaps.org/schemas/sitemap/0.9"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def plain(path):
    require(stat.S_ISREG(path.lstat().st_mode) and not path.is_symlink(), f"Expected regular file: {path}")
    return path.read_bytes()


def atomic(path, data, mode=0o600):
    require(not path.is_symlink() and path.parent.resolve() == path.parent, f"Unsafe target: {path}")
    descriptor, name = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def immutable(path, data, mode=0o600):
    if path.exists() or path.is_symlink():
        require(plain(path) == data, f"Immutable file differs: {path}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic(path, data, mode)


def replace_once(data, before, after):
    require(data.count(before) == 1, f"Expected one marker: {before[:90]!r}")
    return data.replace(before, after)


def location(config, route):
    blocks = re.findall(rb"(?ms)^location " + re.escape(route.encode()) + rb" \{\n.*?^\}\n", config)
    require(len(blocks) == 1, f"Expected one location: {route}")
    return blocks[0]


def root_for(config, route):
    match = re.search(rb"\n    root (/var/www/lolicode-site/releases/[A-Za-z0-9_-]+);", location(config, route))
    require(match is not None, f"Missing release root: {route}")
    return Path(match[1].decode())


def cli_routes(preview=False):
    robots = '    add_header X-Robots-Tag "noindex, nofollow" always;\n' if preview else ""
    return f'''\n# LoliCode CLI 0.1.0-alpha.1
location = /cli {{
    return 301 /cli/;
}}
location ^~ /cli/ {{
    root {SITE};
    index index.html;
    try_files $uri $uri/ =404;
    autoindex off;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;
    add_header Content-Security-Policy "{CSP}" always;
{robots}}}
location = {DOWNLOAD_PATH} {{
    if ($request_method !~ ^(GET|HEAD)$) {{ return 405; }}
    return 302 {DOWNLOAD_URL};
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options nosniff always;
}}
'''.encode()


def candidate_snippet(before):
    require(not re.search(rb"(?m)^location .* /cli(?:/| |\{)", before), "A CLI route already exists")
    candidate = before
    for route in ("= /", "= /sitemap-desktop.xml"):
        block = location(candidate, route)
        old = str(root_for(candidate, route)).encode()
        candidate = replace_once(candidate, block, replace_once(block, old, str(SITE).encode()))
    return candidate + cli_routes()


def homepage(before):
    marker = b'<a href="#start">'
    require(b'href="/cli/"' not in before, "Homepage already has a CLI link")
    return replace_once(before, marker, b'<a href="/cli/">CLI</a>\n        ' + marker)


def sitemap(before):
    tree = ET.fromstring(before)
    require(tree.tag == f"{{{NS}}}urlset", "Unexpected sitemap format")
    require("https://lolicode.com/cli/" not in [entry.findtext(f"{{{NS}}}loc") for entry in tree], "CLI already in sitemap")
    # Preserve every original URL and original lastmod byte for byte.
    row = b"  <url><loc>https://lolicode.com/cli/</loc><lastmod>2026-11-20</lastmod></url>\n"
    return replace_once(before, b"</urlset>", row + b"</urlset>")


def payload(manifest_sha):
    raw = plain(PAYLOAD / "manifest.json")
    require(sha(raw) == manifest_sha, "Payload manifest changed")
    manifest = json.loads(raw)
    require(manifest["batch"] == BATCH, "Unexpected batch")
    expected = {"cli/index.html", "cli/site.css", "cli/site.js", "cli/latest.json"}
    require(set(manifest["files"]) == expected, "Unexpected site payload")
    files = {}
    for name, digest in manifest["files"].items():
        data = plain(PAYLOAD / "site" / name)
        require(sha(data) == digest, f"Payload changed: {name}")
        files[name] = data
    return manifest, files


def prepare(files, manifest_sha):
    before = plain(SNIPPET)
    baseline = {"manifest": manifest_sha, "main": sha(plain(MAIN)), "test": sha(plain(TEST)), "snippet": sha(before)}
    immutable(PAYLOAD / "baseline.json", (json.dumps(baseline, sort_keys=True) + "\n").encode())
    immutable(PAYLOAD / "snippet.before", before)
    immutable(PAYLOAD / "test.before", plain(TEST))
    immutable(PAYLOAD / "snippet.after", candidate_snippet(before))
    files["index.html"] = homepage(plain(root_for(before, "= /") / "index.html"))
    files["sitemap-desktop.xml"] = sitemap(plain(root_for(before, "= /sitemap-desktop.xml") / "sitemap-desktop.xml"))
    for name, data in files.items():
        immutable(SITE / name, data, 0o644)
    immutable(PAYLOAD / "site-sha.json", (json.dumps({name: sha(data) for name, data in files.items()}, sort_keys=True) + "\n").encode())
    print(json.dumps({"status": "prepared", "baseline": baseline, "site": str(SITE)}), flush=True)


def preview_config(before):
    blocks = []
    for route in ("= /", "= /sitemap-desktop.xml"):
        block = location(candidate_snippet(before), route)
        blocks.append(block[:-2] + b'    add_header X-Robots-Tag "noindex, nofollow" always;\n}\n')
    # The homepage continues to reference its existing immutable assets.
    blocks.extend(re.findall(rb"(?ms)^location (?:\^~|=) /desktop-assets/[^\n]* \{\n.*?^\}\n", before))
    return b"\n".join(blocks) + cli_routes(True)


def reload():
    subprocess.run(["nginx", "-t"], check=True)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)


def swap(path, before, after):
    require(plain(path) == before, f"Concurrent change detected: {path}")
    mode = stat.S_IMODE(path.stat().st_mode)
    atomic(path, after, mode)
    try:
        reload()
    except BaseException:
        require(plain(path) == after, "Concurrent change during failed reload")
        atomic(path, before, mode)
        reload()
        raise


def verify(host, preview=False):
    files = json.loads(plain(PAYLOAD / "site-sha.json"))
    paths = {"/": "index.html", "/cli/": "cli/index.html", "/cli/site.css": "cli/site.css", "/cli/site.js": "cli/site.js", "/cli/latest.json": "cli/latest.json", "/sitemap-desktop.xml": "sitemap-desktop.xml"}

    def get(item):
        route, name = item
        with urlopen(Request(f"https://{host}{route}", headers={"Cache-Control": "no-cache"}), timeout=30) as response:
            data = response.read()
            require(response.status == 200 and sha(data) == files[name], f"Unexpected published bytes: {route}")
            if preview and route in ("/", "/cli/"):
                require("noindex" in response.headers.get("X-Robots-Tag", ""), f"Preview is indexable: {route}")
            return {"path": route, "status": response.status, "sha256": sha(data)}

    with ThreadPoolExecutor(max_workers=4) as pool:
        checks = list(pool.map(get, paths.items()))
    if not preview:
        for route in ("/all", "/api", "/sitemap.xml", "/desktop-assets/site-icon-192.png"):
            with urlopen(f"https://{host}{route}", timeout=30) as response:
                require(response.status == 200, f"Existing route failed: {route}")
                checks.append({"path": route, "status": response.status})
    return checks


def run(action, manifest_sha):
    manifest, files = payload(manifest_sha)
    if action == "prepare":
        prepare(files, manifest_sha)
        return
    baseline = json.loads(plain(PAYLOAD / "baseline.json"))
    require(baseline["manifest"] == manifest_sha and sha(plain(MAIN)) == baseline["main"], "Main configuration or manifest drifted")
    before = plain(PAYLOAD / "snippet.before")
    after = plain(PAYLOAD / "snippet.after")
    test_before = plain(PAYLOAD / "test.before")
    anchor = b"    include /etc/nginx/snippets/forum-test-noindex-locations.conf;"
    test_after = replace_once(test_before, anchor, f"    include {PREVIEW};\n".encode() + anchor)
    if action == "preview":
        require(plain(SNIPPET) == before, "Production drifted before preview")
        immutable(PREVIEW, preview_config(before), 0o644)
        swap(TEST, test_before, test_after)
        return
    if action == "verify-preview":
        require(plain(TEST) == test_after, "Preview configuration drifted")
        checks = verify("test.lolicode.com", True)
        atomic(PAYLOAD / "preview-proof.json", (json.dumps({"manifest": manifest_sha, "checks": checks}, sort_keys=True) + "\n").encode())
        print(json.dumps({"status": "preview_passed", "checks": checks}), flush=True)
        return
    if action == "restore-preview":
        swap(TEST, test_after, test_before)
        return
    require(plain(TEST) == test_before, "Restore the test site first")
    if action == "rollback":
        swap(SNIPPET, after, before)
        return
    require(action == "production", "Unknown action")
    require(json.loads(plain(PAYLOAD / "preview-proof.json"))["manifest"] == manifest_sha, "Missing exact preview verification")
    # Assert the public release exists before linking the website to it.
    with urlopen(Request(DOWNLOAD_URL, method="HEAD"), timeout=60) as response:
        require(response.status == 200 and int(response.headers["Content-Length"]) == manifest["package"]["size"], "Public CLI artifact unavailable")
    swap(SNIPPET, before, after)
    try:
        checks = verify("lolicode.com")
    except BaseException:
        swap(SNIPPET, after, before)
        raise
    proof = {"manifest": manifest_sha, "snippetSha256": sha(after), "checks": checks}
    atomic(PAYLOAD / "production-proof.json", (json.dumps(proof, sort_keys=True) + "\n").encode())
    print(json.dumps({"status": "published", **proof}), flush=True)


if __name__ == "__main__":
    allowed = {"prepare", "preview", "verify-preview", "restore-preview", "production", "rollback"}
    require(os.geteuid() == 0 and len(sys.argv) == 3 and sys.argv[1] in allowed, "Expected ACTION MANIFEST_SHA as root")
    require(re.fullmatch(r"[a-f0-9]{64}", sys.argv[2]), "Expected manifest SHA-256")
    require(PAYLOAD.resolve() == PAYLOAD and stat.S_IMODE(PAYLOAD.stat().st_mode) == 0o700, "Expected private deployment payload")
    with LOCK.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not FLAG.exists() and not FLAG.is_symlink(), "Existing maintenance is active")
        run(sys.argv[1], sys.argv[2])
