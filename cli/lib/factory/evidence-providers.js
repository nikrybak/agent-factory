'use strict';
/** @implements REQ-CITY-011 Complete selected-target bindings, including explicit N/A and blocked targets. */

const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS, canonicalAdapterProjectRoot,
  expandAdapterArgv, operationCommands, validateAdapterCatalog,
} = require('./adapters');
const { loadCatalog } = require('./catalog-loader');
const {
  FILESYSTEM_BOUNDARY_VERSION, FILESYSTEM_CAPABILITY_DIGEST,
} = require('./filesystem-boundary');
const { hashValue } = require('./hash');
const { createLaunchBinding, validateLaunchBinding } = require('./launcher');
const { loadManifest } = require('./manifest');
const { resolveInside } = require('./paths');
const { REDACTION_POLICY_VERSION, assertCredentialFreeArgv } = require('./redaction');
const { validateWorkflow } = require('./workflow');

const ID = /^[a-z][a-z0-9-]*$/;
const BINDING_VERSION = '1.1.0';
const REASON_CODE = /^[A-Z][A-Z0-9_]*$/;
const COMPOSITE_OPERATIONS = new Set(['test', 'coverage', 'e2e', 'security']);
const COMMAND_FIELDS = new Set([
  'id', 'targetId', 'componentId', 'adapterId', 'operation', 'argv', 'cwd',
  'requiredAuthority', 'launchBinding', 'timeoutMs', 'commandHash',
]);
const COMMAND_TARGET_FIELDS = new Set([
  'id', 'componentId', 'adapterId', 'operation', 'kind', 'commandIds',
]);
const NA_TARGET_FIELDS = new Set([
  'id', 'componentId', 'adapterId', 'operation', 'kind', 'reasonCode', 'reason',
]);
const BLOCKED_TARGET_FIELDS = new Set(NA_TARGET_FIELDS);

function withoutDigest(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function validateProviderCatalog(catalog) {
  if (!catalog || !['1.0.0', '1.1.0'].includes(catalog.schemaVersion) || !Array.isArray(catalog.providers) || !catalog.providers.length) {
    throw new Error('evidence-provider catalog requires supported schemaVersion and providers');
  }
  const ids = new Set();
  for (const provider of catalog.providers) {
    if (!provider || !ID.test(provider.id || '') || ids.has(provider.id)) throw new Error(`invalid or duplicate evidence provider: ${provider && provider.id}`);
    ids.add(provider.id);
    if (!['builtin', 'composite'].includes(provider.kind)) throw new Error(`provider ${provider.id} has invalid kind`);
    if (provider.kind === 'builtin' && (!ID.test(provider.operation || '') || provider.operations !== undefined)) {
      throw new Error(`builtin provider ${provider.id} requires one operation`);
    }
    if (provider.kind === 'composite') {
      if (!Array.isArray(provider.operations) || !provider.operations.length) {
        throw new Error(`composite provider ${provider.id} requires operations`);
      }
      if (catalog.schemaVersion === '1.0.0') {
        if (provider.operations.some(operation => !ID.test(operation) || !COMPOSITE_OPERATIONS.has(operation))
          || new Set(provider.operations).size !== provider.operations.length) {
          throw new Error(`composite provider ${provider.id} requires unique operations`);
        }
      } else {
        const pairs = new Set();
        for (const operation of provider.operations) {
          if (!operation || Object.keys(operation).some(key => !['name', 'selector', 'notApplicable'].includes(key))
            || !ID.test(operation.name || '') || !COMPOSITE_OPERATIONS.has(operation.name) || !operation.selector
            || Object.keys(operation.selector).some(key => key !== 'componentIds')
            || !Array.isArray(operation.selector.componentIds) || !operation.selector.componentIds.length
            || operation.selector.componentIds.some(componentId => !ID.test(componentId))
            || new Set(operation.selector.componentIds).size !== operation.selector.componentIds.length) {
            throw new Error(`composite provider ${provider.id} operation selector is invalid`);
          }
          const selected = new Set(operation.selector.componentIds);
          const naIds = new Set();
          if (operation.notApplicable !== undefined && !Array.isArray(operation.notApplicable)) {
            throw new Error(`composite provider ${provider.id} notApplicable must be an array`);
          }
          for (const item of operation.notApplicable || []) {
            if (!item || Object.keys(item).some(key => !['componentId', 'reasonCode', 'reason'].includes(key))
              || !ID.test(item.componentId || '') || !selected.has(item.componentId)
              || naIds.has(item.componentId) || !REASON_CODE.test(item.reasonCode || '')
              || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 500) {
              throw new Error(`composite provider ${provider.id} notApplicable target is invalid`);
            }
            naIds.add(item.componentId);
          }
          for (const componentId of selected) {
            const pair = `${componentId}:${operation.name}`;
            if (pairs.has(pair)) throw new Error(`composite provider ${provider.id} has duplicate target: ${pair}`);
            pairs.add(pair);
          }
        }
      }
    }
  }
  return true;
}

function normalizedCatalogDigests(digests) {
  if (!digests || typeof digests !== 'object' || Array.isArray(digests)
    || !Object.keys(digests).length
    || Object.values(digests).some(digest => !/^[a-f0-9]{64}$/.test(digest))) {
    throw new Error('governed catalog content digests are required');
  }
  return Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left.localeCompare(right)));
}

