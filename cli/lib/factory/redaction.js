'use strict';

const { StringDecoder } = require('node:string_decoder');

const REDACTION_POLICY_VERSION = '1.0.0';
const REDACTED = '<redacted>';
const LIMIT_REDACTED = '<redacted:limit>';
const FAILURE_REDACTED = '<redacted:failure>';
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RUNTIME_SECRET_BYTES = 4096;
// A sensitive-named variable holding a flag (`SESSION=1`, `TOKEN=true`) carries no credential, and
// replacing such a literal everywhere would corrupt every digit or word of the output. Assignments
// and sensitive flags are still redacted by shape, whatever the value's length.
const TRIVIAL_LITERAL = /^(?:[\s\S]{1,3}|true|false|yes|no|on|off)$/i;

const SENSITIVE_NAME = '(?:[a-z0-9]+[-_])*(?:api[-_]?(?:key|token)|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret(?:[-_]?access[-_]?key)?|token|private[-_]?key|credential|cookie|set-cookie|session(?:[-_]?id)?|(?:database|db)[-_]?(?:url|uri)|dsn|connection[-_]?string)';
const SENSITIVE_KEY = new RegExp(`^${SENSITIVE_NAME}$`, 'i');
const SENSITIVE_FLAG = new RegExp(`^--?${SENSITIVE_NAME}(?:=|$)`, 'i');
const SENSITIVE_ASSIGNMENT = new RegExp(`((?:^|[\\s,{;\\\\/])${SENSITIVE_NAME}\\s*[:=]\\s*)(?!<redacted>)(?:"[^"]*"|'[^']*'|[^\\s,;}]+)`, 'gim');
const SENSITIVE_QUERY = new RegExp(`([?&]${SENSITIVE_NAME}=)[^&#\\s]+`, 'gi');
const SAFE_PLACEHOLDERS = new Set([REDACTED, LIMIT_REDACTED, FAILURE_REDACTED]);

