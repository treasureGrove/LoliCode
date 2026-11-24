#!/usr/bin/env python3
"""Upload verified CLI assets from the existing release server; auth arrives on stdin."""

import hashlib
import json
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def request(url, token, data=None):
    headers = {
        "Authorization": f"Bearer {token}", "User-Agent": "LoliCode-CLI-release",
        "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
    }
    if data is not None:
        headers["Content-Type"] = "application/octet-stream"
    try:
        with urlopen(Request(url, data=data, headers=headers), timeout=120) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"GitHub asset request failed with HTTP {error.code}.") from None


def main():
    root = Path(__file__).resolve().parent
    if root.parent != Path("/tmp") or not root.name.startswith("lolicode-cli-validation-"):
        raise RuntimeError("Expected the isolated CLI validation directory.")
    parameters = json.loads(sys.stdin.readline())
    token = parameters.pop("token")
    release_id = parameters["releaseId"]
    if not isinstance(release_id, int):
        raise RuntimeError("Expected a numeric release ID.")
    api = "https://api.github.com/repos/treasureGrove/LoliCode-Releases"
    release = request(f"{api}/releases/{release_id}", token)
    if release["tag_name"] != "lolicode-cli-v0.1.0-alpha.5" or not release["draft"] or not release["prerelease"]:
        raise RuntimeError("Unexpected release state.")
    allowed = {"lolicode-cli-0.1.0-alpha.5.tgz", "LoliCode-CLI-README.md", "SHA256SUMS"}
    if set(parameters["files"]) != allowed:
        raise RuntimeError("Unexpected release inventory.")
    for name, expected in parameters["files"].items():
        data = (root / name).read_bytes()
        digest = "sha256:" + hashlib.sha256(data).hexdigest()
        if digest != expected:
            raise RuntimeError(f"Local digest changed: {name}")
        asset = next((asset for asset in release["assets"] if asset["name"] == name), None)
        if asset is None:
            url = f"https://uploads.github.com/repos/treasureGrove/LoliCode-Releases/releases/{release_id}/assets?name={name}"
            asset = request(url, token, data)
        if asset["size"] != len(data) or asset["state"] != "uploaded" or asset.get("digest") != digest:
            raise RuntimeError(f"Uploaded asset did not match: {name}")
        print(json.dumps({"asset": name, "id": asset["id"], "digest": digest, "size": len(data)}), flush=True)


if __name__ == "__main__":
    main()