function componentContext(component, repositoryRoot) {
  const rockspec = (component.evidence || []).find(item => item.path.endsWith('.rockspec'))?.path;
  return {
    image: `factory-${component.id}`,
    entrypoint: component.root,
    planfile: `.factory/${component.id}.tfplan`,
    projectRoot: repositoryRoot === undefined
      ? undefined : canonicalAdapterProjectRoot(repositoryRoot, component.root),
    rockspec,
  };
}

function expandArgv(argv, component, repositoryRoot) {
  const needsProjectRoot = argv.some(value => value.includes('${projectRoot}'));
  const context = componentContext(component, needsProjectRoot ? repositoryRoot : undefined);
  return expandAdapterArgv(argv, context);
}

function bindCommand(provider, adapter, component, operation, authoredCommand, launchBindings, launchOptions) {
  const targetId = `${component.id}:${operation}`;
  const id = authoredCommand.id ? `${targetId}:${authoredCommand.id}` : targetId;
  const argv = expandArgv(authoredCommand.argv, component, launchOptions.projectRoot);
  assertCredentialFreeArgv(argv);
  const cachedLaunchBinding = launchBindings.get(argv[0]);
  const launchBinding = cachedLaunchBinding
    ? JSON.parse(JSON.stringify(cachedLaunchBinding))
    : createLaunchBinding(argv, launchOptions);
  if (!cachedLaunchBinding) launchBindings.set(argv[0], launchBinding);
  const command = {
    id,
    targetId,
    componentId: component.id,
    adapterId: adapter.id,
    operation,
    argv,
    cwd: component.root,
    requiredAuthority: adapter.operations[operation].authority || null,
    launchBinding,
    ...(authoredCommand.timeoutMs === undefined ? {} : { timeoutMs: authoredCommand.timeoutMs }),
  };
  const commandIdentity = {
    providerId: provider.id,
    id: command.id,
    targetId: command.targetId,
    componentId: command.componentId,
    adapterId: command.adapterId,
    operation: command.operation,
    argv: command.argv,
    cwd: command.cwd,
    launchDigest: launchBinding.launchDigest,
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
  };
  command.commandHash = hashValue(commandIdentity);
  return command;
}

function finalizeBinding(fields) {
  const binding = {
    schemaVersion: BINDING_VERSION,
    redactionPolicyVersion: REDACTION_POLICY_VERSION,
    filesystemBoundaryVersion: FILESYSTEM_BOUNDARY_VERSION,
    filesystemCapabilityDigest: FILESYSTEM_CAPABILITY_DIGEST,
    ...fields,
  };
  binding.bindingDigest = hashValue(binding);
  return binding;
}

