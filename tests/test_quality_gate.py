import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest import mock

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "quality_gate.py"
SPEC = importlib.util.spec_from_file_location("quality_gate", MODULE_PATH)
quality_gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(quality_gate)


class QualityGateTests(unittest.TestCase):
    @staticmethod
    def identity(source="a", layout="b", certification="c"):
        return {
            "schemaVersion": "1.0.0",
            "scope": "standalone",
            "key": None,
            "sourceTreeHash": source * 64,
            "layoutInputDigest": layout * 64,
            "certificationIdentityDigest": certification * 64,
        }

    def test_run_command_requires_argv_and_never_uses_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            result = quality_gate.run_command(
                [quality_gate.sys.executable, "-c", "print('ok')"],
                Path(directory),
                required=True,
            )
            self.assertTrue(result["ok"])
            self.assertEqual(result["argv"][0], quality_gate.sys.executable)
            with self.assertRaises(TypeError):
                quality_gate.run_command("echo unsafe", Path(directory), required=True)

    def test_parse_node_coverage_and_enforce_threshold(self):
        output = "all files | 91.25 | 82.50 | 95.00 |"
        metrics = quality_gate.parse_node_coverage(output)
        self.assertEqual(metrics, {"lines": 91.25, "branches": 82.5, "functions": 95.0})
        self.assertEqual(quality_gate.coverage_failures(metrics, 80), [])
        self.assertEqual(len(quality_gate.coverage_failures(metrics, 90)), 1)
        self.assertTrue(quality_gate.coverage_failures(None, 80))

    def test_parse_node_coverage_reads_the_merged_table_not_a_failing_files_own(self):
        output = (
            "FAIL cli/test/a.test.js 6.5s\n"
            "ℹ all files                 |  66.60 |    81.55 |   56.52 |\n"
            "# coverage merged from per-file runs\n"
            "# cli/lib/x.js                           | 100.00 | 100.00 | 100.00 | \n"
            "# all files                              |  94.98 |  88.37 |  95.73 | \n"
        )
        self.assertEqual(
            quality_gate.parse_node_coverage(output), {"lines": 94.98, "branches": 88.37, "functions": 95.73})
        self.assertIsNone(quality_gate.parse_node_coverage("ℹ all files | 66.60 | 81.55 | 56.52 |\n"))
        self.assertEqual(
            quality_gate.parse_node_coverage("all files | 91.25 | 82.50 | 95.00 |"),
            {"lines": 91.25, "branches": 82.5, "functions": 95.0})

    def test_tree_hash_is_stable_and_ignores_local_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "source.txt").write_text("one", encoding="utf-8")
            first = quality_gate.tree_hash(root)
            (root / ".factory").mkdir()
            (root / ".factory" / "state.json").write_text("changed", encoding="utf-8")
            self.assertEqual(first, quality_gate.tree_hash(root))
            (root / "docs" / "operations").mkdir(parents=True)
            (root / "docs" / "operations" / "MEMORY.md").write_text("curated", encoding="utf-8")
            self.assertNotEqual(first, quality_gate.tree_hash(root))
            (root / "docs" / "operations" / "MEMORY.md").unlink()
            (root / "source.txt").write_text("two", encoding="utf-8")
            self.assertNotEqual(first, quality_gate.tree_hash(root))

    def test_tree_hash_ignores_child_repository_but_tracks_knowledge_and_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout = root / "app_entry_root" / "worlio" / "preview-client"
            knowledge = root / "app_entry_root" / "worlio" / "_project"
            registry = root / "app_entry_root" / "_registry"
            checkout.mkdir(parents=True)
            knowledge.mkdir(parents=True)
            registry.mkdir(parents=True)
            (registry / "registry.json").write_text('{"projects": []}', encoding="utf-8")
            (checkout / "generated.cpp").write_text("generated", encoding="utf-8")
            (knowledge / "README.md").write_text("knowledge", encoding="utf-8")
            first = quality_gate.tree_hash(root)

            (checkout / "generated.cpp").write_text("changed locally", encoding="utf-8")
            self.assertEqual(first, quality_gate.tree_hash(root))

            (knowledge / "README.md").write_text("changed knowledge", encoding="utf-8")
            with_knowledge = quality_gate.tree_hash(root)
            self.assertNotEqual(first, with_knowledge)
            first = with_knowledge

            (registry / "registry.json").write_text('{"projects": ["worlio"]}', encoding="utf-8")
            self.assertNotEqual(first, quality_gate.tree_hash(root))

    def test_tree_hash_tracks_similarly_named_tree_without_city_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout = root / "app_entry_root" / "ordinary" / "client"
            checkout.mkdir(parents=True)
            source = checkout / "source.txt"
            source.write_text("one", encoding="utf-8")
            first = quality_gate.tree_hash(root)
            source.write_text("two", encoding="utf-8")
            self.assertNotEqual(first, quality_gate.tree_hash(root))

    def test_tree_hash_ignores_generated_skill_mirrors_but_tracks_canon(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / "app_entry_root" / "_registry"
            canonical = root / "skills" / "sample" / "SKILL.md"
            agent_mirror = root / ".agents" / "skills" / "sample" / "SKILL.md"
            claude_mirror = root / ".claude" / "skills" / "sample" / "SKILL.md"
            for parent in [registry, canonical.parent, agent_mirror.parent, claude_mirror.parent]:
                parent.mkdir(parents=True, exist_ok=True)
            (registry / "registry.json").write_text('{"projects": []}', encoding="utf-8")
            canonical.write_text("canonical-one", encoding="utf-8")
            agent_mirror.write_text("mirror-one", encoding="utf-8")
            claude_mirror.write_text("mirror-one", encoding="utf-8")
            first = quality_gate.tree_hash(root)
            agent_mirror.write_text("mirror-two", encoding="utf-8")
            claude_mirror.write_text("mirror-two", encoding="utf-8")
            self.assertEqual(first, quality_gate.tree_hash(root))
            canonical.write_text("canonical-two", encoding="utf-8")
            self.assertNotEqual(first, quality_gate.tree_hash(root))

    def test_report_is_bound_to_current_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "file.txt").write_text("content", encoding="utf-8")
            report = quality_gate.build_report(root, [], [], 80, False, None)
            identity = quality_gate.certification_identity(root)
            self.assertEqual(report["treeHash"], identity["sourceTreeHash"])
            self.assertEqual(report["certificationIdentityDigest"], identity["certificationIdentityDigest"])
            self.assertEqual(report["layoutInputDigest"], identity["layoutInputDigest"])
            self.assertEqual(report["status"], "PASS")
            json.dumps(report)

    def test_certification_identity_uses_bounded_shell_free_node_bridge_and_strict_json(self):
        identity = self.identity()
        completed = CompletedProcess([], 0, stdout=json.dumps(identity), stderr="")
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            quality_gate.subprocess, "run", return_value=completed
        ) as run:
            self.assertEqual(quality_gate.certification_identity(Path(directory), timeout=7), identity)
            command = run.call_args.args[0]
            self.assertEqual(command[:3], ["node", "-e", quality_gate.IDENTITY_BRIDGE])
            self.assertEqual(command[3], str(quality_gate.IDENTITY_MODULE))
            self.assertFalse(run.call_args.kwargs["shell"])
            self.assertEqual(run.call_args.kwargs["timeout"], 7)

            malformed = dict(identity, unexpected=True)
            run.return_value = CompletedProcess([], 0, stdout=json.dumps(malformed), stderr="")
            with self.assertRaises(quality_gate.CertificationIdentityError):
                quality_gate.certification_identity(Path(directory))

    def test_selected_factory_run_uses_canonical_status_and_validates_bounded_id(self):
        completed = CompletedProcess(
            [], 0, stdout="final-root-current-tree-v5-20260830", stderr=""
        )
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            quality_gate.subprocess, "run", return_value=completed
        ) as run:
            root = Path(directory).resolve()
            self.assertEqual(
                quality_gate.selected_factory_run_id(root),
                "final-root-current-tree-v5-20260830",
            )
            self.assertEqual(
                run.call_args.args[0],
                [
                    "node",
                    "-e",
                    quality_gate.RUN_SELECTION_BRIDGE,
                    str(quality_gate.RUN_SELECTION_MODULE),
                    str(root),
                ],
            )
            self.assertFalse(run.call_args.kwargs["shell"])

            completed.stdout = "../escape"
            with self.assertRaises(quality_gate.FactoryRunSelectionError):
                quality_gate.selected_factory_run_id(root)

    def test_main_fails_closed_when_contextual_identity_changes_during_checks(self):
        initial = self.identity()
        changed = self.identity(certification="d")
        successful_result = {
            "argv": ["test"],
            "ok": True,
            "required": True,
            "exitCode": 0,
            "durationMs": 1,
            "outputTail": "all files | 100 | 100 | 100 |",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cli").mkdir()
            (root / "cli" / "package.json").write_text("{}", encoding="utf-8")
            with mock.patch.object(quality_gate, "REQUIRED_DOCS", []), mock.patch.object(
                quality_gate, "certification_identity", side_effect=[initial, changed]
            ), mock.patch.object(
                quality_gate, "selected_factory_run_id", return_value="run-1"
            ), mock.patch.object(quality_gate, "run_command", return_value=successful_result):
                self.assertEqual(quality_gate.main(["--root", str(root)]), 1)

            report = json.loads(
                (root / ".claude" / "state" / "quality_gate_report.json").read_text(encoding="utf-8")
            )
            self.assertIn("Quality checks modified the certification input", report["failures"])
            self.assertEqual(report["treeHash"], changed["sourceTreeHash"])
            self.assertEqual(report["certificationIdentityDigest"], changed["certificationIdentityDigest"])

    def _run_ci_scope(self, root, results):
        with mock.patch.object(quality_gate, "REQUIRED_DOCS", []), mock.patch.object(
            quality_gate, "certification_identity", return_value=self.identity()
        ), mock.patch.object(
            quality_gate, "selected_factory_run_id", side_effect=AssertionError("no run selection in ci scope")
        ), mock.patch.object(quality_gate, "run_command", side_effect=results) as run_command:
            code = quality_gate.main(["--root", str(root), "--scope", "ci"])
        return code, [call.args[0] for call in run_command.call_args_list]

    def test_ci_scope_skips_operator_local_certification_and_never_writes_the_pass_flag(self):
        passing = {
            "argv": ["test"], "ok": True, "required": True, "exitCode": 0, "durationMs": 1,
            "outputTail": "all files | 100 | 100 | 100 |",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cli").mkdir()
            (root / "cli" / "package.json").write_text("{}", encoding="utf-8")
            code, commands = self._run_ci_scope(root, [passing] * 3)
            self.assertEqual(code, 0)
            self.assertFalse(any("certify" in argv for argv in commands))
            state = root / ".claude" / "state"
            report = json.loads((state / "quality_gate_report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "PASS")
            self.assertEqual(report["scope"], "ci")
            self.assertEqual(report["certification"], "operator-local, not run")
            self.assertFalse((state / "quality_gate_passed.json").exists())

    def test_ci_scope_still_fails_closed_on_a_failing_check(self):
        passing = {
            "argv": ["test"], "ok": True, "required": True, "exitCode": 0, "durationMs": 1,
            "outputTail": "all files | 100 | 100 | 100 |",
        }
        failing = {**passing, "ok": False, "exitCode": 1}

        def by_command(argv, *_args, **_kwargs):
            # Suites run concurrently, so the failure is chosen by command, not by call order.
            return failing if "scripts/run_node_tests.js" in argv else passing

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cli").mkdir()
            (root / "cli" / "package.json").write_text("{}", encoding="utf-8")
            code, _ = self._run_ci_scope(root, by_command)
            self.assertEqual(code, 1)
            report = json.loads(
                (root / ".claude" / "state" / "quality_gate_report.json").read_text(encoding="utf-8")
            )
            self.assertIn("Node test suite failed", report["failures"])
            self.assertFalse((root / ".claude" / "state" / "quality_gate_passed.json").exists())

    def test_local_scope_is_the_default_and_keeps_certification_mandatory(self):
        passing = {
            "argv": ["test"], "ok": True, "required": True, "exitCode": 0, "durationMs": 1,
            "outputTail": "all files | 100 | 100 | 100 |",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cli").mkdir()
            (root / "cli" / "package.json").write_text("{}", encoding="utf-8")
            with mock.patch.object(quality_gate, "REQUIRED_DOCS", []), mock.patch.object(
                quality_gate, "certification_identity", return_value=self.identity()
            ), mock.patch.object(
                quality_gate, "selected_factory_run_id", return_value="run-1"
            ), mock.patch.object(quality_gate, "run_command", return_value=passing) as run_command:
                self.assertEqual(quality_gate.main(["--root", str(root)]), 0)
            certify = [call.args[0] for call in run_command.call_args_list if "certify" in call.args[0]]
            self.assertEqual(certify[0][-3:], ["--run", "run-1", "--json"])
            state = root / ".claude" / "state"
            self.assertEqual(json.loads((state / "quality_gate_report.json").read_text(encoding="utf-8"))["scope"], "local")
            self.assertTrue((state / "quality_gate_passed.json").exists())

    def _write_tests_evidence(self, root, run_id, **fields):
        directory = root / ".factory" / "runs" / run_id / "evidence" / "tests"
        directory.mkdir(parents=True, exist_ok=True)
        evidence = {"stepId": "tests", "status": "PASS",
                    "certificationIdentityDigest": "c" * 64, "inputCertificationIdentityDigest": "c" * 64}
        evidence.update(fields)
        (directory / "000001.json").write_text(json.dumps(evidence), encoding="utf-8")

    def test_cli_suite_evidence_is_reused_only_for_the_same_passing_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identity = self.identity()
            self.assertFalse(quality_gate.reusable_cli_test_evidence(root, "run-1", identity))
            self._write_tests_evidence(root, "run-1")
            self.assertTrue(quality_gate.reusable_cli_test_evidence(root, "run-1", identity))
            self.assertFalse(quality_gate.reusable_cli_test_evidence(root, "run-1", self.identity(certification="d")))
            self.assertFalse(quality_gate.reusable_cli_test_evidence(root, None, identity))
            self.assertFalse(quality_gate.reusable_cli_test_evidence(root, "../escape", identity))
            self.assertFalse(quality_gate.reusable_cli_test_evidence(root, "run-1", None))
            self._write_tests_evidence(root, "run-2", status="FAIL")
            self.assertFalse(quality_gate.reusable_cli_test_evidence(root, "run-2", identity))
            self._write_tests_evidence(root, "run-3", inputCertificationIdentityDigest="d" * 64)
            self.assertFalse(quality_gate.reusable_cli_test_evidence(root, "run-3", identity))
            broken = root / ".factory" / "runs" / "run-4" / "evidence" / "tests"
            broken.mkdir(parents=True)
            (broken / "000001.json").write_text("{", encoding="utf-8")
            self.assertFalse(quality_gate.reusable_cli_test_evidence(root, "run-4", identity))

    def test_local_gate_reuses_cli_evidence_and_rechecks_through_the_memoized_runner(self):
        passing = {
            "argv": ["test"], "ok": True, "required": True, "exitCode": 0, "durationMs": 1,
            "outputTail": "all files | 100 | 100 | 100 |",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cli").mkdir()
            (root / "cli" / "package.json").write_text("{}", encoding="utf-8")
            (root / "tests").mkdir()
            (root / "tests" / "vault.test.js").write_text("", encoding="utf-8")
            self._write_tests_evidence(root, "run-1")
            with mock.patch.object(quality_gate, "REQUIRED_DOCS", []), mock.patch.object(
                quality_gate, "certification_identity", return_value=self.identity()
            ), mock.patch.object(
                quality_gate, "selected_factory_run_id", return_value="run-1"
            ), mock.patch.object(quality_gate, "run_command", return_value=passing) as run_command:
                self.assertEqual(quality_gate.main(["--root", str(root)]), 0)
            commands = [call.args[0] for call in run_command.call_args_list]
            self.assertIn(["node", "scripts/run_node_tests.js"], commands)
            self.assertFalse(any(argv[:2] == ["node", "--test"] and "--experimental-test-coverage" not in argv
                                 for argv in commands))
            report = json.loads((root / ".claude" / "state" / "quality_gate_report.json").read_text(encoding="utf-8"))
            self.assertTrue(any("reused PASS evidence of run run-1" in item["outputTail"] for item in report["results"]))

    def test_manifest_coverage_is_policy_source_and_environment_can_tighten_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "factory").mkdir()
            (root / "factory" / "project.json").write_text(
                json.dumps({"quality": {"changedCoverage": 85}}), encoding="utf-8"
            )
            self.assertEqual(quality_gate.coverage_target(root, {}), 85)
            self.assertEqual(quality_gate.coverage_target(root, {"QUALITY_GATE_COVERAGE": "90"}), 90)
            self.assertEqual(quality_gate.coverage_target(root, {"QUALITY_GATE_COVERAGE": "70"}), 85)


class SuiteRunnerTests(unittest.TestCase):
    """The suites memoize per test file inside their runners (ADR-0021); the gate only calls them."""

    def test_the_gate_runs_the_per_file_runners_with_this_interpreter(self):
        passing = {"argv": ["x"], "ok": True, "required": True, "exitCode": 0, "durationMs": 1,
                   "outputTail": "all files | 100 | 100 | 100 |"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cli").mkdir()
            (root / "cli" / "package.json").write_text("{}", encoding="utf-8")
            (root / "tests").mkdir()
            (root / "tests" / "test_x.py").write_text("", encoding="utf-8")
            with mock.patch.object(quality_gate, "certification_identity", return_value=None), \
                    mock.patch.object(quality_gate, "run_command", return_value=passing) as run_command:
                quality_gate.main(["--root", str(root), "--scope", "ci"])
            calls = {tuple(call.args[0]): call for call in run_command.call_args_list}
            self.assertIn(("node", "scripts/run_node_tests.js"), calls)
            self.assertIn(("node", "scripts/run_node_tests.js", "--coverage-gate"), calls)
            python = calls[("node", "scripts/run_python_tests.js")]
            self.assertEqual(python.args[4]["INFRA_TEST_PYTHON"], sys.executable)

    def test_output_that_is_not_cp1252_is_read_not_a_crash(self):
        script = "import sys; sys.stdout.buffer.write(bytes([0x81, 0x9d]) + 'ok ✔'.encode('utf-8'))"
        with tempfile.TemporaryDirectory() as directory:
            result = quality_gate.run_command([sys.executable, "-c", script], Path(directory), True)
        self.assertTrue(result["ok"])
        self.assertIn("ok ✔", result["outputTail"])


if __name__ == "__main__":
    unittest.main()
