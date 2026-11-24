#!/usr/bin/env python3
"""Fail-closed, tree-bound quality gate for the local software factory."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

FACTORY_ROOT = Path(__file__).resolve().parents[1]
IDENTITY_MODULE = FACTORY_ROOT / "cli" / "lib" / "factory" / "identity.js"
RUN_SELECTION_MODULE = FACTORY_ROOT / "cli" / "lib" / "factory" / "engine.js"
IDENTITY_BRIDGE = (
    "const identity = require(process.argv[1]);"
    "process.stdout.write(JSON.stringify(identity.computeCertificationIdentity(process.argv[2])));"
)
RUN_SELECTION_BRIDGE = (
    "const engine = require(process.argv[1]);"
    "process.stdout.write(engine.selectedRunId(process.argv[2]));"
)
IDENTITY_KEYS = {
    "schemaVersion",
    "scope",
    "key",
    "sourceTreeHash",
    "layoutInputDigest",
    "certificationIdentityDigest",
}
IDENTITY_DIGEST = re.compile(r"^[0-9a-f]{64}$")
SAFE_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

EXCLUDED_DIRS = {
    ".git", ".factory", "node_modules", "vendor", ".venv", "coverage",
    "playwright-report", "test-results", ".pytest_cache", "__pycache__",
}


class CertificationIdentityError(RuntimeError):
    """Raised when the canonical Node certification identity is unavailable or invalid."""


class FactoryRunSelectionError(RuntimeError):
    """Raised when the canonical Factory CLI cannot select one bounded run."""


def selected_factory_run_id(root: Path, timeout: int = 30) -> str:
    """Resolve the latest run once through the canonical engine and validate its identifier."""
    root = root.resolve()
    if not RUN_SELECTION_MODULE.is_file():
        raise FactoryRunSelectionError("canonical Factory run selector is missing")
    try:
        process = subprocess.run(
            ["node", "-e", RUN_SELECTION_BRIDGE, str(RUN_SELECTION_MODULE), str(root)],
            cwd=str(root),
            shell=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise FactoryRunSelectionError(
            f"Factory run selection failed: {type(error).__name__}"
        ) from error

    if process.returncode != 0:
        raise FactoryRunSelectionError(
            f"Factory run selection failed with exit code {process.returncode}"
        )
    output = process.stdout or ""
    if len(output.encode("utf-8")) > 256:
        raise FactoryRunSelectionError("Factory run selection output is too large")
    run_id = output.strip()
    if not SAFE_RUN_ID.fullmatch(run_id):
        raise FactoryRunSelectionError("Factory run selection returned an invalid run id")
    return run_id


def certification_identity(root: Path, timeout: int = 30) -> dict:
    """Resolve the canonical contextual identity without reimplementing it in Python."""
    root = root.resolve()
    if not IDENTITY_MODULE.is_file():
        raise CertificationIdentityError("canonical certification identity module is missing")
    try:
        process = subprocess.run(
            ["node", "-e", IDENTITY_BRIDGE, str(IDENTITY_MODULE), str(root)],
            cwd=str(root),
            shell=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CertificationIdentityError(
            f"canonical certification identity could not be computed: {type(error).__name__}"
        ) from error

    if process.returncode != 0:
        raise CertificationIdentityError(
            f"canonical certification identity failed with exit code {process.returncode}"
        )
    output = process.stdout or ""
    if len(output.encode("utf-8")) > 16_384:
        raise CertificationIdentityError("canonical certification identity output is too large")
    try:
        identity = json.loads(output)
    except json.JSONDecodeError as error:
        raise CertificationIdentityError("canonical certification identity returned invalid JSON") from error

    if not isinstance(identity, dict) or set(identity) != IDENTITY_KEYS:
        raise CertificationIdentityError("canonical certification identity has an invalid shape")
    if identity["schemaVersion"] != "1.0.0" or identity["scope"] not in {"base", "child", "standalone"}:
        raise CertificationIdentityError("canonical certification identity has invalid metadata")
    if identity["scope"] == "child":
        if not isinstance(identity["key"], str) or not identity["key"]:
            raise CertificationIdentityError("child certification identity is missing its key")
    elif identity["key"] is not None:
        raise CertificationIdentityError("non-child certification identity must not contain a key")
    for field in ("sourceTreeHash", "layoutInputDigest", "certificationIdentityDigest"):
        if not isinstance(identity[field], str) or not IDENTITY_DIGEST.fullmatch(identity[field]):
            raise CertificationIdentityError(f"canonical certification identity has invalid {field}")
    return identity


REQUIRED_DOCS = [
    "CLAUDE.md",
    "docs/app-architecture/ARCHITECTURE.md",
    "docs/app-architecture/MODULE_REGISTRY.md",
    "docs/app-architecture/TESTING_CONTRACT.md",
    "docs/testing/TEST_STRATEGY.md",
    "docs/testing/COVERAGE_POLICY.md",
    "docs/governance/DEFINITION_OF_DONE.md",
    "docs/operations/MEMORY.md",
    "docs/operations/CHECKPOINTS.md",
]


def _excluded(relative: Path, *, city_fabric_base: bool = True) -> bool:
    parts = relative.parts
    is_local_child_tree = (
        city_fabric_base
        and len(parts) > 2
        and parts[0] == "app_entry_root"
        and parts[1] != "_registry"
        and parts[2] != "_project"
    )
    return (
        any(part in EXCLUDED_DIRS for part in parts)
        or parts[:2] == (".claude", "state")
        or (city_fabric_base and parts[:2] in {(".claude", "skills"), (".agents", "skills")})
        or is_local_child_tree
    )


def tree_hash(root: Path) -> str:
    """Hash stable project source while excluding VCS, dependencies, and local evidence."""
    root = root.resolve()
    city_fabric_base = (root / "app_entry_root" / "_registry" / "registry.json").is_file()
    digest = hashlib.sha256()
    for file in sorted((item for item in root.rglob("*") if item.is_file()), key=lambda item: item.as_posix()):
        relative = file.relative_to(root)
        if _excluded(relative, city_fabric_base=city_fabric_base) or file.is_symlink():
            continue
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(file.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def reusable_cli_test_evidence(root: Path, run_id: str | None, identity: dict | None) -> bool:
    """True when the selected factory run already proved the CLI suite on exactly this input.

    The certification `tests` step runs the same CLI suite (`npm test` in `cli`). Its newest evidence is
    reused only when it passed and both its input and resulting identity equal the current one; any
    other state runs the suite again (ADR-0021).
    """
    if not run_id or not SAFE_RUN_ID.match(run_id) or not identity:
        return False
    directory = root / ".factory" / "runs" / run_id / "evidence" / "tests"
    try:
        newest = sorted(directory.glob("*.json"))[-1]
        evidence = json.loads(newest.read_text(encoding="utf-8"))
    except (OSError, ValueError, IndexError):
        return False
    digest = identity.get("certificationIdentityDigest")
    return (
        isinstance(evidence, dict)
        and evidence.get("stepId") == "tests"
        and evidence.get("status") == "PASS"
        and evidence.get("certificationIdentityDigest") == digest
        and evidence.get("inputCertificationIdentityDigest") == digest
    )


def echo(text: str) -> None:
    """Print a suite's output on any console: characters the console code page cannot show become '?', never a crash."""
    encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
    print(text.encode(encoding, errors="replace").decode(encoding, errors="replace"))


