#!/usr/bin/env node
'use strict';

// Fast path (ADR-0021 amendment): `infra queue ...` needs only the queue module. Loading the other ~40 modules of this
// CLI first cost about 100 ms per queued job (measured 2026-10-26), a third of the overhead of every build and test run.
if (require.main === module && process.argv[2] === 'queue') {
  require('../lib/machine-queue').queueMain(process.argv.slice(3)).then(code => { process.exitCode = code; });
  return;
}

const path = require('node:path');
const crypto = require('node:crypto');
const { loadCanon, resolveSkillsDir } = require('../lib/load-canon');
const { readSkills } = require('../lib/read-skills');
const { syncTargets } = require('../lib/sync');
const { syncSkills } = require('../lib/skills-sync');
const { checkDrift } = require('../lib/check');
const { validateSkills } = require('../lib/validate');
const { scanMachinePaths } = require('../lib/machine-paths');
const { scanDefectLedgers } = require('../lib/defect-lessons');
const {
  childPaths, findBaseRoot, initMarket, listProjects, marketPaths, readRegistry,
  resolveProject, resolveProjectKey, scanProjects,
} = require('../lib/project');
const { doctor } = require('../lib/doctor');
const { queueMain } = require('../lib/machine-queue');
const { impactedMain } = require('../lib/impacted');
const { testdbMain } = require('../lib/testdb');
const { testcacheMain } = require('../lib/testcache');
const { cleanMain } = require('../lib/clean');
const { writeSecretOverlay } = require('../lib/secret-overlay');
const { ArgsError, NEW_COMMANDS, parseFactoryArgs } = require('../lib/factory/args');
const {
  collectAcceptedEvidenceFromStatus, detectProject, explainProject, initProject, planProject, resumeProject,
  runProjectStep, statusProject, verifyProject,
} = require('../lib/factory/engine');
const { EXIT_CODES, formatFactoryError, formatJsonEnvelope } = require('../lib/factory/output');
const { compileRedactionPolicy, redactError, redactValue } = require('../lib/factory/redaction');
const { loadManifest } = require('../lib/factory/manifest');
const { loadArtifactGraph, analyzeArtifactGraph } = require('../lib/factory/traceability');
const { routeWorkforce } = require('../lib/factory/workforce');
const {
  canonicalAdapterProjectRoot, selectAdapters, planAdapterOperation,
} = require('../lib/factory/adapters');
const { evaluateTrust } = require('../lib/factory/trust');
const { generateSbom } = require('../lib/factory/sbom');
const {
  assessReleaseProvenance, createAttestation, signReleaseAttestation, verifyAttestation,
} = require('../lib/factory/provenance');
const { stableDigest } = require('../lib/factory/stable-json');
const { evaluateAssertions } = require('../lib/factory/evals');
const { assessCertificationLedger, summarizeLedger } = require('../lib/factory/ledger');
const { readLedger } = require('../lib/factory/ledger-store');
const { planDelivery } = require('../lib/factory/delivery');
const { certifyCity, recordCityCertification } = require('../lib/factory/city');
const { computeCertificationIdentity } = require('../lib/factory/identity');
const { assessWorkflowStage } = require('../lib/factory/workflow-stage');
const { atomicWriteJson } = require('../lib/factory/store');
const { loadCatalog } = require('../lib/factory/catalog-loader');
const fs = require('node:fs');