function byteLength(value) { return Buffer.byteLength(String(value), 'utf8'); }
function isSensitiveKey(value) { return typeof value === 'string' && SENSITIVE_KEY.test(value); }
function isDigestLeaf(key, value) {
  return typeof key === 'string' && /(?:digest|hash)$/i.test(key)
    && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function credentialError(message) {
  const error = new Error(message);
  error.code = 'EVIDENCE_PROVIDER_CREDENTIAL';
  return error;
}

function shapedCredential(value) {
  if (typeof value !== 'string' || SAFE_PLACEHOLDERS.has(value)) return false;
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i.test(value)
    || /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/i.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/.test(value)
    || /(?:[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/i.test(value)
    || new RegExp(`[?&]${SENSITIVE_NAME}=[^&#\\s]+`, 'i').test(value)
    || new RegExp(`(?:^|[\\s,{;\\\\/])${SENSITIVE_NAME}\\s*[:=]\\s*(?!<redacted>)[^\\s,;}]+`, 'i').test(value);
}

function assertCredentialFreeArgv(argv) {
  if (!Array.isArray(argv)) throw credentialError('provider argv must be an array');
  let sensitiveValueExpected = false;
  for (const value of argv) {
    if (typeof value !== 'string') throw credentialError('provider argv must contain strings');
    if (sensitiveValueExpected) throw credentialError('provider argv contains a sensitive literal argument');
    if (SENSITIVE_FLAG.test(value)) {
      if (value.includes('=')) throw credentialError('provider argv contains a sensitive inline argument');
      sensitiveValueExpected = true;
      continue;
    }
    if (shapedCredential(value)) throw credentialError('provider argv contains credential-shaped material');
  }
  if (sensitiveValueExpected) throw credentialError('provider argv declares an unsupported sensitive argument');
  return true;
}

function secretValuesFromArgv(argv) {
  const values = [];
  let sensitiveValueExpected = false;
  for (const value of argv || []) {
    if (typeof value !== 'string') continue;
    if (sensitiveValueExpected) {
      values.push(value);
      sensitiveValueExpected = false;
      continue;
    }
    if (!SENSITIVE_FLAG.test(value)) continue;
    const equals = value.indexOf('=');
    if (equals >= 0) values.push(value.slice(equals + 1));
    else sensitiveValueExpected = true;
  }
  return values;
}

function compileRedactionPolicy({ argv = [], env = {} } = {}) {
  const values = [...secretValuesFromArgv(argv)];
  for (const [key, value] of Object.entries(env || {})) {
    if (isSensitiveKey(key) && value !== undefined && value !== null) values.push(String(value));
  }
  const secrets = [...new Set(values.filter(value => value && !SAFE_PLACEHOLDERS.has(value)
    && !TRIVIAL_LITERAL.test(value)))];
  for (const secret of secrets) {
    if (byteLength(secret) > MAX_RUNTIME_SECRET_BYTES) {
      return Object.freeze({ version: REDACTION_POLICY_VERSION, secrets: Object.freeze([]), failClosed: true });
    }
  }
  secrets.sort((left, right) => right.length - left.length || left.localeCompare(right));
  return Object.freeze({ version: REDACTION_POLICY_VERSION, secrets: Object.freeze(secrets) });
}

function replaceAllLiteral(text, literal) {
  return literal ? text.split(literal).join(REDACTED) : text;
}

function redactText(value, policy = compileRedactionPolicy()) {
  try {
    let text = String(value);
    if (policy.failClosed) return FAILURE_REDACTED;
    if (SAFE_PLACEHOLDERS.has(text)) return text;
    for (const secret of policy.secrets || []) text = replaceAllLiteral(text, secret);
    text = text.replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/gi, REDACTED);
    text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, match => `${match.split(/\s/, 1)[0]} ${REDACTED}`);
    text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
    text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, REDACTED);
    text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
    text = text.replace(SENSITIVE_QUERY, `$1${REDACTED}`);
    text = text.replace(SENSITIVE_ASSIGNMENT, `$1${REDACTED}`);
    return text;
  } catch {
    return FAILURE_REDACTED;
  }
}

function redactArgv(argv, policy = compileRedactionPolicy({ argv })) {
  if (!Array.isArray(argv)) return [FAILURE_REDACTED];
  const redacted = [];
  let redactNext = false;
  for (const raw of argv) {
    const value = typeof raw === 'string' ? raw : FAILURE_REDACTED;
    if (redactNext) { redacted.push(REDACTED); redactNext = false; continue; }
    if (SENSITIVE_FLAG.test(value)) {
      const equals = value.indexOf('=');
      if (equals >= 0) redacted.push(`${value.slice(0, equals)}=${REDACTED}`);
      else { redacted.push(value); redactNext = true; }
    } else redacted.push(redactText(value, policy));
  }
  return redacted;
}

function boundedTail(buffer, chunk, limit) {
  const combined = Buffer.concat([buffer, chunk]);
  if (combined.length <= limit) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.length - limit), truncated: true };
}

function createRedactingCollector({ policy = compileRedactionPolicy(), maxBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer');
  const guardBytes = Math.max(4096, ...(policy.secrets || []).map(secret => byteLength(secret) + 256));
  const rawLimit = maxBytes + guardBytes;
  let raw = Buffer.alloc(0);
  let truncated = false;
  let shapedMaterialSeen = false;
  let shapeCarry = '';
  const decoder = new StringDecoder('utf8');
  return Object.freeze({
    write(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const probe = shapeCarry + bytes.toString('utf8');
      shapedMaterialSeen ||= /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:Bearer|Basic)\s+|\b(?:eyJ|gh[pousr]_|github_pat_|sk-|AKIA)|[a-z][a-z0-9+.-]*:\/\//im.test(probe)
        || new RegExp(`(?:^|[\\s,{;\\\\/])${SENSITIVE_NAME}\\s*[:=]|[?&]${SENSITIVE_NAME}=`, 'im').test(probe);
      shapeCarry = probe.slice(-512);
      const result = boundedTail(raw, bytes, rawLimit);
      raw = result.buffer;
      truncated ||= result.truncated;
    },
    finish() {
      if (truncated && shapedMaterialSeen) return { text: FAILURE_REDACTED, truncated: true };
      const decoded = decoder.write(raw) + decoder.end();
      const sanitized = Buffer.from(redactText(decoded, policy), 'utf8');
      const bounded = sanitized.length <= maxBytes ? sanitized : sanitized.subarray(sanitized.length - maxBytes);
      return { text: bounded.toString('utf8'), truncated: truncated || sanitized.length > maxBytes };
    },
  });
}