def run_command(argv: list[str], cwd: Path, required: bool, timeout: int = 600,
                env: dict[str, str] | None = None) -> dict:
    """Execute an argv command without a shell and return bounded evidence.

    The suites memoize themselves per test file (scripts/run_node_tests.js, scripts/run_python_tests.js, ADR-0021):
    a file whose traced inputs are unchanged is not run again, so the gate needs no whole-tree memo of its own.
    """
    if not isinstance(argv, list) or not argv or not all(isinstance(value, str) and value for value in argv):
        raise TypeError("quality commands must be non-empty argv lists")
    echo(f"\n$ {' '.join(argv)}")
    started = time.monotonic()
    try:
        process = subprocess.run(
            argv,
            cwd=str(cwd),
            shell=False,
            # UTF-8 whatever the console code page: a cp1252 reader crashed on the suites' output (2026-10-29)
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
            env=env,
        )
        output = process.stdout or ""
        ok = process.returncode == 0
        exit_code = process.returncode
    except Exception as error:
        output = f"ERROR: {error}"
        ok = False
        exit_code = None
    echo(output[-6000:])
    return {
        "argv": argv,
        "ok": ok,
        "required": required,
        "exitCode": exit_code,
        "durationMs": round((time.monotonic() - started) * 1000),
        "outputTail": output[-6000:],
    }


