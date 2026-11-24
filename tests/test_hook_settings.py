# machine-path-scan: off (the bash location of this host is looked up for the shell variants)
"""Hook commands in .claude/settings.json must work whatever directory the session has moved into.

A session whose working directory drifted into a subfolder (for example `app_entry_root/<key>/_output/...`)
used to run `python .claude/hooks/<hook>.py` relative to that folder; the file was missing, Python exited 2,
and Claude Code blocked every prompt and tool call. Each command now enters CLAUDE_PROJECT_DIR first.
Every event is one Node process (not several PyManager-shim Python processes), ADR-0027.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETTINGS = ROOT / ".claude" / "settings.json"


def git_bash():
    """Git Bash as Claude Code runs hook commands on Windows (None where unavailable)."""
    for candidate in ("W:/dev/runtimes/Git/bin/bash.exe", shutil.which("bash")):
        if candidate and Path(candidate).exists():
            return candidate
    return None


def hook_commands():
    """Yield (event, command) for every command hook in the project settings."""
    data = json.loads(SETTINGS.read_text(encoding="utf-8"))
    for event, groups in data["hooks"].items():
        for group in groups:
            for hook in group["hooks"]:
                yield event, hook["command"]


class HookSettingsTest(unittest.TestCase):
    def setUp(self):
        self.project = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / ".claude" / "hooks", self.project / ".claude" / "hooks",
                        ignore=shutil.ignore_patterns("__pycache__"))
        self.drifted = self.project / "app_entry_root" / "game" / "_output" / "game-v1" / "market"
        self.drifted.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.project, ignore_errors=True)

    def shells(self):
        return ["cmd"] + (["bash"] if git_bash() else [])

    def run_hook(self, command, payload, shell="cmd"):
        env = {**os.environ, "CLAUDE_PROJECT_DIR": str(self.project)}
        argv = command if shell == "cmd" else [git_bash(), "-c", command]
        return subprocess.run(argv, shell=shell == "cmd", input=json.dumps(payload), capture_output=True, text=True,
                              cwd=str(self.drifted), env=env, timeout=30)

    def test_every_command_enters_the_project_root(self):
        commands = list(hook_commands())
        self.assertTrue(commands)
        for event, command in commands:
            self.assertIn("CLAUDE_PROJECT_DIR", command, event)

    def test_every_hook_runs_from_a_drifted_working_directory(self):
        payload = {"prompt": "hi", "tool_name": "Bash", "tool_input": {"command": "ls", "file_path": str(self.drifted)}}
        for event, command in hook_commands():
            for shell in self.shells():
                result = self.run_hook(command, payload, shell)
                self.assertEqual(result.returncode, 0, f"{event} ({shell}): {result.stderr}")

    def test_blocking_exit_code_still_reaches_claude_code(self):
        guard = next(command for event, command in hook_commands() if event == "PreToolUse")
        destructive = "git " + "reset --hard"
        for shell in self.shells():
            result = self.run_hook(guard, {"tool_name": "Bash", "tool_input": {"command": destructive}}, shell)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("BLOCKED by pretool_guard.py", result.stderr)
            result = self.run_hook(guard, {"tool_name": "Read", "tool_input": {"file_path": "a/.secrets/x"}}, shell)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("BLOCKED by secrets_guard.py", result.stderr)

    def test_hook_state_lands_in_the_project_root(self):
        audit = next(command for event, command in hook_commands() if event == "PostToolUse")
        self.run_hook(audit, {"tool_name": "Write", "tool_input": {"file_path": str(self.drifted / "x.txt")}})
        self.assertTrue((self.project / ".claude" / "state" / "tool_audit.log").exists())
        self.assertFalse((self.drifted / ".claude").exists())

    def test_every_hook_is_one_node_process_without_a_machine_path(self):
        """A missing runtime exits non-blocking and would silently switch the guards off: Node comes from PATH, nothing is hard-wired."""
        self.assertTrue(shutil.which("node"), "node must be on PATH for the hooks")
        for event, command in hook_commands():
            self.assertTrue(command.startswith("node -e "), event)
            self.assertIn("require(process.cwd()+'/.claude/hooks/dispatch.js')", command, event)
            self.assertNotRegex(command, r"[A-Za-z]:[\/]", event)

    def test_pre_tool_matcher_covers_every_tool(self):
        """The PreToolUse matcher is `*`: no tool, present or future, can bypass the guards (ADR-0027 point 3)."""
        data = json.loads(SETTINGS.read_text(encoding="utf-8"))
        self.assertEqual(data["hooks"]["PreToolUse"][0]["matcher"], "*")

    def test_post_tool_matcher_covers_every_tool(self):
        """PostToolUse is `*` too: the secret-shaped output audit must see every tool result (ADR-0028)."""
        data = json.loads(SETTINGS.read_text(encoding="utf-8"))
        self.assertEqual(data["hooks"]["PostToolUse"][0]["matcher"], "*")

    def test_deny_rules_cover_the_common_secret_stores(self):
        deny = json.loads(SETTINGS.read_text(encoding="utf-8"))["permissions"]["deny"]
        for rule in ("Read(**/.secrets/**)", "Read(~/.gradle/gradle.properties)", "Read(**/*.jks)", "Read(**/.env)"):
            self.assertIn(rule, deny)


if __name__ == "__main__":
    unittest.main()
