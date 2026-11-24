import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "detect_stack.py"


class DetectStackCompatibilityTests(unittest.TestCase):
    def test_wrapper_preserves_stack_list_and_adds_evidence_details(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "go.mod").write_text("module example", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT)], cwd=root, shell=False,
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["stack"], ["go"])
            self.assertEqual(payload["details"]["components"][0]["evidence"][0]["path"], "go.mod")


if __name__ == "__main__":
    unittest.main()
