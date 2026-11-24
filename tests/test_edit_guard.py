"""Integration tests for the edit-path PreToolUse guard (.claude/hooks/edit_guard.py, owner order 2026-10-26).

Files are changed with the Edit tool; inline interpreter code that writes files, heredocs into tracked files and
unmarked ad-hoc read-replace-write scripts are blocked. Repository scripts (inside a Git work tree) keep running.
The Node port is compared with this reference in tests/test_hook_dispatch.py.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / ".claude" / "hooks" / "edit_guard.py"
sys.path.insert(0, str(HOOK.parent))
import edit_guard  # noqa: E402

EDIT_SCRIPT = "t = open('a.md').read()\nt = t.replace('a', 'b')\nopen('a.md', 'w').write(t)\n"


def run_hook(payload):
    result = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), capture_output=True, text=True, timeout=30)
    return result.returncode, result.stderr


class EditGuardTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "repo" / ".git").mkdir(parents=True)
        (self.root / "repo" / "README.md").write_text("x", encoding="utf-8")
        (self.root / "repo" / "gen.py").write_text(EDIT_SCRIPT, encoding="utf-8")
        (self.root / "fix.py").write_text(EDIT_SCRIPT, encoding="utf-8")
        (self.root / "marked.py").write_text("# mass-edit: rename in 40 files\n" + EDIT_SCRIPT, encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def bash(self, command):
        return run_hook({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": str(self.root)})

    def assertBlocked(self, outcome, reason="use the Edit tool"):
        code, stderr = outcome
        self.assertEqual(2, code, stderr)
        self.assertIn("BLOCKED by edit_guard.py", stderr)
        self.assertIn(reason, stderr)
        self.assertIn("mass-edit:", stderr)

    def assertAllowed(self, outcome):
        self.assertEqual((0, ""), outcome)

    def test_inline_code_that_writes_files_is_blocked(self):
        self.assertBlocked(self.bash("python -c \"open('a.md','w').write('x')\""), "inline interpreter code")
        self.assertBlocked(self.bash("node -e \"require('fs').writeFileSync('a','b')\""), "inline interpreter code")
        self.assertBlocked(self.bash("python - <<'EOF'\nfrom pathlib import Path\nPath('a').write_text('x')\nEOF"))
        self.assertBlocked(self.bash("perl -pi -e 's/a/b/' a.md"))

    def test_inline_code_that_only_reads_or_prints_is_allowed(self):
        self.assertAllowed(self.bash("python -c \"import json,sys; print(json.load(open('a.json'))['v'])\""))
        self.assertAllowed(self.bash("node -e \"process.stdout.write(require('./package.json').version)\""))
        self.assertAllowed(self.bash("node scripts/build-skill-registry.js skills"))

    def test_ad_hoc_edit_scripts_need_the_marker(self):
        self.assertBlocked(self.bash("python fix.py"), "ad-hoc edit script")
        self.assertAllowed(self.bash("python marked.py"))
        self.assertAllowed(self.bash("python repo/gen.py"))
        new = {"tool_name": "Write", "tool_input": {"file_path": str(self.root / "new_fix.py"), "content": EDIT_SCRIPT}}
        self.assertBlocked(run_hook(new), "ad-hoc edit script")
        new["tool_input"]["content"] = "# mass-edit: one rename across 12 files\n" + EDIT_SCRIPT
        self.assertAllowed(run_hook(new))
        in_repo = {"tool_name": "Write", "tool_input": {"file_path": str(self.root / "repo" / "tool.py"), "content": EDIT_SCRIPT}}
        self.assertAllowed(run_hook(in_repo))

    def test_heredocs_and_powershell_rewrites_of_tracked_files_are_blocked(self):
        self.assertBlocked(self.bash("cat > repo/README.md <<'EOF'\nnew\nEOF"), "heredoc")
        self.assertAllowed(self.bash("cat > notes.md <<'EOF'\nnew\nEOF"))
        shell = {"tool_name": "PowerShell", "tool_input": {"command": "(Get-Content a.md) -replace 'a','b' | Set-Content a.md"},
                 "cwd": str(self.root)}
        self.assertBlocked(run_hook(shell), "PowerShell")
        shell["tool_input"]["command"] = "Set-Content -Path repo/README.md -Value x"
        self.assertBlocked(run_hook(shell), "PowerShell")
        shell["tool_input"]["command"] = "'x' | Out-File run.log"
        self.assertAllowed(run_hook(shell))

    def test_the_detector(self):
        self.assertTrue(edit_guard.is_edit_script(EDIT_SCRIPT))
        self.assertTrue(edit_guard.is_edit_script("const t=fs.readFileSync(p,'utf8');fs.writeFileSync(p,t.replaceAll('a','b'))"))
        self.assertFalse(edit_guard.is_edit_script("print(open('a').read().replace('a','b'))"))
        self.assertFalse(edit_guard.is_edit_script("# Mass-Edit: ok\n" + EDIT_SCRIPT))

    def test_unparseable_payloads_are_allowed(self):
        for raw in ("not json", "[]", '{"tool_name": "Bash"}'):
            result = subprocess.run([sys.executable, str(HOOK)], input=raw, capture_output=True, text=True, timeout=30)
            self.assertEqual(0, result.returncode, raw)


if __name__ == "__main__":
    unittest.main()
