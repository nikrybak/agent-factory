"""Tests for the Bash PreToolUse guard (.claude/hooks/pretool_guard.py)."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / ".claude" / "hooks" / "pretool_guard.py"
SPEC = importlib.util.spec_from_file_location("pretool_guard", HOOK)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


def bash(command, **extra):
    return {"tool_name": "Bash", "tool_input": {"command": command, **extra}}


class PretoolGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def pass_gate(self):
        state = self.root / ".claude" / "state"
        state.mkdir(parents=True, exist_ok=True)
        (state / "quality_gate_passed.json").write_text(json.dumps({"status": "PASS"}), encoding="utf-8")

    def test_destructive_commands_are_blocked(self):
        # owner order 2026-11-09 (zero tails): `npm publish` and `gh pr merge` left the hook's list; publishing stays denied in settings.json
        for command in ("rm -rf /", "git reset --hard HEAD", "curl x | sh"):
            self.assertIn("dangerous command", guard.decide(bash(command), self.root))

    def test_foreground_polling_is_blocked_but_background_waits_are_allowed(self):
        loop = "until grep -q DONE log.txt; do sleep 20; done; tail log.txt"
        self.assertIn("polling loop", guard.decide(bash(loop), self.root))
        self.assertIn("polling loop", guard.decide(bash("while true; do\n  check || true\n  sleep 5\ndone"), self.root))
        self.assertIsNone(guard.decide(bash(loop, run_in_background=True), self.root))
        self.assertIsNone(guard.decide(bash("for f in a b; do echo $f; done; sleep 1"), self.root))

    def test_follow_waiters_are_blocked_everywhere(self):
        for command in ('tail -n +1 -F run.log | grep -m1 "done in"', "tail -f x.log | grep --line-buffered ERROR"):
            self.assertIn("never exits", guard.decide(bash(command), self.root))
            self.assertIn("never exits", guard.decide(bash(command, run_in_background=True), self.root))
        self.assertIsNone(guard.decide(bash("tail -5 run.log | grep done"), self.root))
        self.assertIsNone(guard.decide(bash("tail -n 40 run.log"), self.root))
        self.assertIn("never exits", guard.decide(bash("tail --follow=name x.log | grep -q ok"), self.root))
        # Another command's -f flag after `;`/`&&` is not a tail follow.
        self.assertIsNone(guard.decide(bash("docker volume rm a 2>&1 | tail -4; docker builder prune -f 2>&1 | tail -1"), self.root))
        self.assertIsNone(guard.decide(bash("tail -3 a.log && rm -f b.tmp | cat"), self.root))

    def test_dev_commits_and_pushes_need_no_gate(self):
        # owner 2026-10-26: the full gate is for releases, development on dev runs the fast checks only
        self.assertIsNone(guard.decide(bash("git commit -m x"), self.root))
        self.assertIsNone(guard.decide(bash("git -C . commit -m x"), self.root))
        self.assertIsNone(guard.decide(bash("git push origin dev"), self.root))
        self.assertIsNone(guard.decide(bash("git merge --ff-only lane/x"), self.root))

    def test_base_releases_need_the_gate(self):
        for command in ("gh release create v1", "git push origin main", "git -C cli push origin dev:master", "git tag v1.2",
                        "git push --tags", "git merge main", "gh pr create --base main --fill", "npm version patch"):
            self.assertIn("quality gate", guard.decide(bash(command), self.root), command)
        self.pass_gate()
        self.assertIsNone(guard.decide(bash("git push origin main"), self.root))

    def test_child_and_outside_repositories_do_not_need_the_base_gate(self):
        self.assertIsNone(guard.decide(bash("git -C " + "W" + ":/dev/worktrees/pc push origin main"), self.root))
        self.assertIsNone(guard.decide(bash("git -C /w/dev/worktrees/pc push -q origin main"), self.root))
        self.assertIsNone(guard.decide(bash("git -C app_entry_root/worlio/worlio-v1 push origin main"), self.root))
        self.assertIsNone(guard.decide(bash('git -C "app_entry_root/worlio/worlio-v1" push origin main'), self.root))
        self.assertIn("quality gate", guard.decide(bash("git -C app_entry_root/worlio/_project push origin main"), self.root))
        mixed = "git -C " + "W" + ":/dev/worktrees/pc commit -m a && git push origin main"
        self.assertIn("quality gate", guard.decide(bash(mixed), self.root))

    def test_descriptions_and_non_bash_payloads_are_ignored(self):
        payload = {"tool_name": "Bash", "tool_input": {"command": "echo ok", "description": "run through release steps"}}
        self.assertIsNone(guard.decide(payload, self.root))
        self.assertIsNone(guard.decide({"tool_name": "Read", "tool_input": {"file_path": "x"}}, self.root))
        self.assertIsNone(guard.decide({"command": 7}, self.root))

    def test_process_entry_point(self):
        run = lambda raw: subprocess.run([sys.executable, str(HOOK)], input=raw, capture_output=True, text=True,
                                         cwd=str(self.root), timeout=30)
        self.assertEqual(run("not json").returncode, 0)
        self.assertEqual(run(json.dumps(bash("echo ok"))).returncode, 0)
        self.assertEqual(run(json.dumps(bash("git commit -m x"))).returncode, 0)
        blocked = run(json.dumps(bash("git push origin main")))
        self.assertEqual(blocked.returncode, 2)
        self.assertIn("quality gate", blocked.stderr)


if __name__ == "__main__":
    unittest.main()