def parse_node_coverage(output: str) -> dict | None:
    """The merged table of `run_node_tests.js --coverage-gate` ("# all files | ..."), never a single file's own table.

    A failing test file echoes its output, which holds that one file's coverage table in Node's spec format
    ("ℹ all files | ..."); read as the total it showed 66.60 % lines on 2026-10-31 instead of the real figure.
    """
    pattern = r"all files\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|"
    match = re.search(r"^#\s*" + pattern, output, re.IGNORECASE | re.MULTILINE)
    if not match:
        match = re.search(r"^(?!ℹ)\s*" + pattern, output, re.IGNORECASE | re.MULTILINE)
    if not match:
        return None
    return {"lines": float(match.group(1)), "branches": float(match.group(2)), "functions": float(match.group(3))}


def coverage_failures(metrics: dict | None, target: int) -> list[str]:
    if metrics is None:
        return ["Coverage report could not be parsed"]
    return [f"Coverage {name} {value:.2f}% is below {target}%" for name, value in metrics.items() if value < target]


def coverage_target(root: Path, environ: dict[str, str]) -> int:
    declared = 80
    manifest = root / "factory" / "project.json"
    if manifest.exists():
        try:
            declared = int(json.loads(manifest.read_text(encoding="utf-8"))["quality"]["changedCoverage"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            pass
    configured = int(environ.get("QUALITY_GATE_COVERAGE", declared))
    return max(declared, configured)


def build_report(root: Path, results: list[dict], failures: list[str], target: int,
                 strict: bool, coverage: dict | None, identity: dict | None = None) -> dict:
    identity = identity or certification_identity(root)
    return {
        "schemaVersion": "1.0.0",
        "status": "PASS" if not failures else "FAIL",
        "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "treeHash": identity["sourceTreeHash"],
        "certificationIdentityDigest": identity["certificationIdentityDigest"],
        "layoutInputDigest": identity["layoutInputDigest"],
        "targetCoverage": target,
        "coverage": coverage,
        "strict": strict,
        "results": results,
        "failures": failures,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    # ADR-0019: `ci` runs every check a clean runner can prove. Factory City certification needs an
    # operator-enrolled toolchain and a local run (ADR-0014), so it is reported as not run there,
    # and a ci-scope result never writes the PASS flag that authorizes commit and release.
    parser.add_argument("--scope", choices=("local", "ci"), default="local")
    options = parser.parse_args(argv)
    root = Path(options.root).resolve()
    ci_scope = options.scope == "ci"
    state = root / ".claude" / "state"
    state.mkdir(parents=True, exist_ok=True)
    strict = os.environ.get("QUALITY_GATE_STRICT", "1") != "0"
    target = coverage_target(root, os.environ)
    results: list[dict] = []
    failures: list[str] = []
    initial_identity = None
    selected_run = None
    # the identity and the run selection are independent reads: two processes at once (ADR-0021)
    with ThreadPoolExecutor(max_workers=2) as pool:
        identity_future = pool.submit(certification_identity, root)
        run_future = None if ci_scope else pool.submit(selected_factory_run_id, root)
        try:
            initial_identity = identity_future.result()
        except CertificationIdentityError as error:
            failures.append(str(error))
        if run_future is not None:
            try:
                selected_run = run_future.result()
            except FactoryRunSelectionError as error:
                failures.append(str(error))

    for relative in REQUIRED_DOCS:
        if not (root / relative).exists():
            failures.append(f"Missing required doc: {relative}")

    results.append(run_command(["git", "status", "--short"], root, required=False))

    # Independent suites run concurrently (ADR-0021). The memoized Node runner re-executes only test files
    # whose content key has not passed, so after the certification `tests` step it finishes in seconds.
    jobs: dict[str, list[str]] = {}
    coverage = None
    if (root / "cli" / "package.json").exists():
        if reusable_cli_test_evidence(root, selected_run, initial_identity):
            results.append({"argv": ["npm", "test"], "ok": True, "required": True, "exitCode": 0,
                            "durationMs": 0, "outputTail": f"reused PASS evidence of run {selected_run}"})
        jobs["node"] = ["node", "scripts/run_node_tests.js"]
        # every cli/test suite but factory-cli-commands, one process per file, its LCOV memoized on its reads and merged
        jobs["coverage"] = ["node", "scripts/run_node_tests.js", "--coverage-gate"]
    else:
        failures.append("cli/package.json is missing")
    if sorted((root / "tests").glob("test_*.py")):
        # one module per process through the same per-file memo, on this interpreter
        jobs["python"] = ["node", "scripts/run_python_tests.js"]
    job_env = {**os.environ, "INFRA_TEST_PYTHON": sys.executable}

    # Factory City certification only reads the tree and the run's evidence, so it runs beside the suites; the final
    # identity comparison below still catches any job that wrote into the certification input.
    city_argv = None
    if not ci_scope:
        city_argv = ["node", "cli/bin/infra.js", "certify", "--project", str(root)]
        if selected_run is not None:
            city_argv.extend(["--run", selected_run])
        city_argv.append("--json")
    with ThreadPoolExecutor(max_workers=len(jobs) + 1) as pool:
        futures = {name: pool.submit(run_command, argv, root, True, 600, job_env) for name, argv in jobs.items()}
        city_future = pool.submit(run_command, city_argv, root, True) if city_argv else None
        outcomes = {name: future.result() for name, future in futures.items()}
        city_result = city_future.result() if city_future else None
    for name in ("node", "coverage", "python"):
        if name in outcomes:
            results.append(outcomes[name])
    if "node" in outcomes and not outcomes["node"]["ok"]:
        failures.append("Node test suite failed")
    if "coverage" in outcomes:
        if outcomes["coverage"]["ok"]:
            coverage = parse_node_coverage(outcomes["coverage"]["outputTail"])
            failures.extend(coverage_failures(coverage, target))
        else:
            # a failed run has no merged table; its failing file's own figures say nothing about the total
            failures.append("Factory coverage suite failed")
    if "python" in outcomes and not outcomes["python"]["ok"]:
        failures.append("Python unit tests failed")

    if city_result is not None:
        results.append(city_result)
        if not city_result["ok"]:
            failures.append("Factory City certification failed")

    final_identity = None
    try:
        final_identity = certification_identity(root)
    except CertificationIdentityError as error:
        failures.append(str(error))
    if initial_identity is not None and final_identity is not None and final_identity != initial_identity:
        failures.append("Quality checks modified the certification input")

    report_identity = final_identity or initial_identity
    if report_identity is None:
        report = {
            "schemaVersion": "1.0.0",
            "status": "FAIL",
            "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "treeHash": None,
            "certificationIdentityDigest": None,
            "layoutInputDigest": None,
            "targetCoverage": target,
            "coverage": coverage,
            "strict": strict,
            "results": results,
            "failures": failures,
        }
    else:
        report = build_report(root, results, failures, target, strict, coverage, report_identity)
    report["scope"] = options.scope
    report["certification"] = "operator-local, not run" if ci_scope else "run"
    report_path = state / "quality_gate_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    passed_path = state / "quality_gate_passed.json"
    if ci_scope:
        print(f"\nQUALITY GATE (ci scope): {report['status']}")
        print("- Factory City certification is operator-local (ADR-0019) and was not run;")
        print("  this result does not authorize commit, push or release.")
        for failure in failures:
            print(f"- {failure}")
        return 0 if report["status"] == "PASS" else 1
    if report["status"] == "PASS":
        passed_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("\nQUALITY GATE: PASS")
        return 0
    passed_path.unlink(missing_ok=True)
    print("\nQUALITY GATE: FAIL")
    for failure in failures:
        print(f"- {failure}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
