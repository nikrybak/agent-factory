'use strict';
/** @implements REQ-CITY-011 Receipt validation for ordered command, N/A, and aggregate evidence. */

const { hashValue } = require('./hash');
const {
  FILESYSTEM_BOUNDARY_VERSION, FILESYSTEM_CAPABILITY_DIGEST,
} = require('./filesystem-boundary');
const {
  REDACTION_POLICY_VERSION, containsSensitiveMaterial, redactValue,
} = require('./redaction');

const STATUSES = new Set(['PASS', 'FAIL', 'NA']);
const RECEIPT_STATUSES = new Set(['PASS', 'FAIL']);
const BUILTIN_COMPONENT_FIELDS = new Set(['id', 'operation', 'status', 'reason', 'metadata', 'digest']);
const COMPOSITE_COMPONENT_FIELDS = new Set([
  'id', 'targetId', 'componentId', 'adapterId', 'operation', 'commandHash', 'launchDigest',
  'status', 'exitCode', 'signal', 'stdout', 'stderr', 'outputTruncated', 'durationMs', 'digest',
]);
const NA_COMPONENT_FIELDS = new Set([
  'id', 'componentId', 'adapterId', 'operation', 'status', 'reasonCode', 'reason', 'digest',
]);
const COMPOSITE_COMMAND_FIELDS = new Set(['commands']);

function evidencePayload(evidence) {
  const payload = { ...evidence };
  delete payload.digest;
  return payload;
}

function validateEvidence(evidence) {
  const issues = [];
  if (!evidence || typeof evidence !== 'object') return ['evidence must be an object'];
  if (evidence.schemaVersion !== 2) issues.push('evidence schemaVersion must equal 2');
  if (typeof evidence.stepId !== 'string' || !evidence.stepId) issues.push('stepId is required');
  if (!Number.isSafeInteger(evidence.attempt) || evidence.attempt < 1) issues.push('attempt must be positive');
  if (!STATUSES.has(evidence.status)) issues.push('status must be PASS, FAIL, or NA');
  if (evidence.status === 'NA' && (typeof evidence.reason !== 'string' || !evidence.reason.trim())) {
    issues.push('N/A evidence requires a reason');
  }
  if (evidence.startedAt && !Number.isFinite(Date.parse(evidence.startedAt))) issues.push('startedAt is invalid');
  if (evidence.finishedAt && !Number.isFinite(Date.parse(evidence.finishedAt))) issues.push('finishedAt is invalid');
  if (evidence.expiresAt && !Number.isFinite(Date.parse(evidence.expiresAt))) issues.push('expiresAt is invalid');
  if (evidence.providerId !== undefined && (typeof evidence.providerId !== 'string' || !evidence.providerId)) issues.push('providerId is invalid');
  if (evidence.bindingDigest !== undefined && !/^[a-f0-9]{64}$/.test(evidence.bindingDigest)) issues.push('bindingDigest is invalid');
  if (evidence.redactionPolicyVersion !== REDACTION_POLICY_VERSION) issues.push('REDACTION_POLICY_VERSION_MISMATCH');
  if (evidence.filesystemBoundaryVersion !== FILESYSTEM_BOUNDARY_VERSION) {
    issues.push('FILESYSTEM_BOUNDARY_VERSION_MISMATCH');
  }
  if (evidence.filesystemCapabilityDigest !== FILESYSTEM_CAPABILITY_DIGEST) {
    issues.push('FILESYSTEM_CAPABILITY_DIGEST_MISMATCH');
  }
  if (containsSensitiveMaterial(evidence)) issues.push('SENSITIVE_EVIDENCE_CONTENT');
  if (evidence.components !== undefined) {
    if (!Array.isArray(evidence.components)) issues.push('components must be an array');
    else {
      for (const component of evidence.components) {
        if (!component || typeof component !== 'object' || component.digest !== hashValue(evidencePayload(component))) {
          issues.push(`component digest mismatch: ${component?.id || 'unknown'}`);
        }
      }
      if (evidence.componentAggregateHash !== hashValue(evidence.components.map(component => component.digest))) {
        issues.push('component aggregate hash mismatch');
      }
    }
  }
  return issues;
}

function unexpectedFields(value, allowed) {
  return Object.keys(value || {}).filter(field => !allowed.has(field));
}

