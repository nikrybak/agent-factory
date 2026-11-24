"""Tests for the routing hints of the UserPromptSubmit hook (.claude/hooks/user_prompt_submit.py)."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / ".claude" / "hooks" / "user_prompt_submit.py"


def hints(prompt):
    """Runs the hook as Claude Code does: the payload as UTF-8 bytes on stdin; returns its printed hints."""
    payload = json.dumps({"prompt": prompt}, ensure_ascii=False).encode("utf-8")
    result = subprocess.run([sys.executable, str(HOOK)], input=payload, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    return result.stdout.decode("utf-8")


class UserPromptSubmitTest(unittest.TestCase):
    def test_russian_keys_match_whatever_the_console_encoding(self):
        self.assertIn("app-size skill", hints("сколько весит игра?"))
        self.assertIn("nrg-shield-red-team", hints("проверь игру на взлом"))

    def test_size_questions_route_to_app_size(self):
        for prompt in ("what is the download size", "размер приложения в Google Play", "вес сборки", "bundletool get-size"):
            with self.subTest(prompt=prompt):
                self.assertIn("node scripts/app-size.js", hints(prompt))

    def test_a_plain_prompt_gets_no_hint(self):
        self.assertEqual("", hints("привет, как дела"))

    def test_broken_input_is_ignored(self):
        result = subprocess.run([sys.executable, str(HOOK)], input=b"\xff\xfe not json", capture_output=True, check=False)
        self.assertEqual(0, result.returncode)


if __name__ == "__main__":
    unittest.main()
