#!/usr/bin/env python3
"""Validate an exact CLI npm artifact on Linux using an isolated Node runtime."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.request import urlopen


NODE_VERSION = "24.19.0"
# The .tar.xz entry in https://nodejs.org/dist/v24.19.0/SHASUMS256.txt.
NODE_SHA256 = "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647"


def digest(file):
    return hashlib.file_digest(file.open("rb"), "sha256").hexdigest()


def run(arguments, directory, environment, log):
    result = subprocess.run(
        arguments, cwd=directory, env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    log.write_text(result.stdout, encoding="utf8")
    print(result.stdout, flush=True)
    if result.returncode:
        raise RuntimeError(f"Command failed with exit {result.returncode}. See {log.name}.")
    return result.stdout


def main():
    root = Path(__file__).resolve().parent
    if root.parent != Path("/tmp") or not root.name.startswith("lolicode-cli-validation-"):
        raise RuntimeError("Use a dedicated /tmp/lolicode-cli-validation-* directory.")
    package = root / "lolicode-cli-0.1.0-alpha.1.tgz"
    if len(sys.argv) != 2 or digest(package) != sys.argv[1]:
        raise RuntimeError("CLI artifact SHA-256 does not match.")

    archive = root / "node.tar.xz"
    if not archive.exists():
        url = f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz"
        with urlopen(url, timeout=90) as response, archive.open("xb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
    if digest(archive) != NODE_SHA256:
        raise RuntimeError("Official Node archive SHA-256 does not match.")
    runtime = root / f"node-v{NODE_VERSION}-linux-x64"
    if not runtime.exists():
        subprocess.run(["tar", "-xJf", str(archive), "-C", str(root)], check=True)
    node = runtime / "bin/node"
    npm = runtime / "lib/node_modules/npm/bin/npm-cli.js"
    environment = {**os.environ, "PATH": f"{runtime / 'bin'}:{os.environ['PATH']}", "NO_COLOR": "1"}
    installed = root / "installed"
    run([
        str(node), str(npm), "install", "--prefix", str(installed),
        "--cache", str(root / "npm-cache"), "--ignore-scripts", "--no-audit", "--no-fund", str(package),
    ], root, environment, root / "install.log")
    cli = installed / "node_modules/@lolicode/cli/bin/lolicode.mjs"
    environment["LOLICODE_TEST_CLI"] = str(cli)
    test_output = run([
        "setpriv", "--reuid=65534", "--regid=65534", "--clear-groups",
        str(node), "--test", "--test-reporter=tap", "--test-concurrency=1", str(root / "cli.test.mjs"),
    ], root, environment, root / "tests.log")
    count = re.search(r"# tests (\d+)", test_output)
    if not count or int(count[1]) < 12 or "# fail 0" not in test_output or "# skipped 0" not in test_output:
        raise RuntimeError("Every installed-package acceptance case must pass.")
    proof = {
        "platform": "linux", "arch": "x64", "node": NODE_VERSION,
        "packageSha256": digest(package), "nodeArchiveSha256": NODE_SHA256,
        "testUid": 65534, "result": "passed",
        "tests": int(count[1]), "passed": int(count[1]), "failed": 0, "skipped": 0,
        "modelSource": "loopback protocol fixtures with the actual Harness and local tools",
    }
    (root / "proof.json").write_text(json.dumps(proof, indent=2) + "\n", encoding="utf8")
    print(json.dumps(proof), flush=True)


if __name__ == "__main__":
    main()
