"""Integration tests for the secret-overlay PreToolUse guard (.claude/hooks/secrets_guard.py)."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / ".claude" / "hooks" / "secrets_guard.py"


def run_hook(payload):
    raw = payload if isinstance(payload, str) else json.dumps(payload)
    result = subprocess.run([sys.executable, str(HOOK)], input=raw, capture_output=True, text=True, timeout=30)
    return result.returncode, result.stderr


def call(tool, **tool_input):
    return run_hook({"tool_name": tool, "tool_input": tool_input})


class SecretsGuardTest(unittest.TestCase):
    def assertBlocked(self, outcome, reason):
        code, stderr = outcome
        self.assertEqual(code, 2, stderr)
        self.assertIn(reason, stderr)

    def assertAllowed(self, outcome):
        code, stderr = outcome
        self.assertEqual(code, 0, stderr)

    def test_file_tools_cannot_touch_secret_overlays(self):
        self.assertBlocked(call("Read", file_path="W" + ":/repo/app_entry_root/_global-info/.secrets/global.env"), "owner-only")
        self.assertBlocked(call("Read", file_path="C" + ":\\repo\\app_entry_root\\worlio\\.secrets\\upload.jks"), "owner-only")
        self.assertBlocked(call("Edit", file_path="/repo/.secrets/test.env", old_string="a", new_string="b"), "owner-only")
        self.assertBlocked(call("Write", file_path="vault/global.env", content="X=1"), "owner-only")
        self.assertBlocked(call("Grep", pattern="KEY", path="app_entry_root/_global-info/.secrets"), "owner-only")
        self.assertBlocked(call("Glob", pattern="**/.secrets/*"), "owner-only")

    def test_templates_docs_and_ordinary_files_stay_allowed(self):
        self.assertAllowed(call("Read", file_path="app_entry_root/_global-info/vault/global.env.example"))
        self.assertAllowed(call("Read", file_path="app_entry_root/_global-info/vault/test.env.example"))
        self.assertAllowed(call("Write", file_path="docs/adr/0020.md", content="secrets live in .secrets/ only"))
        self.assertAllowed(call("Grep", pattern="secrets", path="docs"))
        self.assertAllowed(call("Read", file_path="src/my.secrets.ts"))

    def test_shell_commands_cannot_reach_secret_overlays(self):
        self.assertBlocked(call("Bash", command="cat app_entry_root/_global-info/.secrets/global.env"), "owner-only")
        self.assertBlocked(call("Bash", command="ls '.secrets'"), "owner-only")
        self.assertBlocked(call("Bash", command="source global.env && run"), "owner-only")
        self.assertAllowed(call("Bash", command="node scripts/global-info-vault.js check"))
        self.assertAllowed(call("Bash", command="cat app_entry_root/_global-info/vault/test.env.example"))

    def test_recursive_grep_and_ignore_bypass_are_blocked(self):
        for command in ("grep -rn KEY .", "grep -R KEY src", "grep --recursive x .", "egrep -ri foo .",
                        "ls && grep -nr KEY app_entry_root", "git log | grep -rl x ."):
            self.assertBlocked(call("Bash", command=command), "recursive grep")
        for command in ("rg -u KEY .", "rg --no-ignore KEY", "rg -uu x", "git grep --no-exclude-standard KEY"):
            self.assertBlocked(call("Bash", command=command), "ignore rules switched off")

    def test_ordinary_searches_are_allowed(self):
        for command in ("rg -n KEY src", "git grep -n KEY", "grep -n KEY file.txt", "git log --grep=fix",
                        "ps aux | grep -i cargo", "rg --hidden -n x docs", "grep -c x a.txt"):
            self.assertAllowed(call("Bash", command=command))

    def test_unparseable_or_foreign_payloads_are_allowed(self):
        self.assertAllowed(run_hook("not json"))
        self.assertAllowed(run_hook({"tool_name": "Bash"}))
        self.assertAllowed(run_hook({"tool_name": "Read", "tool_input": "x"}))

    # ---- ADR-0028: registry of secret stores (the full matrix runs in test_hook_dispatch, in process) ----
    def test_registry_stores_are_blocked_for_file_tools_and_readers(self):
        self.assertBlocked(call("Read", file_path="~/.gradle/gradle.properties"), "secret store")
        self.assertBlocked(call("Read", file_path="app/upload.jks"), "`keystore` is a secret store")
        self.assertBlocked(call("Bash", command="cat ~/.gradle/gradle.properties"), "secret.js keys")
        self.assertBlocked(call("PowerShell", command="Get-Content app/keystore.properties"), "secret store")
        self.assertBlocked(call("Bash", command="node scripts/secret.js set k@x.env"), "owner-only")

    def test_sanctioned_and_consumer_calls_stay_allowed(self):
        self.assertAllowed(call("Bash", command="node scripts/secret.js keys gradle"))
        self.assertAllowed(call("Bash", command="node scripts/secret.js check k@app_entry_root/_global-info/.secrets/global.env"))
        self.assertAllowed(call("Bash", command="keytool -list -v -keystore app/upload.jks"))
        self.assertAllowed(call("Bash", command="./gradlew bundleRelease"))
        self.assertAllowed(call("Edit", file_path="app/src/Password.kt", old_string="password", new_string="secret"))

    def test_environment_and_clipboard_reads_are_blocked(self):
        self.assertBlocked(call("Bash", command="echo $GH_TOKEN"), "environment variables")
        self.assertBlocked(call("PowerShell", command="Get-ChildItem env:"), "environment variables")
        self.assertBlocked(call("PowerShell", command="Get-Clipboard"), "clipboard")
        self.assertAllowed(call("Bash", command="echo $HOME"))

    def test_registry_is_patterns_only_and_well_formed(self):
        data = json.loads((HOOK.parent / "secret_paths.json").read_text(encoding="utf-8"))
        ids = set()
        for entry in data["stores"] + data["dirs"]:
            self.assertTrue(entry["id"] and (entry.get("globs") or entry.get("paths")), entry)
            self.assertIsInstance(entry["consumers"], list)
            ids.add(entry["id"])
            for item in entry.get("paths", []):
                self.assertRegex(item, r"^(\$[A-Z_]+|~)(/|$)", "a path starts with $VAR or ~, never a machine path")
            for glob in entry.get("globs", []):
                self.assertNotRegex(glob, r"^[A-Za-z]:|^/", "globs are relative patterns")
        self.assertIn("gradle-user-home", ids)
        for alias, targets in data["aliases"].items():
            self.assertTrue(targets, alias)


if __name__ == "__main__":
    unittest.main()