function bindEvidenceProviders({
  workflow, providerCatalog, adapterCatalog, catalogDigests, detection, steps,
  projectRoot, toolchainTrust,
}) {
  validateProviderCatalog(providerCatalog);
  validateAdapterCatalog(adapterCatalog);
  const providers = new Map(providerCatalog.providers.map(provider => [provider.id, provider]));
  const adaptersById = new Map(adapterCatalog.adapters.map(adapter => [adapter.id, adapter]));
  const adaptersByFamily = new Map();
  for (const adapter of adapterCatalog.adapters) {
    if (!adaptersByFamily.has(adapter.family)) adaptersByFamily.set(adapter.family, []);
    adaptersByFamily.get(adapter.family).push(adapter);
  }
  const digests = normalizedCatalogDigests(catalogDigests);
  const launchBindings = new Map();
  const gaps = [];
  const boundSteps = steps.map(step => {
    const workflowStep = workflow.steps.find(item => item.id === step.id);
    const providerId = workflowStep?.evidenceProvider;
    const provider = providers.get(providerId);
    if (!provider) {
      gaps.push({ code: 'UNBOUND_WORKFLOW_STEP', subject: step.id, message: `No governed evidence provider for ${step.id}` });
      return step;
    }
    if (step.applicable === false) {
      return { ...step, evidenceBinding: finalizeBinding({ providerId, kind: 'na', operation: null, targets: [], commands: [], catalogDigests: digests, naReason: step.naReason }) };
    }
    if (provider.kind === 'builtin') {
      return { ...step, evidenceBinding: finalizeBinding({ providerId, kind: 'builtin', operation: provider.operation, targets: [], commands: [], catalogDigests: digests }) };
    }
    const components = new Map((detection.components || []).map(component => [component.id, component]));
    const selections = providerCatalog.schemaVersion === '1.0.0'
      ? provider.operations.map(name => ({
        name, selector: { componentIds: [...components.keys()].sort() }, notApplicable: [],
      }))
      : provider.operations;
    const commands = [];
    const targets = [];
    for (const selection of selections) {
      let selectedCount = 0;
      const notApplicable = new Map((selection.notApplicable || []).map(item => [item.componentId, item]));
      for (const componentId of selection.selector.componentIds) {
        const component = components.get(componentId);
        if (!component) {
          gaps.push({ code: 'EVIDENCE_COMPONENT_MISSING', subject: `${step.id}:${componentId}:${selection.name}`, message: `Selected component does not exist: ${componentId}` });
          continue;
        }
        selectedCount += 1;
        const candidates = adaptersByFamily.get(component.family) || [];
        const adapter = component.adapterId ? adaptersById.get(component.adapterId) : (candidates.length === 1 ? candidates[0] : null);
        if (!adapter || adapter.family !== component.family) {
          const ambiguous = !component.adapterId && candidates.length > 1;
          gaps.push({
            code: ambiguous ? 'EVIDENCE_ADAPTER_AMBIGUOUS' : 'EVIDENCE_ADAPTER_MISSING',
            subject: `${step.id}:${component.id}`,
            message: ambiguous ? `Multiple adapters require adapterId for ${component.family}` : `No matching adapter for ${component.family}`,
          });
          continue;
        }
        const operation = selection.name;
        const definition = adapter.operations[operation];
        const na = notApplicable.get(component.id);
        const targetId = `${component.id}:${operation}`;
        if (na) {
          if (definition) {
            gaps.push({ code: 'EVIDENCE_NA_CONFLICT', subject: `${step.id}:${targetId}`, message: `${adapter.id} supports ${operation}` });
            continue;
          }
          if (!adapter.unsupported.includes(operation)) {
            gaps.push({ code: 'EVIDENCE_OPERATION_UNSUPPORTED', subject: `${step.id}:${targetId}`, message: `${adapter.id} does not explicitly reject ${operation}` });
            continue;
          }
          targets.push({
            id: targetId, componentId: component.id, adapterId: adapter.id,
            operation, kind: 'na', reasonCode: na.reasonCode, reason: na.reason,
          });
          continue;
        }
        if (!definition) {
          gaps.push({ code: 'EVIDENCE_OPERATION_UNSUPPORTED', subject: `${step.id}:${targetId}`, message: `${adapter.id} does not support ${operation}` });
          continue;
        }
        try {
          if (definition.authority) {
            gaps.push({ code: 'EVIDENCE_PROVIDER_MUTATING', subject: `${step.id}:${component.id}:${operation}`, message: 'Evidence providers must be non-mutating' });
            continue;
          }
          const targetCommands = operationCommands(definition, `${adapter.id}.${operation}`).map(authoredCommand => bindCommand(
            provider, adapter, component, operation, authoredCommand, launchBindings,
            { projectRoot, toolchainTrust },
          ));
          targets.push({
            id: targetId, componentId: component.id, adapterId: adapter.id,
            operation, kind: 'command', commandIds: targetCommands.map(command => command.id),
          });
          commands.push(...targetCommands);
        } catch (error) {
          // Credential-bearing governed commands are invalid authored policy, not
          // an executable planning gap. Abort before a plan can be sealed/persisted.
          if (error.code === 'EVIDENCE_PROVIDER_CREDENTIAL') throw error;
          const reasonCode = error.code === 'FACTORY_TOOLCHAIN_UNAUTHORIZED'
            ? 'EVIDENCE_TOOLCHAIN_UNAUTHORIZED' : 'EVIDENCE_BINDING_CONTEXT_MISSING';
          const reason = String(error.message || 'governed binding failed').slice(0, 500);
          targets.push({
            id: targetId, componentId: component.id, adapterId: adapter.id,
            operation, kind: 'blocked', reasonCode, reason,
          });
          gaps.push({
            code: reasonCode, subject: `${step.id}:${component.id}:${operation}`, message: reason,
          });
        }
      }
      if (selectedCount === 0) gaps.push({ code: 'EVIDENCE_PROVIDER_EMPTY_SELECTION', subject: `${step.id}:${selection.name}`, message: `Provider ${providerId} selected no existing components` });
    }
    if (!targets.length) gaps.push({ code: 'EVIDENCE_PROVIDER_EMPTY', subject: step.id, message: `Provider ${providerId} resolved no targets` });
    const commandAggregateHash = hashValue(commands.map(command => command.commandHash));
    const targetAggregateHash = hashValue(targets);
    return { ...step, evidenceBinding: finalizeBinding({ providerId, kind: 'composite', operation: provider.operation || null, operations: provider.operations, targets, targetAggregateHash, commands, commandAggregateHash, catalogDigests: digests }) };
  });
  return { steps: boundSteps, gaps: gaps.sort((a, b) => `${a.code}:${a.subject}`.localeCompare(`${b.code}:${b.subject}`)), catalogDigests: digests };
}

