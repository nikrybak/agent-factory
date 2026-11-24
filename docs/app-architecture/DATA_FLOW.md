# Data Flow

## Canon-to-tool flow

1. Maintainers edit canonical policy, skills, and integration declarations.
2. `infra validate` checks skill metadata and references.
3. `infra sync` deterministically compiles tool-specific configurations and the web bundle.
4. `infra sync --check` compares expected and actual generated outputs to detect drift.

## Task execution flow

1. Intake converts a request into scope, constraints, risks, and acceptance criteria.
2. Stack detection selects only relevant optional capabilities.
3. Architecture and test contracts establish invariants and evidence requirements.
4. Implementation roles modify the target modules.
5. Test, security, documentation, review, and aggregate quality gates produce evidence.
6. Project memory and checkpoints preserve the resulting state for the next session.

## City Fabric registry flow

1. An operator or gate invokes `infra project resolve` from the current directory.
2. The resolver finds the Factory City root upward, then determines base or child
   scope from `app_entry_root/<key>/`.
3. For a child, it reads the registry record by key and validates its relative
   application/version paths against the child root.
4. The resolver returns a single context: base root, key, knowledge root, optional
   app root, version-aware output root and declarative runtime profile. Declared
   runtime capability names are checked against the local generated skill registry.
5. Gates read docs/tasks from `knowledgeRoot`; no caller concatenates a child path
   manually. Registry scanning detects disk/record drift before work proceeds.

The registry never owns secrets, public URLs, deployment outputs or duplicated
application facts. Those stay with their owning files or ignored local boundaries.

## Ownership

- Canonical configuration owns generated tool configuration.
- The target project owns its application code and stack choices.
- Local ignored overlays own credentials and machine-specific settings.
- Specifications and ADRs own stable behavioral and structural decisions.

## Factory execution flow

1. `init` writes a strict authored manifest and schema without modifying application code.
2. `detect` scans bounded repository evidence and produces a deterministic observation report.
3. `plan` combines manifest, detection, profiles, policy, and trusted provider/adapter catalogs
   into a workflow DAG whose applicable steps carry immutable semantic evidence bindings. Every
   governed catalog is parsed from exact bytes read through the opened-object boundary; each
   binding records the current filesystem-boundary version and capability digest.
4. `run` permits only ready steps, rejects argv/cwd/provider differences before spawn, executes
   every bound command without a shell, and atomically records binding-aware evidence/state.
5. Evidence assessment repeats the plan-binding comparison, so imported or command-only legacy
   evidence cannot satisfy the selected plan. Receipt filesystem assurance must equal its binding
   and the current runtime before a builtin or composite provider may execute.
6. `status` and `resume` reconstruct progress from disk rather than chat memory.
7. `verify` compares required evidence with the current repository tree and returns blocking gaps.
8. `explain` exposes profile, binding, applicability, N/A, readiness, and blocking decisions.

Component and operation targeting refine steps 2 through 5:

1. Detection reads v1.1 marker ownership from the governed stack-signal catalog. A component or
   build-root marker opens a component boundary; a module marker joins only the nearest eligible
   owner whose `ownsModuleFamilies` contains its family. Same-root independent families remain
   separate groups.
2. Exact v1.1 project declarations overlay stable component `id` and `adapterId` on the matching
   family plus root. Multiple adapters for one family require that explicit ID; ambiguity blocks
   planning and never falls back to catalog order.
3. A composite provider selects exact component IDs separately for each operation. Every selected
   target resolves to one argv, an ordered command list, or a justified N/A only when the exact
   adapter declares that operation unsupported. The canonical `${projectRoot}` adapter context is
   resolved through the repository boundary and filesystem identity to the selected component's
   absolute project directory; authored catalogs therefore remain machine-neutral while tools that
   reject relative roots receive an exact path.
4. Runtime executes every executable child in binding order with `shell: false` and the existing
   physical launch checks. One child failure prevents aggregate PASS.
5. Receipt v2 records all command and N/A children. Assessment recomputes target/command aggregates
   against binding v1.1; missing, reordered, relabelled, or legacy children require re-plan/re-run.

A run acquires one exclusive owner-token lock before checkpoint or evidence mutation. Nominal
expiry never transfers ownership. The owner lock remains held through every evidence and
checkpoint mutation. After the last mutation, the exact owner and observed lock object are
revalidated and unlinked; only then may the invocation return success, and no mutation occurs
after release. Replacement or malformed state fails closed and is left untouched.

Before a composite command is persisted in a plan, the redaction boundary rejects any embedded
credential. During execution, raw argv/environment values remain local to the runner; child
stdout/stderr and nested builtin results are sanitized and bounded before component construction,
hashing, evidence persistence, or CLI rendering. Imported evidence is validated, never silently
rewritten.

Authored intent and generated facts are never merged silently: manifest digest and tree identity
bind generated artifacts to the inputs that produced them.

## Physical toolchain trust flow

1. An operator independently confirms the SHA-256 of an absolute non-anchor executable and
   provisions the ignored `.factory/toolchain-trust.json` through the strict versioned schema and
   compare-and-swap internal enrollment contract. There is no PATH enrollment, TOFU or public
   enrollment CLI.
2. Planning reads that overlay once through the opened-object boundary. Presence, exact raw-byte
   digest, opened path identity and filesystem capability form the top-level toolchain plan
   identity; a non-anchor command also seals its logical name, executable digest and the same
   trust-document identity into `toolAuthorization` and `launchDigest`.
3. `planHash` covers the top-level identity and bound commands. Status/run freshness re-resolves
   the overlay, so appearance, disappearance, byte/object/platform/capability drift blocks all
   ready work until re-plan.
