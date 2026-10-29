import copy
from datetime import date
import json
import os
from pathlib import Path
import tempfile
import unittest

import job


SEED = Path(__file__).resolve().parents[2] / "src/lib/data/ai-rankings.json"


class WorkerPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        for name in ("public", "private"):
            (self.state / name).mkdir()
        (self.state / ".lolicode-ai-rankings-owned").write_text(job.OWNER)
        self.seed = json.loads(SEED.read_text(encoding="utf-8"))
        self.public = self.state / "public/latest.json"
        self.public.write_text(json.dumps(self.seed))
        self.credential = self.state / "private/glm.json"
        self.credential.write_text(json.dumps({"apiKey": "test-subscription-secret-123456789"}))
        self.credential.chmod(0o600)
        self.original = self.public.read_bytes()

    def run_worker(self, snapshot=None, researcher=None):
        return job.run_job(self.state, "/trusted/opencode", self.credential, today=date(2026, 10, 28), collector=lambda **kwargs: copy.deepcopy(snapshot or self.seed), researcher=researcher or (lambda *args, **kwargs: {"news": []}))

    def test_publishes_validated_data_atomically_with_private_history(self):
        result = self.run_worker()
        self.assertEqual(result["state"], "published")
        published = json.loads(self.public.read_text(encoding="utf-8"))
        self.assertEqual(published["models"], self.seed["models"])
        self.assertEqual(published["news"], [])
        self.assertEqual(len(list((self.state / "private/history").glob("*.json"))), 1)
        if os.name != "nt":
            self.assertEqual(self.public.stat().st_mode & 0o777, 0o644)
        self.assertNotIn("test-subscription-secret", self.public.read_text(encoding="utf-8"))

    def test_research_failure_preserves_old_public_feed_and_sanitizes_status(self):
        def failing(*args, **kwargs):
            raise RuntimeError("provider error contains test-subscription-secret-123456789")
        with self.assertRaises(RuntimeError):
            self.run_worker(researcher=failing)
        self.assertEqual(self.public.read_bytes(), self.original)
        status = (self.state / "private/status.json").read_text()
        self.assertNotIn("test-subscription-secret", status)
        self.assertEqual(json.loads(status)["errorClass"], "RuntimeError")

    def test_rejects_wrong_source_scores_links_and_insufficient_evidence(self):
        for field, value in (("score", float("nan")), ("score", 100.1), ("score", True), ("url", "https://example.com/claimed-result")):
            candidate = copy.deepcopy(self.seed)
            candidate["models"][0]["measurements"]["artificial-analysis"][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(job.PublicationError):
                self.run_worker(snapshot=candidate)
            self.assertEqual(self.public.read_bytes(), self.original)
        candidate = copy.deepcopy(self.seed)
        candidate["models"][0]["measurements"]["arena"] = None
        candidate["models"][0]["measurements"]["livebench"] = None
        with self.assertRaises(job.PublicationError):
            self.run_worker(snapshot=candidate)

    def test_missing_credential_and_secret_in_generated_output_never_publish(self):
        self.credential.write_text('{"apiKey":""}')
        with self.assertRaises(job.CredentialError):
            self.run_worker()
        self.assertEqual(self.public.read_bytes(), self.original)
        self.credential.write_text(json.dumps({"apiKey": "test-subscription-secret-123456789"}))
        with self.assertRaises(job.PublicationError):
            self.run_worker(researcher=lambda *args, **kwargs: {"news": [{"summary": "test-subscription-secret-123456789"}]})
        self.assertEqual(self.public.read_bytes(), self.original)

    def test_atomic_replace_failure_keeps_original_and_removes_pending_file(self):
        from unittest.mock import patch
        with patch("job.os.replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                job.atomic_json(self.public, {"changed": True}, 0o644)
        self.assertEqual(self.public.read_bytes(), self.original)
        self.assertEqual(list(self.public.parent.glob(".pending-*")), [])

    def test_status_failure_after_publication_does_not_claim_the_old_feed_remains(self):
        from unittest.mock import patch
        writer = job.atomic_json
        def write(path, value, mode=0o600):
            if Path(path).name == "status.json" and value.get("state") == "published":
                raise OSError("status disk write failed")
            return writer(path, value, mode)
        with patch("job.atomic_json", side_effect=write):
            result = self.run_worker()
        self.assertEqual(result["state"], "published")
        self.assertTrue(result["statusWriteFailed"])
        self.assertNotIn("previousFeedPreserved", result)
        self.assertNotEqual(self.public.read_bytes(), self.original)

    @unittest.skipIf(os.name == "nt", "POSIX systemd credential file modes")
    def test_accepts_systemd_private_readonly_group_mode_but_rejects_other_readers(self):
        from unittest.mock import patch
        self.credential.chmod(0o440)
        with self.assertRaises(job.CredentialError):
            job.read_credential(self.credential)
        with patch.dict(os.environ, {"CREDENTIALS_DIRECTORY": str(self.credential.parent)}):
            self.assertTrue(job.read_credential(self.credential))
            self.credential.chmod(0o444)
            with self.assertRaises(job.CredentialError):
                job.read_credential(self.credential)


if __name__ == "__main__":
    unittest.main()