function validateEvidenceBinding(binding) {
  const issues = [];
  if (!binding || typeof binding !== 'object') return ['LEGACY_UNBOUND_PLAN'];
  if (binding.schemaVersion !== BINDING_VERSION) issues.push('unsupported evidence binding version');
  if (binding.redactionPolicyVersion !== REDACTION_POLICY_VERSION) issues.push('redaction policy version mismatch');
  if (binding.filesystemBoundaryVersion !== FILESYSTEM_BOUNDARY_VERSION) {
    issues.push('filesystem boundary version mismatch');
  }
  if (binding.filesystemCapabilityDigest !== FILESYSTEM_CAPABILITY_DIGEST) {
    issues.push('filesystem capability digest mismatch');
  }
  try { normalizedCatalogDigests(binding.catalogDigests); } catch { issues.push('catalog content digests are invalid'); }
  if (!ID.test(binding.providerId || '')) issues.push('binding providerId is invalid');
  if (!['na', 'builtin', 'composite'].includes(binding.kind)) issues.push('binding kind is invalid');
  if (!Array.isArray(binding.targets)) issues.push('binding targets are required');
  if (!Array.isArray(binding.commands)) issues.push('binding commands are required');
  if (binding.kind !== 'composite' && (binding.commands?.length || binding.targets?.length)) issues.push('non-composite binding cannot contain targets or commands');
  if (binding.kind === 'composite') {
    if (!binding.targets?.length) issues.push('composite binding requires targets');
    const targetIds = new Set();
    const expectedCommandIds = [];
    for (const target of binding.targets || []) {
      if (!target || typeof target.id !== 'string' || targetIds.has(target.id)) issues.push('binding target id is invalid or duplicate');
      targetIds.add(target?.id);
      if (!ID.test(target?.componentId || '') || !ID.test(target?.adapterId || '') || !ID.test(target?.operation || '')) {
        issues.push(`binding target identity is invalid: ${target?.id}`);
      }
      if (!['command', 'na', 'blocked'].includes(target?.kind)) issues.push(`binding target kind is invalid: ${target?.id}`);
      if (target?.id !== `${target?.componentId}:${target?.operation}`) issues.push(`binding target id mismatch: ${target?.id}`);
      if (target?.kind === 'command') {
        if (Object.keys(target).some(field => !COMMAND_TARGET_FIELDS.has(field))) issues.push(`binding command target fields are invalid: ${target?.id}`);
        if (!Array.isArray(target.commandIds) || !target.commandIds.length) issues.push(`binding command target has no commands: ${target?.id}`);
        else expectedCommandIds.push(...target.commandIds);
      } else {
        const allowed = target?.kind === 'blocked' ? BLOCKED_TARGET_FIELDS : NA_TARGET_FIELDS;
        const label = target?.kind === 'blocked' ? 'blocked' : 'N/A';
        if (Object.keys(target || {}).some(field => !allowed.has(field))) issues.push(`binding ${label} target fields are invalid: ${target?.id}`);
        if (!REASON_CODE.test(target?.reasonCode || '') || typeof target?.reason !== 'string'
          || !target.reason.trim() || target.reason.length > 500) {
          issues.push(`binding ${label} target reason is invalid: ${target?.id}`);
        }
      }
    }
    if (binding.targetAggregateHash !== hashValue(binding.targets || [])) issues.push('binding target aggregate hash mismatch');
    const ids = new Set();
    for (const command of binding.commands || []) {
      if (!command || typeof command.id !== 'string' || ids.has(command.id)) issues.push('binding command id is invalid or duplicate');
      ids.add(command?.id);
      if (Object.keys(command || {}).some(field => !COMMAND_FIELDS.has(field))) issues.push(`binding command fields are invalid: ${command?.id}`);
      if (!targetIds.has(command?.targetId)) issues.push(`binding command target is missing: ${command?.id}`);
      const target = (binding.targets || []).find(item => item.id === command?.targetId);
      if (!target || target.kind !== 'command'
        || command?.componentId !== target.componentId || command?.adapterId !== target.adapterId
        || command?.operation !== target.operation
        || (command?.id !== target.id && !command?.id.startsWith(`${target.id}:`))) {
        issues.push(`binding command target identity mismatch: ${command?.id}`);
      }
      if (command?.requiredAuthority !== null) issues.push(`binding command authority is invalid: ${command?.id}`);
      if (command?.timeoutMs !== undefined
        && (!Number.isInteger(command.timeoutMs)
          || command.timeoutMs < MIN_COMMAND_TIMEOUT_MS || command.timeoutMs > MAX_COMMAND_TIMEOUT_MS)) {
        issues.push(`binding command timeout is invalid: ${command?.id}`);
      }
      try { assertCredentialFreeArgv(command?.argv); } catch { issues.push(`binding command contains credential: ${command?.id}`); }
      for (const issue of validateLaunchBinding(command?.launchBinding, command?.argv)) {
        issues.push(`${issue}: ${command?.id}`);
      }
      const expected = hashValue({
        providerId: binding.providerId, id: command?.id, targetId: command?.targetId,
        componentId: command?.componentId, adapterId: command?.adapterId,
        operation: command?.operation, argv: command?.argv, cwd: command?.cwd,
        launchDigest: command?.launchBinding?.launchDigest,
        ...(command?.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      });
      if (command?.commandHash !== expected) issues.push(`binding command hash mismatch: ${command?.id}`);
    }
    if (JSON.stringify(expectedCommandIds) !== JSON.stringify((binding.commands || []).map(command => command.id))) {
      issues.push('binding flattened command order mismatch');
    }
    if (binding.commandAggregateHash !== hashValue((binding.commands || []).map(command => command.commandHash))) issues.push('binding command aggregate hash mismatch');
  }
  if (binding.bindingDigest !== hashValue(withoutDigest(binding, 'bindingDigest'))) issues.push('binding digest mismatch');
  return issues;
}

function assertRuntimeSelection(binding, commandArgv) {
  const issues = validateEvidenceBinding(binding);
  if (issues.length) throw new Error(issues.join('; '));
  if (binding.targets?.some(target => target.kind === 'blocked')) {
    throw new Error('BLOCKED_EVIDENCE_TARGET: composite binding contains a non-executable selected target');
  }
  if (binding.kind !== 'composite') {
    if (Array.isArray(commandArgv) && commandArgv.length) throw new Error('builtin and N/A providers reject caller argv');
    return;
  }
  if (binding.commands.length === 1 && Array.isArray(commandArgv) && commandArgv.length) {
    if (JSON.stringify(commandArgv) !== JSON.stringify(binding.commands[0].argv)) throw new Error('runtime argv does not match the governed evidence binding');
  } else if (Array.isArray(commandArgv) && commandArgv.length) {
    throw new Error('composite evidence providers run every bound command and reject caller argv');
  }
}

function graphReport(root) {
  const { analyzeArtifactGraph, loadArtifactGraph } = require('./traceability');
  return analyzeArtifactGraph(loadArtifactGraph(root), root);
}

function lineageResult(root, operation) {
  const graph = require('./traceability').loadArtifactGraph(root);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const requirementIds = graph.nodes.filter(node => node.type === 'requirement').map(node => node.id);
  const outgoing = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) outgoing.get(edge.from)?.push(edge);
  function targets(from, edgeType, nodeType) {
    return (outgoing.get(from) || [])
      .filter(edge => edge.type === edgeType && nodes.get(edge.to)?.type === nodeType)
      .map(edge => edge.to);
  }
  const missing = requirementIds.filter(requirementId => {
    const specs = targets(requirementId, 'specified-by', 'spec');
    if (operation === 'architecture-lineage') {
      const adrs = [
        ...targets(requirementId, 'governed-by', 'adr'),
        ...specs.flatMap(specId => targets(specId, 'governed-by', 'adr')),
      ];
      return specs.length === 0 || adrs.length === 0;
    }
    const modules = [
      ...targets(requirementId, 'implemented-by', 'module'),
      ...specs.flatMap(specId => targets(specId, 'implemented-by', 'module')),
    ];
    if (operation === 'implementation-lineage') return modules.length === 0;
    const tests = [
      ...targets(requirementId, 'verified-by', 'test'),
      ...modules.flatMap(moduleId => targets(moduleId, 'verified-by', 'test')),
    ];
    return tests.length === 0;
  });
  return missing.length ? { status: 'FAIL', reason: `${operation} missing for: ${missing.join(', ')}` } : { status: 'PASS' };
}