4. Immediately before spawn, the launcher reopens the executable and validates physical identity
   plus authorization. The exact anchors `node`, `npm`, and `npx` must bind to the current process
   executable; `npm`/`npx` also reopen their fixed runtime-relative CLI bytes.
5. After the child exits and before evidence construction, the runner repeats the same resolution
   and authorization. A drift error prevents PASS evidence even when the child exited zero.
6. The evidence command receipt retains the planned command and launch binding, and each process
   component repeats `launchDigest`. Assessment requires exact receipt/plan equality.

PATH is a candidate-location mechanism only. Unsupported wrappers/formats and unauthorized tools
become fixed path-free failures or `EVIDENCE_TOOLCHAIN_UNAUTHORIZED`, not fallback execution. A
legitimate binary update requires re-enrollment, re-plan and re-run. Local operator authorization
does not create release-grade provenance or close untested child adapters. Because final spawn is
pathname-based rather than descriptor-relative, same-principal ABA remains the declared P2.

## Factory City certification flow

1. Traceability loads the canonical artifact graph and proves bidirectional reachability.
2. Workforce routing maps policy gates and capabilities to typed roles and handoffs.
3. Adapter planning maps detected families to supported shell-free operations.
4. Trust evaluates tools, roots, and egress; SBOM and provenance bind supply-chain inputs.
5. Golden scenarios evaluate invariants and the ledger records a hash-chained observation.
6. Control aggregates health; delivery creates verification, outward action, and rollback phases.
7. Certification returns `COMPLETE` only when every mandatory report is current and passing.

Layout certification always resolves the enclosing Factory City base before scanning the
registry. A registered child validates only findings attributed to its canonical key, while
the base validates the complete registry. Canonical `app_entry_root/<key>/_output/<key>-<version>/` is
never reinterpreted as a legacy base-level output merely because certification started inside
the child.

`treeHash` remains the stable authored source-tree identity. The leaf identity module combines
that value with the normalized resolver-owned layout input into a separate
`certificationIdentityDigest`. Workflow execution/freshness, verify, certify, current v2
provenance, certification-ledger observation, passing delivery plans, and the Python quality
snapshot all consume that same contextual digest. A same-key registry or illegal-layout change
therefore stales existing evidence, while unrelated sibling drift does not stale a registered
child's evidence.

Current provenance binds the deterministic digest set of accepted fresh evidence. Current
ledger certification requires a chain-valid head whose PASS event matches both `treeHash` and
`certificationIdentityDigest`; historical formats remain auditable but are not current proof.

Structural provenance remains distinct from release trust. City and prepare-only delivery may
use a current unsigned attestation and label it advisory. After the selected workflow is COMPLETE,
a release assessment verifies a domain-separated Ed25519 signature against the exact current
trust-policy key allowlist and policy digest. Only that assessment may satisfy the additional
provenance condition for release, deploy, or publish; it never grants authority.

For the selected run, the authoritative attempt is the numerically latest attempt for each step
that has evidence. Provenance accepts it only when the evidence digest, plan hash, source tree,
contextual identity, status, timestamps, and expiry are valid; accepted digests are de-duplicated
and sorted. A present stale/failed/invalid authoritative attempt or an empty accepted set is a
named provenance gap. Missing future workflow steps are handled by `verify`, not provenance, so
the City-certification step can run before downstream quality and checkpoint steps.

Runner records `inputTreeHash`/`sourceTreeHash` and
`inputCertificationIdentityDigest`/`certificationIdentityDigest`. A difference in either pair
means the gate modified its certification input and produces FAIL.

Ledger integrity and current certification are deliberately separate. The structural verifier
allows an empty valid chain to be appended to; the normal City ledger district rejects empty,
stale, mismatched, or current-FAIL heads. `observe --record` computes a candidate verdict with
only ledger currentness neutralized, appends that PASS/FAIL event, and then recomputes the full
City verdict from the new head.

Observation recording acquires the single project ledger lock before reading the chain. The
candidate is calculated from that injected immutable snapshot, the store rechecks the same head
and sequence immediately before commit, writes and flushes a unique same-directory temporary
file, atomically replaces the canonical JSONL file, and computes the returned post-state from the
committed chain before releasing its owner-token lock.

The workflow orders semantic `evals` before `observability`. The internal eval command therefore
uses the same candidate ledger view: chain integrity and all non-ledger assertions remain
mandatory, but an empty or stale certification head does not deadlock the step that must precede
its refresh. The subsequent observation records the candidate verdict; ordinary certify then
requires the new current PASS head.

Stage-sensitive providers use one explicit selected-run snapshot. Eval is authorized only while
`evals` is READY, recording only while `observability` is READY, and full City/prepare only while
`city-certification` is READY or the run is COMPLETE. Candidate reports never use COMPLETE. City
may complete before downstream quality/checkpoint only while exposing `workflowComplete: false`;
outward actions require workflow COMPLETE and release checkpoint itself remains prepare-only.

Stage-provider exceptions cross a pure versioned classifier before receipt construction. Only
fixed allowlisted codes, categories, operation names, and retryability survive; all raw exception
state is discarded and recursive redaction remains a second boundary.

A passing prepare/release/deploy/publish plan copies the source and contextual identities from
the complete certification and names both tree and certification identity in its verification
phase. Blocked or denied plans carry no proof claim and cannot authorize an external action.

The manifest owns authority, catalogs own capabilities, the graph owns lineage, evidence
owns observed execution, and the ledger owns history; generated observations never rewrite canon.