function validateEvidenceReceipt(evidence, binding) {
  const issues = [];
  if (!binding || typeof binding !== 'object') return ['expected evidence binding is required'];
  if (!evidence || typeof evidence !== 'object') return ['evidence receipt is required'];
  if (evidence.redactionPolicyVersion !== binding.redactionPolicyVersion
    || evidence.redactionPolicyVersion !== REDACTION_POLICY_VERSION) {
    issues.push('receipt redaction policy version mismatch');
  }
  if (evidence.filesystemBoundaryVersion !== binding.filesystemBoundaryVersion
    || evidence.filesystemBoundaryVersion !== FILESYSTEM_BOUNDARY_VERSION) {
    issues.push('receipt filesystem boundary version mismatch');
  }
  if (evidence.filesystemCapabilityDigest !== binding.filesystemCapabilityDigest
    || evidence.filesystemCapabilityDigest !== FILESYSTEM_CAPABILITY_DIGEST) {
    issues.push('receipt filesystem capability digest mismatch');
  }
  const components = Array.isArray(evidence.components) ? evidence.components : [];
  const aggregate = hashValue(components.map(component => component?.digest));
  if (evidence.componentAggregateHash !== aggregate) issues.push('component receipt aggregate mismatch');

  if (binding.kind === 'na') {
    if (evidence.status !== 'NA') issues.push('N/A binding requires N/A evidence');
    if (evidence.reason !== binding.naReason) issues.push('N/A receipt reason mismatch');
    if (components.length !== 0) issues.push('N/A receipt must not contain components');
    if (evidence.command !== undefined) issues.push('N/A receipt must not contain a command');
    return issues;
  }

  if (evidence.status === 'NA') issues.push('executable binding cannot produce N/A evidence');
  if (binding.kind === 'builtin') {
    if (components.length !== 1) {
      issues.push('builtin receipt requires exactly one component');
      return issues;
    }
    const component = components[0];
    if (component.id !== `builtin:${binding.operation}`) issues.push('builtin receipt id mismatch');
    if (component.operation !== binding.operation) issues.push('builtin receipt operation mismatch');
    if (!RECEIPT_STATUSES.has(component.status)) issues.push('builtin receipt status is invalid');
    if (component.reason !== undefined && (typeof component.reason !== 'string' || !component.reason.trim())) {
      issues.push('builtin receipt reason is invalid');
    }
    if (unexpectedFields(component, BUILTIN_COMPONENT_FIELDS).length) issues.push('builtin receipt contains unexpected fields');
    if (evidence.command?.operation !== binding.operation
      || unexpectedFields(evidence.command, new Set(['operation'])).length) {
      issues.push('builtin command receipt mismatch');
    }
    if (evidence.status === 'PASS' && component.status !== 'PASS') issues.push('PASS evidence contains a failed builtin receipt');
    return issues;
  }

  if (binding.kind !== 'composite') return ['expected evidence binding kind is invalid'];
  const expected = Array.isArray(binding.commands) ? binding.commands : [];
  const commandsById = new Map(expected.map(command => [command.id, command]));
  const expectedReceipts = [];
  for (const target of binding.targets || []) {
    if (target.kind === 'na') expectedReceipts.push({ kind: 'na', target });
    else for (const commandId of target.commandIds || []) expectedReceipts.push({
      kind: 'command', target, command: commandsById.get(commandId),
    });
  }
  const commandReceipts = Array.isArray(evidence.command?.commands) ? evidence.command.commands : [];
  if (!evidence.command || unexpectedFields(evidence.command, COMPOSITE_COMMAND_FIELDS).length
    || !Array.isArray(evidence.command.commands)) {
    issues.push('composite command receipt is invalid');
  }
  if (commandReceipts.length !== expected.length) issues.push('composite command receipt count mismatch');
  if (components.length !== expectedReceipts.length) issues.push('composite receipt count mismatch');
  if (hashValue(components.filter(component => component?.status !== 'NA').map(component => component?.commandHash)) !== binding.commandAggregateHash) {
    issues.push('component command aggregate does not match the expected binding');
  }
  if (evidence.commandHash !== binding.targetAggregateHash) issues.push('receipt target aggregate mismatch');
  const count = Math.min(components.length, expectedReceipts.length);
  for (let index = 0; index < count; index += 1) {
    const component = components[index];
    const receipt = expectedReceipts[index];
    const command = receipt.command;
    if (receipt.kind === 'na') {
      const target = receipt.target;
      for (const field of ['id', 'componentId', 'adapterId', 'operation', 'reasonCode', 'reason']) {
        if (component?.[field] !== target?.[field]) issues.push(`N/A component receipt ${field} mismatch at index ${index}`);
      }
      if (component?.status !== 'NA') issues.push(`N/A component receipt status mismatch at index ${index}`);
      if (unexpectedFields(component, NA_COMPONENT_FIELDS).length) issues.push(`N/A component receipt contains unexpected fields at index ${index}`);
      continue;
    }
    for (const field of ['id', 'componentId', 'adapterId', 'operation', 'commandHash']) {
      if (component?.[field] !== command?.[field]) issues.push(`component receipt ${field} mismatch at index ${index}`);
    }
    if (component?.targetId !== command?.targetId) issues.push(`component receipt targetId mismatch at index ${index}`);
    if (component?.launchDigest !== command?.launchBinding?.launchDigest) {
      issues.push(`component receipt launchDigest mismatch at index ${index}`);
    }
    if (!RECEIPT_STATUSES.has(component?.status)) issues.push(`component receipt status is invalid at index ${index}`);
    if (unexpectedFields(component, COMPOSITE_COMPONENT_FIELDS).length) {
      issues.push(`component receipt contains unexpected fields at index ${index}`);
    }
    if (component?.exitCode !== null
      && (!Number.isSafeInteger(component?.exitCode) || component.exitCode < 0)) {
      issues.push(`component receipt exitCode is invalid at index ${index}`);
    }
    if (component?.signal !== null
      && (typeof component?.signal !== 'string' || !component.signal)) {
      issues.push(`component receipt signal is invalid at index ${index}`);
    }
    if (typeof component?.stdout !== 'string' || typeof component?.stderr !== 'string'
      || typeof component?.outputTruncated !== 'boolean'
      || !Number.isSafeInteger(component?.durationMs) || component.durationMs < 0) {
      issues.push(`component receipt process metadata is invalid at index ${index}`);
    }
    if (component?.status === 'PASS' && (component.exitCode !== 0 || component.signal !== null)) {
      issues.push(`PASS component receipt has a failing process result at index ${index}`);
    }
    if (component?.status === 'FAIL' && component.signal === null
      && (component.exitCode === null || component.exitCode === 0)) {
      issues.push(`FAIL component receipt lacks a failing process result at index ${index}`);
    }
  }
  for (let index = 0; index < Math.min(commandReceipts.length, expected.length); index += 1) {
    if (JSON.stringify(commandReceipts[index]) !== JSON.stringify(expected[index])) {
      issues.push(`composite command receipt mismatch at index ${index}`);
    }
  }
  if (evidence.status === 'PASS' && components.some(component => !['PASS', 'NA'].includes(component?.status))) {
    issues.push('PASS evidence contains a failed component receipt');
  }
  return issues;
}