function executeBuiltinProvider(operation, context) {
  if (context.providerExecutors?.[operation]) return context.providerExecutors[operation](context);
  const root = context.root;
  if (operation === 'manifest-intent') {
    const loaded = loadManifest(root);
    const graph = require('./traceability').loadArtifactGraph(root);
    const hasIntent = graph.nodes.some(node => node.type === 'intent');
    const hasRequirement = graph.nodes.some(node => node.type === 'requirement');
    const defines = graph.edges.some(edge => edge.type === 'defines');
    return loaded.manifest.project.intent && hasIntent && hasRequirement && defines
      ? { status: 'PASS' } : { status: 'FAIL', reason: 'manifest intent and requirement roots are incomplete' };
  }
  if (operation === 'plan-binding-integrity') {
    validateWorkflow(context.plan);
    const failures = context.plan.steps.flatMap(step => validateEvidenceBinding(step.evidenceBinding).map(issue => `${step.id}: ${issue}`));
    return failures.length ? { status: 'FAIL', reason: failures.join('; ') } : { status: 'PASS' };
  }
  if (['architecture-lineage', 'implementation-lineage', 'test-contract-lineage', 'api-contract-lineage'].includes(operation)) {
    return lineageResult(root, operation === 'api-contract-lineage' ? 'test-contract-lineage' : operation);
  }
  if (operation === 'traceability') {
    const report = graphReport(root);
    return { status: report.status === 'pass' ? 'PASS' : 'FAIL', reason: report.gaps.map(gap => gap.code).join(', ') || undefined };
  }
  if (operation === 'workforce') {
    const catalog = loadCatalog(root, 'factory/catalog/roles.json');
    const report = require('./workforce').routeWorkforce({ catalog, plan: context.plan, detection: context.plan.detection });
    return { status: report.status === 'ready' ? 'PASS' : 'FAIL', reason: report.gaps.map(gap => gap.code).join(', ') || undefined };
  }
  if (operation === 'adapter-selection') {
    const catalog = loadCatalog(root, 'factory/catalog/adapters.json');
    const report = require('./adapters').selectAdapters({ catalog, detection: context.plan.detection });
    return { status: report.status === 'ready' ? 'PASS' : 'FAIL', reason: report.gaps.map(gap => gap.code).join(', ') || undefined };
  }
  if (operation === 'trust') {
    const policy = loadCatalog(root, 'factory/catalog/trust-policy.json');
    const report = require('./trust').validateTrustPolicy(policy);
    return { status: report.valid ? 'PASS' : 'FAIL', reason: report.errors.join(', ') || undefined };
  }
  if (operation === 'supply-chain') {
    const sbom = require('./sbom').generateSbom(root);
    const valid = Array.isArray(sbom.components) && Array.isArray(sbom.metadata?.sources);
    return valid ? { status: 'PASS' } : { status: 'FAIL', reason: 'SBOM generation failed' };
  }
  if (operation === 'docs-parity') {
    const manifest = loadManifest(root).manifest;
    const docsSources = manifest.sources.filter(source => source.required && source.kind === 'docs');
    if (docsSources.length > 1) {
      return { status: 'FAIL', reason: 'multiple required docs roots are ambiguous' };
    }
    let docsRoot = root;
    try {
      if (docsSources.length === 1) docsRoot = resolveInside(root, docsSources[0].location);
    } catch {
      return { status: 'FAIL', reason: 'required docs root escapes project boundary' };
    }
    const required = ['docs/app-architecture/ARCHITECTURE.md', 'docs/operations/MEMORY.md', 'tasks/CURRENT_SPRINT.md'];
    const missing = required.filter(file => !fs.existsSync(path.join(docsRoot, file)));
    return missing.length ? { status: 'FAIL', reason: `missing docs: ${missing.join(', ')}` } : { status: 'PASS' };
  }
  return { status: 'FAIL', reason: `provider executor is required: ${operation}` };
}

module.exports = {
  assertRuntimeSelection, bindEvidenceProviders, executeBuiltinProvider,
  validateEvidenceBinding, validateProviderCatalog,
};
