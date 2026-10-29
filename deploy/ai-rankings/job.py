#!/usr/bin/env python3
"""Publish verified benchmark data and GLM research as one atomic daily feed."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import date, datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from sources import collect_rankings
from glm_research import research_news


OWNER = "lolicode-ai-rankings-v1"
STATE = Path("/var/lib/lolicode-ai-rankings")
SOURCE_HOSTS = {
    "artificial-analysis": {"artificialanalysis.ai", "www.artificialanalysis.ai"},
    "livebench": {"livebench.ai", "www.livebench.ai"},
    "arena": {"arena.ai", "www.arena.ai"},
}


class PublicationError(RuntimeError):
    pass


class CredentialError(RuntimeError):
    pass


def valid_date(value, latest):
    try:
        return isinstance(value, str) and len(value) == 10 and date.fromisoformat(value) <= latest
    except ValueError:
        return False


def valid_source_url(value, source):
    if not isinstance(value, str) or len(value) > 2048:
        return False
    parsed = urlsplit(value)
    return (parsed.scheme == "https" and parsed.hostname in SOURCE_HOSTS[source]
            and not parsed.username and not parsed.password and not parsed.fragment
            and parsed.netloc == parsed.hostname)


def validate_snapshot(snapshot, today):
    """Do not trust either changed source markup or generated JSON at publication."""
    if not isinstance(snapshot, dict) or not valid_date(snapshot.get("retrievedAt"), today):
        raise PublicationError("Invalid snapshot date")
    sources = snapshot.get("sources")
    if not isinstance(sources, list) or len(sources) != len(SOURCE_HOSTS):
        raise PublicationError("Invalid source metadata")
    ids = set()
    for source in sources:
        if not isinstance(source, dict) or source.get("id") not in SOURCE_HOSTS:
            raise PublicationError("Unknown benchmark source")
        sid = source["id"]
        if sid in ids or not valid_source_url(source.get("url"), sid):
            raise PublicationError("Invalid source identity")
        if source.get("dataUrl") and not valid_source_url(source["dataUrl"], sid):
            raise PublicationError("Invalid source data link")
        if source.get("updatedAt") is not None and not valid_date(source["updatedAt"], date.fromisoformat(snapshot["retrievedAt"])):
            raise PublicationError("Invalid source version date")
        ids.add(sid)
    models = snapshot.get("models")
    if not isinstance(models, list) or not 10 <= len(models) <= 200:
        raise PublicationError("Unexpected comparable model count")
    model_ids = set()
    for model in models:
        if not isinstance(model, dict) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,95}", model.get("id", "")):
            raise PublicationError("Invalid model identity")
        if model["id"] in model_ids or not isinstance(model.get("openWeights"), bool):
            raise PublicationError("Duplicate model identity or invalid license")
        model_ids.add(model["id"])
        for field, limit in (("name", 140), ("provider", 100)):
            text = model.get(field)
            if not isinstance(text, str) or not text.strip() or len(text) > limit or any(ord(c) < 32 for c in text):
                raise PublicationError("Invalid model text")
        if not isinstance(model.get("icon"), str) or not re.fullmatch(r"[a-z0-9-]{0,64}", model["icon"]):
            raise PublicationError("Invalid provider icon")
        values = model.get("measurements")
        if not isinstance(values, dict) or set(values) != set(SOURCE_HOSTS):
            raise PublicationError("Missing source measurements")
        count = 0
        for sid, measurement in values.items():
            if measurement is None:
                continue
            if not isinstance(measurement, dict):
                raise PublicationError("Invalid observation")
            score = measurement.get("score")
            if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= (5000 if sid == "arena" else 100):
                raise PublicationError("Invalid benchmark score")
            if not valid_source_url(measurement.get("url"), sid):
                raise PublicationError("Invalid measurement source")
            configuration = measurement.get("configuration")
            if not isinstance(configuration, str) or not configuration.strip() or len(configuration) > 300 or any(ord(c) < 32 for c in configuration):
                raise PublicationError("Invalid tested configuration")
            count += 1
        if count < 2:
            raise PublicationError("Insufficient independent evidence")
    return snapshot


def atomic_json(destination, value, mode=0o600):
    encoded = (json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode("utf-8")
    if len(encoded) > 256 * 1024:
        raise PublicationError("Published document exceeds size limit")
    destination = Path(destination)
    if destination.is_symlink():
        raise PublicationError("Refusing a symlink destination")
    descriptor, temporary = tempfile.mkstemp(prefix=".pending-", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), mode) if hasattr(os, "fchmod") else None
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return hashlib.sha256(encoded).hexdigest()


@contextmanager
def exclusive_run(state):
    validate_state(state)
    import fcntl  # The deployed worker is Linux; pure publication tests also run on Windows.
    with (state / "private" / "job.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def validate_state(state):
    if state.is_symlink() or not (state / ".lolicode-ai-rankings-owned").is_file() or (state / ".lolicode-ai-rankings-owned").read_text().strip() != OWNER:
        raise PublicationError("Unrecognized worker state directory")
    for name in ("private", "public"):
        directory = state / name
        if not directory.is_dir() or directory.is_symlink():
            raise PublicationError("Invalid worker state layout")


def credential_path(explicit=None):
    if explicit:
        return Path(explicit)
    directory = os.environ.get("CREDENTIALS_DIRECTORY")
    if not directory:
        raise CredentialError("GLM subscription credential is not provisioned")
    return Path(directory) / "glm.json"


def read_credential(path):
    try:
        if path.is_symlink():
            raise CredentialError("Credential path must be a regular file")
        if os.name != "nt" and path.stat().st_mode & 0o077:
            runtime_directory = os.environ.get("CREDENTIALS_DIRECTORY")
            # systemd mounts LoadCredential files as 0440 for the service's private
            # credential group. Only this trusted read-only runtime copy may do so.
            trusted_runtime = runtime_directory and path.resolve().parent == Path(runtime_directory).resolve()
            if not trusted_runtime or path.stat().st_mode & 0o037:
                raise CredentialError("Credential file permissions are too broad")
        value = json.loads(path.read_text(encoding="utf-8"))
        key = value.get("apiKey", "")
        if not isinstance(key, str) or not 16 <= len(key) <= 2048 or any(c.isspace() for c in key):
            raise CredentialError("A valid GLM subscription key is required")
        return key
    except CredentialError:
        raise
    except Exception:
        raise CredentialError("GLM subscription credential is unavailable") from None


def run_job(state, binary, credential, *, today=None, collector=collect_rankings, researcher=research_news):
    today = today or datetime.now(ZoneInfo("Asia/Singapore")).date()
    if isinstance(today, str):
        today = date.fromisoformat(today)
    state = Path(state)
    validate_state(state)
    status_path = state / "private" / "status.json"
    started = datetime.now(ZoneInfo("Asia/Singapore")).isoformat()
    status = {"startedAt": started, "state": "running", "model": "glm-5.3-flash"}
    atomic_json(status_path, status)
    try:
        api_key = read_credential(credential)
        errors = []
        snapshot = collector(today=today, on_source_error=lambda source, error: errors.append({"source": source, "errorClass": type(error).__name__}))
        validate_snapshot(snapshot, today)
        previous = state / "public" / "latest.json"
        if previous.exists():
            before = json.loads(previous.read_text(encoding="utf-8"))
            if snapshot["retrievedAt"] < before["retrievedAt"]:
                raise PublicationError("Refusing an older snapshot")
        work = state / "private" / "runs" / datetime.now(ZoneInfo("Asia/Singapore")).strftime("%Y%m%d-%H%M%S-%f")
        work.mkdir(mode=0o700, parents=True)
        researched = researcher(snapshot, api_key=api_key, binary=str(binary), work_dir=work, today=today)
        # GLM contributes checked news only; scores always come from source parsers.
        snapshot["news"] = researched.get("news", [])
        snapshot["newsUpdatedAt"] = today.isoformat()
        snapshot["collection"] = {"sourceErrors": errors, "researchModel": "glm-5.3-flash"}
        if api_key in json.dumps(snapshot, ensure_ascii=False):
            raise PublicationError("Unexpected credential material in publication")
        validate_snapshot(snapshot, today)
        archive = state / "private" / "history"
        archive.mkdir(mode=0o700, exist_ok=True)
        atomic_json(archive / (work.name + ".json"), snapshot)
        digest = atomic_json(previous, snapshot, 0o644)
        status.update({"state": "published", "completedAt": datetime.now(ZoneInfo("Asia/Singapore")).isoformat(), "retrievedAt": snapshot["retrievedAt"], "models": len(snapshot["models"]), "news": len(snapshot["news"]), "researchToolCalls": researched.get("toolCalls", 0), "sourceErrors": errors, "sha256": digest})
        try:
            atomic_json(status_path, status)
        except OSError:
            # The public rename already committed. Keep that fact in the journal receipt.
            status["statusWriteFailed"] = True
        return status
    except Exception as error:
        status.update({"state": "failed", "completedAt": datetime.now(ZoneInfo("Asia/Singapore")).isoformat(), "errorClass": type(error).__name__, "previousFeedPreserved": True})
        atomic_json(status_path, status)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=STATE)
    parser.add_argument("--binary", type=Path, default=Path("/usr/local/lib/lolicode-ai-rankings/opencode"))
    parser.add_argument("--credential-file", type=Path)
    args = parser.parse_args()
    try:
        with exclusive_run(args.state_dir):
            result = run_job(args.state_dir, args.binary, credential_path(args.credential_file))
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except BlockingIOError:
        print(json.dumps({"state": "skipped", "reason": "worker already running"}))
        return 0
    except Exception as error:
        # Provider output and process arguments can contain secrets. Log only the class.
        print(json.dumps({"state": "failed", "errorClass": type(error).__name__, "previousFeedPreserved": True}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