function createEvidence(fields) {
  let evidence;
  try {
    // Persisted evidence is JSON. Normalize before hashing so omitted undefined
    // fields cannot make an in-memory digest differ from the disk round-trip.
    const sanitized = redactValue({
      schemaVersion: 2,
      ...fields,
      redactionPolicyVersion: REDACTION_POLICY_VERSION,
      filesystemBoundaryVersion: FILESYSTEM_BOUNDARY_VERSION,
      filesystemCapabilityDigest: FILESYSTEM_CAPABILITY_DIGEST,
    });
    if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
      throw new Error('redaction boundary rejected evidence');
    }
    evidence = JSON.parse(JSON.stringify(sanitized));
    if (Array.isArray(evidence.components)) {
      evidence.components = evidence.components.map(component => {
        const sealed = evidencePayload(component);
        return { ...sealed, digest: hashValue(sealed) };
      });
      evidence.componentAggregateHash = hashValue(evidence.components.map(component => component.digest));
    }
  } catch (error) {
    throw new Error(`evidence must be JSON-serializable: ${error.message}`);
  }
  const issues = validateEvidence(evidence);
  if (issues.length) throw new Error(issues.join('; '));
  evidence.digest = hashValue(evidencePayload(evidence));
  return evidence;
}

function assessEvidence(evidence, context = {}) {
  const reasons = validateEvidence(evidence);
  if (!evidence || typeof evidence !== 'object') return { fresh: false, reasons };
  if (!evidence.digest || hashValue(evidencePayload(evidence)) !== evidence.digest) {
    reasons.push('evidence digest mismatch');
  }
  if (context.sourceTreeHash && evidence.sourceTreeHash !== context.sourceTreeHash) {
    reasons.push('source tree hash mismatch');
  }
  if (context.certificationIdentityDigest
    && evidence.certificationIdentityDigest !== context.certificationIdentityDigest) {
    reasons.push('certification identity digest mismatch');
  }
  if (context.planHash && evidence.planHash !== context.planHash) reasons.push('plan hash mismatch');
  if (context.commandHash && evidence.commandHash !== context.commandHash) reasons.push('command hash mismatch');
  if (context.requireBinding && (!evidence.providerId || !evidence.bindingDigest)) reasons.push('UNTRUSTED_LEGACY_COMMAND');
  if (context.providerId && evidence.providerId !== context.providerId) reasons.push('provider identity mismatch');
  if (context.bindingDigest && evidence.bindingDigest !== context.bindingDigest) reasons.push('evidence binding digest mismatch');
  if (context.evidenceBinding) reasons.push(...validateEvidenceReceipt(evidence, context.evidenceBinding));
  const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
  if (evidence.expiresAt && Date.parse(evidence.expiresAt) <= now.getTime()) reasons.push('evidence expired');
  if (evidence.finishedAt && Date.parse(evidence.finishedAt) > now.getTime() + 5 * 60 * 1000) {
    reasons.push('evidence timestamp is in the future');
  }
  return { fresh: reasons.length === 0, reasons };
}

module.exports = { assessEvidence, createEvidence, validateEvidence, validateEvidenceReceipt };