function redactValue(value, options = {}) {
  const policy = options.policy || compileRedactionPolicy();
  const maxDepth = options.maxDepth || 24;
  const maxNodes = options.maxNodes || 10000;
  const maxStringBytes = options.maxStringBytes || 64 * 1024;
  const maxTotalBytes = options.maxTotalBytes || 1024 * 1024;
  const seen = new WeakSet();
  let nodes = 0;
  function visit(current, depth, key) {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) return LIMIT_REDACTED;
    if (isDigestLeaf(key, current)) return current;
    if (isSensitiveKey(key)) return current === REDACTED ? REDACTED : REDACTED;
    if (current === null || typeof current === 'boolean' || typeof current === 'number') return current;
    if (typeof current === 'string') {
      if (byteLength(current) > maxStringBytes) return LIMIT_REDACTED;
      return redactText(current, policy);
    }
    if (typeof current === 'undefined') return null;
    if (typeof current === 'bigint' || typeof current === 'symbol' || typeof current === 'function') return FAILURE_REDACTED;
    if (Buffer.isBuffer(current)) return FAILURE_REDACTED;
    if (!current || typeof current !== 'object') return FAILURE_REDACTED;
    if (seen.has(current)) return LIMIT_REDACTED;
    seen.add(current);
    if (Array.isArray(current)) {
      if (key === 'argv') return redactArgv(current, policy);
      return current.map(item => visit(item, depth + 1, null));
    }
    const result = {};
    for (const childKey of Object.keys(current)) result[childKey] = visit(current[childKey], depth + 1, childKey);
    return result;
  }
  try {
    const sanitized = visit(value, 0, null);
    return byteLength(JSON.stringify(sanitized)) > maxTotalBytes ? LIMIT_REDACTED : sanitized;
  } catch {
    return FAILURE_REDACTED;
  }
}

function containsSensitiveMaterial(value, policy = compileRedactionPolicy()) {
  const seen = new WeakSet();
  function inspect(current, key) {
    if (isDigestLeaf(key, current)) return false;
    if (isSensitiveKey(key) && current !== REDACTED) return true;
    if (typeof current === 'string') return redactText(current, policy) !== current;
    if (!current || typeof current !== 'object') return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) {
      if (key === 'argv') return JSON.stringify(redactArgv(current, policy)) !== JSON.stringify(current);
      return current.some(item => inspect(item, null));
    }
    return Object.entries(current).some(([childKey, child]) => inspect(child, childKey));
  }
  try { return inspect(value, null); } catch { return true; }
}

function redactError(error, policy = compileRedactionPolicy()) {
  const message = error && typeof error.message === 'string' ? error.message : 'Factory operation failed';
  return {
    code: error && typeof error.code === 'string' ? redactText(error.code, policy).slice(0, 128) : 'FACTORY_ERROR',
    message: redactText(message, policy).slice(0, 4096) || 'Factory operation failed',
  };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES, FAILURE_REDACTED, LIMIT_REDACTED, REDACTED,
  REDACTION_POLICY_VERSION, assertCredentialFreeArgv, compileRedactionPolicy,
  containsSensitiveMaterial, createRedactingCollector, isSensitiveKey,
  redactArgv, redactError, redactText, redactValue,
};