function opt(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

function legacyMain(args) {
  const cmd = args[0];
  const from = path.resolve(opt(args, '--from', process.cwd()));
  const out = path.resolve(opt(args, '--out', process.cwd()));
  try {
    if (cmd === 'sync' && args.includes('--check')) {
      const canon = loadCanon(from);
      const skills = readSkills(resolveSkillsDir(from, canon.config));
      const { drifted, missing } = checkDrift(canon, skills, out);
      if (drifted.length || missing.length) {
        console.error(`[infra] drift: ${[...drifted, ...missing].join(', ')}`);
        return EXIT_CODES.DRIFT;
      }
      console.log('[infra] in sync');
    } else if (cmd === 'sync') {
      const canon = loadCanon(from);
      const skills = readSkills(resolveSkillsDir(from, canon.config));
      const written = syncTargets(canon, skills, out);
      // Mirrors are off by default: every tool reads its own user-level skills directory, all

      // published from the shared store, so a project copy adds nothing - and this base is copied

      // wholesale to start a project, which drags mirrors along and recreates the duplication.

      const copiedSkills = canon.config.canon.skillsMirror

        ? syncSkills(resolveSkillsDir(from, canon.config), out, undefined, canon.config.canon.skillsInclude)

        : [];
      const hadLocal = writeSecretOverlay(from, out);
      if (hadLocal) process.stderr.write('[infra] wrote .codex/config.local.toml (local secrets, gitignored)\n');
      console.log(`[infra] wrote: ${written.join(', ')} + ${copiedSkills.length} skills`);
    } else if (cmd === 'validate') {
      const canon = loadCanon(from);
      const issues = validateSkills(resolveSkillsDir(from, canon.config), canon.config.canon.skillsInclude);
      if (issues.length) {
        for (const issue of issues) console.error(`[infra] ${issue.skill}: ${issue.problem}`);
        return EXIT_CODES.VALIDATION_FAILED;
      }
      const baseRoot = findBaseRoot(from);
      if (baseRoot) {
        readRegistry(baseRoot);
        const projectDrift = scanProjects(baseRoot);
        if (projectDrift.length) {
          for (const finding of projectDrift) {
            console.error(`[infra] project layout ${finding.key}: ${finding.problem}`);
          }
          return EXIT_CODES.VALIDATION_FAILED;
        }
        const machinePaths = scanMachinePaths(baseRoot);
        if (machinePaths.length) {
          for (const finding of machinePaths) {
            console.error(`[infra] machine path ${finding.file}:${finding.line}: ${finding.hit} | ${finding.text}`);
          }
          return EXIT_CODES.VALIDATION_FAILED;
        }
        const lessonIssues = scanDefectLedgers(baseRoot);
        if (lessonIssues.length) {
          for (const finding of lessonIssues) {
            console.error(`[infra] defect lesson ${finding.file} ${finding.id}: ${finding.problem}`);
          }
          return EXIT_CODES.VALIDATION_FAILED;
        }
        console.log('[infra] skills and project registry valid; no machine-specific paths; defects carry lessons');
      } else {
        console.log('[infra] skills valid');
      }
    } else if (cmd === 'doctor') {
      const fix = args.includes('--fix');
      let result = doctor(from, out);
      for (const { level, msg } of result.issues) console.log(`[infra] ${level}: ${msg}`);
      if (fix) {
        try {
          const canon = loadCanon(from);
          const skills = readSkills(resolveSkillsDir(from, canon.config));
          syncTargets(canon, skills, out);
          if (canon.config.canon.skillsMirror) {

            syncSkills(resolveSkillsDir(from, canon.config), out, undefined, canon.config.canon.skillsInclude);

          }
        } catch (error) {
          process.stderr.write(`[infra] fix failed: ${error.message}\n`);
        }
        result = doctor(from, out);
        console.log('[infra] --- after fix ---');
        for (const { level, msg } of result.issues) console.log(`[infra] ${level}: ${msg}`);
      }
      const counts = level => result.issues.filter(issue => issue.level === level).length;
      console.log(`[infra] doctor: ${result.ok ? 'OK' : 'FAIL'} — ${counts('error')} error(s), ${counts('warn')} warn(s), ${counts('info')} info(s)`);
    } else if (cmd === 'project') {
      const subcommand = args[1] && !args[1].startsWith('--') ? args[1] : 'resolve';
      const cwd = path.resolve(opt(args, '--cwd', from));
      const baseRoot = findBaseRoot(cwd);
      if (subcommand === 'resolve') {
        const key = args[2] && !args[2].startsWith('--') ? args[2] : null;
        if (key && !baseRoot) {
          console.error('[infra] Factory City root not found; cannot resolve a registered key');
          return EXIT_CODES.VALIDATION_FAILED;
        }
        const resolved = key ? resolveProjectKey(baseRoot, key, opt(args, '--version', undefined)) : resolveProject(cwd);
        if (args.includes('--json')) console.log(JSON.stringify(resolved, null, 2));
        else {
          console.log(`[infra] project scope: ${resolved.scope}${resolved.key ? ` (${resolved.key})` : ''}${resolved.packageName ? ` (package ${resolved.packageName})` : ''} — ${resolved.reason}`);
          if (resolved.baseRoot) console.log(`[infra] base root: ${resolved.baseRoot}`);
          if (resolved.knowledgeRoot) console.log(`[infra] knowledge root: ${resolved.knowledgeRoot}`);
          if (resolved.outputRoot) console.log(`[infra] output root: ${resolved.outputRoot}`);
          if (resolved.appRoot) console.log(`[infra] app root: ${resolved.appRoot}`);
          if (resolved.packageRoot) console.log(`[infra] package root: ${resolved.packageRoot}`);
          if (resolved.scope === 'child' && !resolved.inRegistry) console.error('[infra] project is not registered');
        }
      } else if (subcommand === 'list') {
        if (!baseRoot) return EXIT_CODES.VALIDATION_FAILED;
        console.log(JSON.stringify(listProjects(baseRoot), null, 2));
      } else if (subcommand === 'paths') {
        const key = args[2];
        if (!baseRoot || !key) {
          console.error('usage: infra project paths <key> [--version <id>] [--cwd DIR]');
          return EXIT_CODES.USAGE;
        }
        if (!readRegistry(baseRoot).projects.some(project => project.key === key)) {
          console.error(`[infra] project key is not registered: ${key}`);
          return EXIT_CODES.VALIDATION_FAILED;
        }
        console.log(JSON.stringify(childPaths(baseRoot, key, opt(args, '--version', undefined)), null, 2));
      } else if (subcommand === 'market') {
        const key = args[2] && !args[2].startsWith('--') ? args[2] : null;
        if (!baseRoot || !key) {
          console.error('usage: infra project market <key> [--version <id>] [--init] [--json] [--cwd DIR]');
          return EXIT_CODES.USAGE;
        }
        const version = opt(args, '--version', undefined);
        const market = args.includes('--init') ? initMarket(baseRoot, key, version) : marketPaths(baseRoot, key, version);
        if (args.includes('--json')) console.log(JSON.stringify(market, null, 2));
        else {
          console.log(`[infra] market ${key} ${market.version}: ${market.stores.length} store(s) × ${market.locales.length} locale(s)`);
          for (const store of market.stores) {
            const extra = market.storeLocales[store].slice(market.locales.length);
            if (extra.length > 0) console.log(`[infra] ${store}: +${extra.length} store-only locale(s) (${extra.join(', ')})`);
          }
          console.log(`[infra] listing texts: ${market.marketRoot}`);
          console.log(`[infra] captures: ${market.marketOutputRoot}`);
          if (market.created) console.log(`[infra] created ${market.created.length} entr${market.created.length === 1 ? 'y' : 'ies'}`);
        }
      } else if (subcommand === 'scan') {
        if (!baseRoot) return EXIT_CODES.VALIDATION_FAILED;
        const drift = scanProjects(baseRoot);
        if (drift.length) {
          for (const item of drift) console.error(`[infra] ${item.key}: ${item.problem}`);
          return EXIT_CODES.DRIFT;
        }
        console.log('[infra] project registry matches local child layout');
      } else {
        console.error('usage: infra project <resolve [key] [--version <id>] [--json] | list | paths <key> [--version <id>] | market <key> [--version <id>] [--init] [--json] | scan> [--cwd DIR]');
        return EXIT_CODES.USAGE;
      }
    } else {
      console.log(`usage: infra <sync [--check] | validate | doctor [--fix] | project <resolve|list|paths|market|scan> | queue <run|status|stats> | impacted | testdb <up|down|list> | testcache cargo | clean <targets|docker|all> | runners <build|up|down|status|install> | ${NEW_COMMANDS.join(' | ')}>`);
    }
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    console.error(error.message);
    return EXIT_CODES.VALIDATION_FAILED;
  }
}

function human(command, status, data, policy) {
  console.log(`[infra] ${command}: ${status}`);
  console.log(JSON.stringify(redactValue(data, { policy }), null, 2));
}

function factoryOutputPolicy(args = []) {
  return compileRedactionPolicy({ argv: args, env: process.env });
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function externalPrivateKey(root, filename) {
  const unavailable = () => {
    const error = new Error('private signing key is unavailable or not allowed');
    error.code = 'PROVENANCE_PRIVATE_KEY_UNAVAILABLE';
    return error;
  };
  try {
    const projectRoot = fs.realpathSync.native(path.resolve(root));
    const lexicalPath = path.resolve(filename);
    if (isWithin(projectRoot, lexicalPath)) throw unavailable();
    const keyPath = fs.realpathSync.native(lexicalPath);
    if (isWithin(projectRoot, keyPath)) throw unavailable();
    return fs.readFileSync(keyPath);
  } catch (error) {
    if (error?.code === 'PROVENANCE_PRIVATE_KEY_UNAVAILABLE') throw error;
    throw unavailable();
  }
}

function selectedStageContext(root, options, purpose) {
  const runSnapshot = statusProject(root, options.run ? { run: options.run } : {});
  const explicitRun = typeof options.run === 'string' && options.run.length > 0;
  const stageAssessment = assessWorkflowStage({
    purpose,
    runSnapshot,
    explicitRun,
  });
  const evidenceSelection = collectAcceptedEvidenceFromStatus(runSnapshot);
  return { purpose, explicitRun, runSnapshot, stageAssessment, evidenceSelection };
}

async function factoryMain(args) {
  let parsed;
  try {
    parsed = parseFactoryArgs(args);
  } catch (error) {
    process.stderr.write(formatFactoryError(error, { policy: factoryOutputPolicy(args) }));
    return error instanceof ArgsError ? EXIT_CODES.USAGE : EXIT_CODES.INTERNAL_ERROR;
  }
  const { command, options } = parsed;
  const outputPolicy = factoryOutputPolicy(args);
  const root = path.resolve(options.project || process.cwd());
  try {
    let data;
    let status = 'PASS';
    let code = EXIT_CODES.SUCCESS;
    const common = { ...options, run: options.run, dryRun: options.dryRun };
    if (command === 'init') {
      const profiles = options.profile ? options.profile.split(',').filter(Boolean) : [];
      data = initProject(root, { ...common, profiles });
      status = data.status === 'planned' ? 'PLANNED' : 'PASS';
    } else if (command === 'detect') {
      data = detectProject(root, common);
      status = data.gaps.length ? 'PASS_WITH_GAPS' : 'PASS';
    } else if (command === 'plan') {
      data = planProject(root, common);
      if (data.plan.policy.status !== 'ready') { status = 'PASS_WITH_GAPS'; code = EXIT_CODES.CAPABILITY_GAP; }
    } else if (command === 'run') {
      if (options.dryRun) { data = { runId: options.run, step: options.step, commandArgv: options.commandArgv }; status = 'PLANNED'; }
      else {
        data = await runProjectStep(root, common);
        status = data.evidence.status;
        if (status === 'FAIL') code = EXIT_CODES.EXECUTION_FAILED;
      }
    } else if (command === 'status') {
      data = statusProject(root, common);
      status = data.workflow.runState === 'COMPLETE' ? 'COMPLETE' : data.workflow.runState === 'RUNNING' ? 'RUNNING' : 'PAUSED';
    } else if (command === 'resume') {
      data = resumeProject(root, common);
      status = data.runState === 'COMPLETE' ? 'COMPLETE' : 'PAUSED';
    } else if (command === 'verify') {
      data = verifyProject(root, common);
      status = data.status;
      if (status === 'FAIL') code = EXIT_CODES.VALIDATION_FAILED;
    } else if (command === 'explain') {
      data = explainProject(root, common);
    } else if (command === 'trace') {
      data = analyzeArtifactGraph(loadArtifactGraph(root), root);
      status = data.status === 'pass' ? 'PASS' : 'FAIL';
      if (status === 'FAIL') code = EXIT_CODES.VALIDATION_FAILED;
    } else if (command === 'workforce') {
      const plan = planProject(root, { dryRun: true, runId: 'workforce-plan' }).plan;
      data = routeWorkforce({ catalog: loadCatalog(root, 'factory/catalog/roles.json'), plan, detection: plan.detection });
      status = data.status === 'ready' ? 'PASS' : 'FAIL';
      if (status === 'FAIL') code = EXIT_CODES.CAPABILITY_GAP;
    } else if (command === 'adapters') {
      const catalog = loadCatalog(root, 'factory/catalog/adapters.json');
      const loaded = loadManifest(root);
      if (options.operation) {
        if (!options.family) throw new Error('--family is required with --operation');
        const declared = (loaded.manifest.stack?.declared || [])
          .filter(component => component.family === options.family);
        const matches = declared.length
          ? declared : detectProject(root).components.filter(component => component.family === options.family);
        if (matches.length === 0) {
          data = {
            status: 'blocked', plans: [],
            gaps: [{
              code: 'component-missing', subject: options.family,
              message: `No declared or detected ${options.family} component is available for operation planning`,
            }],
          };
        } else if (matches.length > 1) {
          data = {
            status: 'blocked', plans: [],
            gaps: [{
              code: 'ambiguous-component-root', subject: options.family,
              message: `Multiple detected ${options.family} components require operation planning through the governed workflow`,
            }],
          };
        } else {
          const component = matches[0];
          const componentRoot = component.root;
          data = planAdapterOperation({
            catalog, family: options.family, adapterId: component.adapterId,
            operation: options.operation, authority: loaded.manifest.authority,
            context: {
              root: componentRoot,
              projectRoot: canonicalAdapterProjectRoot(root, componentRoot),
            },
          });
        }
      } else data = selectAdapters({ catalog, detection: detectProject(root) });
      status = data.status === 'ready' ? 'PASS' : 'FAIL';
      if (status === 'FAIL') code = EXIT_CODES.CAPABILITY_GAP;
    } else if (command === 'trust') {
      const policy = loadCatalog(root, 'factory/catalog/trust-policy.json');
      data = evaluateTrust({ descriptor: { tier: options.tier || 'verified', executable: options.tool || 'node', authority: ['read'], risk: 'high', cwd: '.', network: { mode: 'none', hosts: [] } }, policy, projectRoot: root });
      status = data.decision === 'allow' ? 'PASS' : 'FAIL';
      if (status === 'FAIL') code = EXIT_CODES.POLICY_DENIED;
    } else if (command === 'sbom') {
      data = generateSbom(root);
      if (options.write && !options.dryRun) atomicWriteJson(root, '.factory/sbom.json', data);
    } else if (command === 'attest') {
      const loaded = loadManifest(root); const sbom = generateSbom(root);
      const runSnapshot = statusProject(root, options.run ? { run: options.run } : {});
      const selected = collectAcceptedEvidenceFromStatus(runSnapshot);
      const identity = computeCertificationIdentity(root);
      if (selected.status !== 'PASS'
        || selected.certificationIdentity?.certificationIdentityDigest !== identity.certificationIdentityDigest) {
        const gaps = [...(selected.gaps || [])];
        if (selected.status === 'PASS') gaps.push({ code: 'PROVENANCE_IDENTITY_MISMATCH' });
        data = {
          verification: {
            valid: false, current: false,
            reasons: gaps.map(gap => gap.code || 'provenance-evidence-invalid'),
            gaps,
          },
        };
        status = 'FAIL';
      } else {
        let attestation = createAttestation({
          treeHash: identity.sourceTreeHash,
          certificationIdentityDigest: identity.certificationIdentityDigest,
          layoutInputDigest: identity.layoutInputDigest,
          manifestDigest: loaded.digest, evidenceDigests: selected.digests,
          sbom, subject: [{ name: loaded.manifest.project.id }],
          workflowRunId: selected.runId,
          planHash: runSnapshot.plan.planHash,
        });
        const trustPolicy = loadCatalog(root, 'factory/catalog/trust-policy.json');
        let signingKey = null;
        if (options.privateKey) {
          if (!options.run || runSnapshot.workflow.runState !== 'COMPLETE') {
            throw new Error('release signing requires an explicit COMPLETE workflow run');
          }
          signingKey = externalPrivateKey(root, options.privateKey);
          attestation = signReleaseAttestation(attestation, signingKey, trustPolicy);
        }
        const inspectionKey = options.publicKey
          ? fs.readFileSync(path.resolve(options.publicKey))
          : (signingKey ? crypto.createPublicKey(signingKey) : null);
        const verified = verifyAttestation(attestation, inspectionKey ? { publicKey: inspectionKey } : {});
        const releaseAssessment = assessReleaseProvenance(attestation, {
          policy: trustPolicy,
          workflowComplete: runSnapshot.workflow.runState === 'COMPLETE',
          expected: {
            workflowRunId: selected.runId,
            planHash: runSnapshot.plan.planHash,
            treeHash: identity.sourceTreeHash,
            manifestDigest: loaded.digest,
            certificationIdentityDigest: identity.certificationIdentityDigest,
            layoutInputDigest: identity.layoutInputDigest,
            sbomDigest: stableDigest(sbom),
            evidenceDigests: selected.digests,
          },
        });
        const afterIdentity = computeCertificationIdentity(root);
        const identityStable = afterIdentity.certificationIdentityDigest === identity.certificationIdentityDigest;
        const verification = identityStable ? verified : {
          ...verified, valid: false, current: false,
          reasons: [...verified.reasons, 'certification-input-changed'],
        };
        status = verification.valid && verification.current
          ? releaseAssessment.status
          : 'FAIL';
        data = { attestation, verification, releaseAssessment };
        if (options.write && (!options.run || runSnapshot.workflow.runState !== 'COMPLETE')) {
          throw new Error('writing provenance requires an explicit COMPLETE workflow run');
        }
        if (options.write && !options.dryRun && status !== 'FAIL') {
          atomicWriteJson(root, '.factory/provenance.json', {
            schemaVersion: '1.0.0', workflowRunId: selected.runId, attestation,
          });
        }
      }
      if (status === 'FAIL') code = EXIT_CODES.VALIDATION_FAILED;
    } else if (command === 'eval') {
      const context = selectedStageContext(root, options, 'eval');
      const city = certifyCity(root, { ...context, ledgerMode: 'candidate' });
      data = {
        ...city.reports.evals,
        level: 'candidate',
        workflowStage: context.stageAssessment,
        cityStatus: city.status,
        cityGaps: city.gaps,
      };
      status = city.status === 'PASS'
        ? (context.stageAssessment.trusted ? 'PASS' : 'ADVISORY')
        : 'FAIL';
      if (status === 'FAIL') code = EXIT_CODES.VALIDATION_FAILED;
    } else if (command === 'observe') {
      if (options.record) {
        const context = selectedStageContext(root, options, 'observe-record');
        if (options.dryRun) {
          data = { level: 'candidate', planned: context.stageAssessment.authorized, workflowStage: context.stageAssessment };
          status = context.stageAssessment.authorized ? 'PLANNED' : 'FAIL';
        } else {
          const recorded = recordCityCertification(root, context);
          data = {
            ...recorded.candidateAfter.reports.ledger,
            summary: summarizeLedger(readLedger(root)),
            level: 'candidate',
            candidateStatus: recorded.candidate.status,
            candidateGaps: recorded.candidate.gaps,
            candidateAfterStatus: recorded.candidateAfter.status,
            candidateAfterGaps: recorded.candidateAfter.gaps,
            workflowStage: context.stageAssessment,
            recordedEntry: recorded.entry,
          };
          status = recorded.candidate.status === 'PASS'
            && recorded.candidateAfter.status === 'PASS' ? 'PASS' : 'FAIL';
        }
      } else {
        const identity = computeCertificationIdentity(root);
        const entries = readLedger(root);
        data = {
          ...assessCertificationLedger(entries, identity, options.run ? { runId: options.run, level: 'candidate' } : {}),
          advisory: !options.run,
          trusted: Boolean(options.run),
          summary: summarizeLedger(entries),
        };
        status = options.run ? data.status : 'ADVISORY';
      }
      if (status === 'FAIL') code = EXIT_CODES.VALIDATION_FAILED;
    } else if (command === 'control') {
      const context = selectedStageContext(root, options, 'certify');
      const city = certifyCity(root, context);
      data = { ...city.reports.control, workflowStage: context.stageAssessment, cityStatus: city.status, cityGaps: city.gaps };
      status = city.status === 'COMPLETE'
        ? (context.stageAssessment.trusted ? 'PASS' : 'ADVISORY')
        : 'FAIL';
      if (status === 'FAIL') code = EXIT_CODES.VALIDATION_FAILED;
    } else if (command === 'release-plan') {
      const loaded = loadManifest(root);
      const certificationContext = selectedStageContext(root, options, 'certify');
      const certification = certifyCity(root, certificationContext);
      const action = options.action || 'prepare';
      let adapterPlan = null;
      if (options.action === 'deploy' && options.family) {
        const catalog = loadCatalog(root, 'factory/catalog/adapters.json');
        const planned = planAdapterOperation({ catalog, family: options.family, operation: 'deploy', authority: loaded.manifest.authority, context: { root: '.' } });
        adapterPlan = planned.status === 'ready' ? { status: 'PASS', ...planned.plans[0] } : { status: 'FAIL', gaps: planned.gaps };
      }
      data = planDelivery({
        manifest: loaded.manifest, action, certification, adapterPlan,
        runSnapshot: certificationContext.runSnapshot,
        explicitRun: certificationContext.explicitRun,
      });
      status = data.status === 'PASS' ? (data.trusted ? 'PASS' : 'ADVISORY') : 'FAIL';
      if (status === 'FAIL') code = data.status === 'DENIED' ? EXIT_CODES.POLICY_DENIED : EXIT_CODES.VALIDATION_FAILED;
    } else if (command === 'certify') {
      const context = selectedStageContext(root, options, 'certify');
      data = certifyCity(root, context);
      status = data.status === 'COMPLETE'
        ? (context.stageAssessment.trusted ? 'COMPLETE' : 'ADVISORY')
        : 'FAIL';
      if (status === 'FAIL') code = EXIT_CODES.VALIDATION_FAILED;
    }
    if (options.json) process.stdout.write(formatJsonEnvelope({ command, status, data }, { policy: outputPolicy }));
    else human(command, status, data, outputPolicy);
    return code;
  } catch (error) {
    const safeError = redactError(error, outputPolicy);
    const diagnostic = { level: 'error', code: safeError.code, message: safeError.message };
    if (options.json) process.stdout.write(formatJsonEnvelope({ command, status: 'FAIL', data: {}, diagnostics: [diagnostic] }, { policy: outputPolicy }));
    else process.stderr.write(formatFactoryError(error, { policy: outputPolicy }));
    return /blocked|authority/.test(error.message) ? EXIT_CODES.POLICY_DENIED : EXIT_CODES.VALIDATION_FAILED;
  }
}

async function main(argv = process.argv) {
  const args = argv.slice(2);
  if (args[0] === 'queue') return queueMain(args.slice(1));
  if (args[0] === 'impacted') return impactedMain(args.slice(1));
  if (args[0] === 'testdb') return testdbMain(args.slice(1));
  if (args[0] === 'testcache') return testcacheMain(args.slice(1));
  if (args[0] === 'clean') return cleanMain(args.slice(1));
  // loaded on demand: the supervisor's docker and gh plumbing is not part of every CLI start
  if (args[0] === 'runners') return require('../lib/runners').runnersMain(args.slice(1));
  return NEW_COMMANDS.includes(args[0]) ? factoryMain(args) : legacyMain(args);
}

if (require.main === module) {
  main(process.argv).then(code => { process.exitCode = code; });
}

module.exports = { factoryMain, legacyMain, main };
