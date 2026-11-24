"""Integration tests for the PostToolUse audit hook (.claude/hooks/posttool_audit.py)."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / ".claude" / "hooks" / "posttool_audit.py"


class PostToolAuditTest(unittest.TestCase):
    def run_in(self, root, payload):
        flag = root / ".claude" / "state" / "quality_gate_passed.json"
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.write_text("{}", encoding="utf-8")
        raw = payload if isinstance(payload, str) else json.dumps(payload)
        result = subprocess.run([sys.executable, str(HOOK)], input=raw, capture_output=True, text=True,
                                cwd=str(root), timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return flag.exists()

    def edit(self, path):
        return {"tool_name": "Edit", "tool_input": {"file_path": str(path)}}

    def test_base_source_edits_invalidate_the_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(self.run_in(root, self.edit(root / "AGENTS.md")))
            self.assertFalse(self.run_in(root, self.edit(root / "app_entry_root" / "worlio" / "_project" / "a.md")))
            self.assertFalse(self.run_in(root, self.edit(root / "app_entry_root" / "_registry" / "registry.json")))
            self.assertFalse(self.run_in(root, self.edit("relative/inside.md")))
            self.assertFalse(self.run_in(root, {"tool_name": "Write", "tool_input": {}}))
            self.assertFalse(self.run_in(root, "not json"))
            self.assertTrue((root / ".claude" / "state" / "tool_audit.log").exists())

    def run_raw(self, root, payload):
        result = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), capture_output=True, text=True,
                                encoding="utf-8", cwd=str(root), timeout=30)
        log = root / ".claude" / "state" / "tool_audit.log"
        return result.returncode, result.stderr, log.read_text(encoding="utf-8") if log.exists() else ""

    def test_secret_shaped_output_warns_and_never_stores_the_value(self):
        fake = "gh" + "p_" + "aB3dE5gH7jK9mN1pQ2" * 2  # built at run time: no tracked file holds a token shape
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code, stderr, log = self.run_raw(root, {"tool_name": "Bash", "tool_response": {"stdout": "x " + fake}})
            self.assertEqual(2, code)
            self.assertIn("SECRET-SHAPED OUTPUT (github-token:", stderr)
            self.assertIn("tell the owner", stderr)
            self.assertIn("WARNING secret-shaped output tool=\"Bash\"", log)
            self.assertNotIn(fake, stderr + log)
            code, stderr, log = self.run_raw(root, {"tool_name": "Write", "tool_input": {"file_path": "a", "content": fake}})
            self.assertEqual(2, code)
            self.assertIn("[REDACTED:github-token:", log)
            self.assertNotIn(fake, log)

    def test_assignments_warn_only_for_a_secret_key_with_a_secret_value(self):
        """2026-10-26 tuning: log lines and typical code do not warn; a real-shaped `DB_PASSWORD=...` still does."""
        ordinary = ["fakestore: buy hints_50 token=hints_50_pending -> LATER (allowsEconomy=true trustedDay=20752)",
                    "val isOpen = true", "timeout=30", "password = rememberSaveable { \"\" }", "api_key=${API_KEY}",
                    "PASSWORD_HINT=Enter your password", "adb_token=emulator-5554"]
        real = ["DB_PASSWORD=" + "".join("aB3dE5gH7jK9mN1pQ2"[(i * 7) % 18] for i in range(20)),  # built at run time
                "api_key: \"" + "".join("0123456789abcdef"[(i * 7) % 16] for i in range(32)) + "\""]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for text in ordinary:
                code, stderr, _ = self.run_raw(root, {"tool_name": "Edit", "tool_input": {"file_path": "a", "new_string": text}})
                self.assertEqual((0, ""), (code, stderr), text)
            for text in real:
                code, stderr, log = self.run_raw(root, {"tool_name": "Bash", "tool_response": {"stdout": text}})
                self.assertEqual(2, code, text)
                self.assertIn("SECRET-SHAPED OUTPUT (assigned-secret:", stderr)
                self.assertNotIn(text, stderr + log)

    def test_ordinary_results_of_other_tools_are_not_logged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code, stderr, log = self.run_raw(root, {"tool_name": "Read", "tool_response": {"content": "password = getPassword()"}})
            self.assertEqual((0, "", ""), (code, stderr, log))

    def test_edits_outside_the_certified_tree_keep_the_pass(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            self.assertTrue(self.run_in(root, self.edit(Path(outside) / "worktree" / "src" / "lib.rs")))
            self.assertTrue(self.run_in(root, self.edit(root / "app_entry_root" / "worlio" / "worlio-v1" / "a.kt")))
            self.assertTrue(self.run_in(root, self.edit(root / ".claude" / "state" / "x.json")))
            self.assertTrue(self.run_in(root, self.edit(root / ".factory" / "runs" / "r" / "x.json")))


if __name__ == "__main__":
    unittest.main()
