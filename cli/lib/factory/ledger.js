'use strict';

const { hashValue } = require('./hash');
const { REDACTION_POLICY_VERSION } = require('./redaction');

const DIGEST = /^[a-f0-9]{64}$/;

function createEntry(previousHash, event, options = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('ledger event must be an object');
  const body = { schemaVersion: '1.0.0', sequence: options.sequence || 1, previousHash: previousHash || null, time: options.now || new Date().toISOString(), event };
  return { ...body, hash: hashValue(body) };
}

function verifyLedger(entries) {
  const gaps = [];
  let previous = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const { hash, ...body } = entry || {};
    if (!entry || hash !== hashValue(body)) gaps.push({ sequence: index + 1, code: 'hash-mismatch' });
    if (body.sequence !== index + 1) gaps.push({ sequence: index + 1, code: 'sequence-mismatch' });
    if (body.previousHash !== previous) gaps.push({ sequence: index + 1, code: 'chain-mismatch' });
    previous = hash;
  }
  return { status: gaps.length ? 'FAIL' : 'PASS', entries: entries.length, head: previous, gaps };
}

function summarizeLedger(entries) {
  const passed = entries.filter(item => item.event?.status === 'PASS').length;
  const failed = entries.filter(item => item.event?.status === 'FAIL').length;
  const durationMs = entries.reduce((sum, item) => sum + (Number(item.event?.durationMs) || 0), 0);
  return {
    total: entries.length,
    passed,
    failed,
    durationMs,
    successRate: entries.length ? Number(((passed / entries.length) * 100).toFixed(2)) : null,
    hasData: entries.length > 0,
  };
}

function assessCertificationLedger(entries, identity, options = {}) {
  const structural = verifyLedger(entries);
  if (structural.status !== 'PASS') {
    return {
      status: 'FAIL', current: false, entries: structural.entries, head: structural.head,
      gaps: [{ code: 'CERTIFICATION_LEDGER_TAMPERED', details: structural.gaps }], latest: null,
    };
  }

  const expectedTreeHash = identity?.sourceTreeHash || identity?.treeHash;
  if (!DIGEST.test(expectedTreeHash || '') || !DIGEST.test(identity?.certificationIdentityDigest || '')
    || !DIGEST.test(identity?.layoutInputDigest || '')) {
    return {
      status: 'FAIL', current: false, entries: structural.entries, head: structural.head,
      gaps: [{ code: 'CERTIFICATION_IDENTITY_INVALID' }], latest: null,
    };
  }

  const certifications = entries.filter(entry => entry?.event?.type === 'certification');
  const latestEntry = certifications[certifications.length - 1];
  if (!latestEntry) {
    return {
      status: 'FAIL', current: false, entries: structural.entries, head: structural.head,
      gaps: [{ code: 'CERTIFICATION_LEDGER_MISSING' }], latest: null,
    };
  }

  const latest = latestEntry.event;
  const latestTreeHash = latest.sourceTreeHash || latest.treeHash;
  const isV2 = latest.schemaVersion === '2.0.0'
    && DIGEST.test(latestTreeHash || '')
    && DIGEST.test(latest.certificationIdentityDigest || '')
    && DIGEST.test(latest.layoutInputDigest || '');
  if (!isV2) {
    return {
      status: 'FAIL', current: false, entries: structural.entries, head: structural.head,
      gaps: [{ code: 'CERTIFICATION_LEDGER_HISTORICAL' }], latest,
    };
  }

  if (latest.redactionPolicyVersion !== REDACTION_POLICY_VERSION) {
    return {
      status: 'FAIL', current: false, entries: structural.entries, head: structural.head,
      gaps: [{
        code: 'CERTIFICATION_LEDGER_REDACTION_POLICY_MISMATCH',
        expected: REDACTION_POLICY_VERSION,
        actual: latest.redactionPolicyVersion || null,
      }],
      latest,
    };
  }

  if (options.runId && latest.workflowRunId !== options.runId) {
    return {
      status: 'FAIL', current: false, entries: structural.entries, head: structural.head,
      gaps: [{ code: 'CERTIFICATION_LEDGER_RUN_MISMATCH', expected: options.runId, actual: latest.workflowRunId || null }], latest,
    };
  }
  if (options.level && latest.level !== options.level) {
    return {
      status: 'FAIL', current: false, entries: structural.entries, head: structural.head,
      gaps: [{ code: 'CERTIFICATION_LEDGER_LEVEL_MISMATCH', expected: options.level, actual: latest.level || null }], latest,
    };
  }

  const matches = latestTreeHash === expectedTreeHash
    && latest.certificationIdentityDigest === identity.certificationIdentityDigest
    && latest.layoutInputDigest === identity.layoutInputDigest;
  if (!matches) {
    return {
      status: 'FAIL', current: false, entries: structural.entries, head: structural.head,
      gaps: [{ code: 'CERTIFICATION_LEDGER_STALE' }], latest,
    };
  }
  if (latest.status !== 'PASS') {
    return {
      status: 'FAIL', current: true, entries: structural.entries, head: structural.head,
      gaps: [{ code: 'CERTIFICATION_LEDGER_CURRENT_FAIL' }], latest,
    };
  }
  return {
    status: 'PASS', current: true, entries: structural.entries, head: structural.head,
    scoped: Boolean(options.runId), gaps: [], latest,
  };
}

module.exports = { assessCertificationLedger, createEntry, summarizeLedger, verifyLedger };
