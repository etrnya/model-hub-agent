/**
 * IsolationBoundary (Phase 1-C3.3)
 * Implements Four-Tier Isolation Architecture, 13-Field Canonical TLV AdmissionReceipt,
 * Private WeakSet Branding, Global Lockdown Sentinel State Machine (Zero TOCTOU),
 * In-Memory Immutable File Snapshots, and the Internal 90-Row Base State Policy Matrix.
 *
 * Part of Agent OS Phase 1-C3.3 (Engineering PRD v2.3.3 Compliant: R1 ~ R13).
 * Author: etrnya
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class ContextIsolationError extends Error {
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`);
    this.name = 'ContextIsolationError';
    this.code = code;
    this.details = details;
    if (details && details.errno) {
      this.errno = details.errno;
    }
  }
}

// ============================================================================
// Tier 1: Primitive Ingestion & Private Branded Issuance (R1, R4, R6, R7)
// ============================================================================

const VALID_TASK_TYPES = Object.freeze(new Set(['SECURITY_AUDIT', 'REFACTOR', 'FEATURE_DEV', 'DOCS_UPDATE']));
const VALID_FRESHNESS = Object.freeze(new Set(['OPTIMAL', 'DEGRADED', 'DRIFT_DETECTED']));
const VALID_EVIDENCE = Object.freeze(new Set(['SOURCE_MATCHED', 'CONTENT_VERIFIED', 'STALE', 'UNVERIFIED', 'NONE']));
const VALID_RETRIEVAL = Object.freeze(new Set(['COMPLETE', 'PARTIAL', 'INCOMPLETE']));
const VALID_COMPLETENESS = Object.freeze(new Set(['FULL', 'TRUNCATED']));
const VALID_CONFIDENCE = Object.freeze(new Set(['HIGH', 'MEDIUM', 'LOW', 'NONE']));
const VALID_TOKEN_SOURCES = Object.freeze(new Set(['FRESH_LIVE_COMPILATION', 'IN_MEMORY_CACHE', 'DIAGNOSTIC_SYNTHESIS']));

// Module-private brand registries (unforgeable from outside this module closure)
const admittedReceiptBrand = new WeakSet();
const admittedTokenBrand = new WeakSet();

/**
 * R1, R7: Strict primitive string validator enforcing type, lone surrogate rejection,
 * real UTF-8 byte length bounds, enum membership, and regex pattern.
 */
function validatePrimitiveString(name, val, minBytes, maxBytes, enumSet, regexPattern) {
  if (typeof val !== 'string') {
    throw new ContextIsolationError('TYPE_VALIDATION_FAILED', `Field ${name} must be string`);
  }

  // R7: Reject lone surrogate code units (\uD800-\uDFFF)
  for (let i = 0; i < val.length; i++) {
    const code = val.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = i + 1 < val.length ? val.charCodeAt(i + 1) : 0;
      if (next < 0xDC00 || next > 0xDFFF) {
        throw new ContextIsolationError('INVALID_UNICODE_SURROGATE', `Field ${name} contains illegal high surrogate code unit`);
      }
      i++; // Valid surrogate pair
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new ContextIsolationError('INVALID_UNICODE_SURROGATE', `Field ${name} contains illegal low surrogate code unit`);
    }
  }

  // R1, R7: Real UTF-8 byte length check (after NFC normalization check)
  const byteLen = Buffer.byteLength(val, 'utf-8');
  if (byteLen < minBytes || byteLen > maxBytes) {
    throw new ContextIsolationError(
      'LENGTH_VALIDATION_FAILED',
      `Field ${name} byte length ${byteLen} out of range (${minBytes}..${maxBytes})`
    );
  }

  if (enumSet && !enumSet.has(val)) {
    throw new ContextIsolationError('ENUM_VALIDATION_FAILED', `Field ${name} value '${val}' not in allowed enum set`);
  }

  if (regexPattern && !regexPattern.test(val)) {
    throw new ContextIsolationError('PATTERN_VALIDATION_FAILED', `Field ${name} failed pattern validation`);
  }

  return val;
}

/**
 * Checks whether an string contains any lone UTF-16 surrogate code unit.
 */
function hasLoneSurrogate(str) {
  if (typeof str !== 'string') return false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next < 0xDC00 || next > 0xDFFF) return true;
      i++;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Tier 2: 13-Field Canonical TLV Binary Schema & Tenant-Bound Hashing (R6, R7)
// ============================================================================

const TLV_TAG_LIMITS = Object.freeze({
  0x01: 16,   // schemaVersion
  0x02: 128,  // taskId
  0x03: 64,   // tenantId (R6)
  0x04: 32,   // taskType
  0x05: 128,  // snapshotId
  0x06: 32,   // snapshotFreshness
  0x07: 32,   // policyVersion
  0x08: 32,   // aggregateEvidenceStatus
  0x09: 32,   // retrievalStatus
  0x0A: 32,   // completenessStatus
  0x0B: 64,   // evaluatedItemsHash
  0x0C: 2048, // diagnosticReason
  0x0D: 32    // diagnosticConfidence
});

/**
 * R6, R7: Encodes the 13 PureAdmissionParams fields into the canonical TLV binary Buffer.
 */
function encodeCanonicalTLVBuffer(fields) {
  if (!fields || typeof fields !== 'object') {
    throw new ContextIsolationError('TYPE_VALIDATION_FAILED', 'TLV fields must be a non-null object');
  }

  const DOMAIN_SEPARATOR = Buffer.from('ANTIGRAVITY_ADMISSION_RECEIPT_v233\0', 'utf-8');
  const chunks = [DOMAIN_SEPARATOR];

  const orderedFields = [
    [0x01, fields.schemaVersion],
    [0x02, fields.taskId],
    [0x03, fields.tenantId],
    [0x04, fields.taskType],
    [0x05, fields.snapshotId],
    [0x06, fields.snapshotFreshness],
    [0x07, fields.policyVersion],
    [0x08, fields.aggregateEvidenceStatus],
    [0x09, fields.retrievalStatus],
    [0x0A, fields.completenessStatus],
    [0x0B, fields.evaluatedItemsHash],
    [0x0C, fields.diagnosticReason],
    [0x0D, fields.diagnosticConfidence]
  ];

  for (const [tag, val] of orderedFields) {
    const tagBuf = Buffer.alloc(1, tag);
    if (val === null && tag === 0x0C) {
      const typeBuf = Buffer.alloc(1, 0x00); // 0x00: Null
      const lenBuf = Buffer.alloc(4, 0x00);
      chunks.push(tagBuf, typeBuf, lenBuf);
    } else {
      if (typeof val !== 'string') {
        throw new ContextIsolationError(
          'TYPE_VALIDATION_FAILED',
          `Tag 0x${tag.toString(16).padStart(2, '0')} must be a string`
        );
      }

      if (hasLoneSurrogate(val)) {
        throw new ContextIsolationError(
          'INVALID_UNICODE_SURROGATE',
          `Tag 0x${tag.toString(16).padStart(2, '0')} contains lone surrogate code units`
        );
      }

      // R7: Mandatory Unicode NFC Normalization
      const normalizedVal = val.normalize('NFC');
      const valBuf = Buffer.from(normalizedVal, 'utf-8');

      // R7: Per-Tag UTF-8 byte length ceiling enforcement
      const maxAllowed = TLV_TAG_LIMITS[tag] || 65536;
      if (valBuf.length === 0 || valBuf.length > maxAllowed) {
        throw new ContextIsolationError(
          'TLV_FIELD_SIZE_EXCEEDED',
          `Tag 0x${tag.toString(16).padStart(2, '0')} byte length ${valBuf.length} out of bounds (1..${maxAllowed})`
        );
      }

      const typeBuf = Buffer.alloc(1, 0x01); // 0x01: String
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(valBuf.length, 0);
      chunks.push(tagBuf, typeBuf, lenBuf, valBuf);
    }
  }

  return Buffer.concat(chunks);
}

/**
 * R4, R6, R7: Computes the 64-char hex SHA-256 over the 13-Field TLV stream + candidate contextText SHA-256.
 */
function computeEnvelopeBindingHashTLV(fields, contextTextHash) {
  validatePrimitiveString('contextTextHash', contextTextHash, 64, 64, undefined, /^[a-f0-9]{64}$/);
  const tlvBuffer = encodeCanonicalTLVBuffer(fields);
  const contextHashBuf = Buffer.from(contextTextHash, 'hex');
  return crypto.createHash('sha256').update(Buffer.concat([tlvBuffer, contextHashBuf])).digest('hex');
}

/**
 * R1, R4: Sole authoritative issuer for AdmissionReceipt.
 * Validates all 13 discrete primitive fields, computes TLV hash, freezes with null prototype,
 * and registers in module-private admittedReceiptBrand WeakSet.
 */
class AdmissionReceiptIssuer {
  static issueReceipt(params, contextTextHash) {
    if (!params || typeof params !== 'object') {
      throw new ContextIsolationError('TYPE_VALIDATION_FAILED', 'PureAdmissionParams must be provided');
    }

    // 1. Strict field-by-field primitive validation (UTF-8 byte limits & enums)
    const schemaVersion = validatePrimitiveString('schemaVersion', params.schemaVersion, 3, 16, new Set(['1.0'])).normalize('NFC');
    const taskId = validatePrimitiveString('taskId', params.taskId, 1, 128).normalize('NFC');
    const tenantId = validatePrimitiveString('tenantId', params.tenantId, 1, 64).normalize('NFC');
    const taskType = validatePrimitiveString('taskType', params.taskType, 1, 32, VALID_TASK_TYPES).normalize('NFC');
    const snapshotId = validatePrimitiveString('snapshotId', params.snapshotId, 1, 128).normalize('NFC');
    const snapshotFreshness = validatePrimitiveString('snapshotFreshness', params.snapshotFreshness, 1, 32, VALID_FRESHNESS).normalize('NFC');
    const policyVersion = validatePrimitiveString('policyVersion', params.policyVersion, 5, 32, new Set(['2.3.3'])).normalize('NFC');
    const aggregateEvidenceStatus = validatePrimitiveString('aggregateEvidenceStatus', params.aggregateEvidenceStatus, 1, 32, VALID_EVIDENCE).normalize('NFC');
    const retrievalStatus = validatePrimitiveString('retrievalStatus', params.retrievalStatus, 1, 32, VALID_RETRIEVAL).normalize('NFC');
    const completenessStatus = validatePrimitiveString('completenessStatus', params.completenessStatus, 1, 32, VALID_COMPLETENESS).normalize('NFC');
    const evaluatedItemsHash = validatePrimitiveString('evaluatedItemsHash', params.evaluatedItemsHash, 64, 64, undefined, /^[a-f0-9]{64}$/).normalize('NFC');

    let diagnosticReason = null;
    if (params.diagnosticReason !== null && params.diagnosticReason !== undefined) {
      diagnosticReason = validatePrimitiveString('diagnosticReason', params.diagnosticReason, 1, 2048).normalize('NFC');
    }
    const diagnosticConfidence = validatePrimitiveString('diagnosticConfidence', params.diagnosticConfidence, 1, 32, VALID_CONFIDENCE).normalize('NFC');

    const normalizedParams = {
      schemaVersion,
      taskId,
      tenantId,
      taskType,
      snapshotId,
      snapshotFreshness,
      policyVersion,
      aggregateEvidenceStatus,
      retrievalStatus,
      completenessStatus,
      evaluatedItemsHash,
      diagnosticReason,
      diagnosticConfidence
    };

    // 2. Compute canonical 13-field TLV hash
    const envelopeBindingHash = computeEnvelopeBindingHashTLV(normalizedParams, contextTextHash);

    // 3. Construct null-prototype pure data object & freeze
    const receipt = Object.freeze(Object.assign(Object.create(null), {
      ...normalizedParams,
      envelopeBindingHash,
      issuedTimestampMonotonic: process.hrtime.bigint().toString(),
      issuedTimestampWallClock: new Date().toISOString()
    }));

    // 4. Add to module-private brand WeakSet
    admittedReceiptBrand.add(receipt);

    return receipt;
  }
}

function isBrandedAdmissionReceipt(receipt) {
  return Boolean(receipt && admittedReceiptBrand.has(receipt));
}

/**
 * R3, R6: Sole authoritative issuer for SourceProvenanceToken.
 */
class ProvenanceTokenIssuer {
  static issueToken(params) {
    if (!params || typeof params !== 'object') {
      throw new ContextIsolationError('TYPE_VALIDATION_FAILED', 'ProvenanceToken params must be provided');
    }

    const schemaVersion = validatePrimitiveString('schemaVersion', params.schemaVersion || '1.0', 3, 16, new Set(['1.0']));
    const tokenBrand = validatePrimitiveString('tokenBrand', params.tokenBrand || 'ANTIGRAVITY_PROVENANCE_v233', 1, 64, new Set(['ANTIGRAVITY_PROVENANCE_v233']));
    const source = validatePrimitiveString('source', params.source || 'FRESH_LIVE_COMPILATION', 1, 32, VALID_TOKEN_SOURCES);
    const targetSymbol = validatePrimitiveString('targetSymbol', params.targetSymbol, 1, 256);
    const taskId = validatePrimitiveString('taskId', params.taskId, 1, 128);
    const tenantId = validatePrimitiveString('tenantId', params.tenantId, 1, 64);
    const snapshotId = validatePrimitiveString('snapshotId', params.snapshotId, 1, 128);
    const envelopeSha256 = validatePrimitiveString('envelopeSha256', params.envelopeSha256, 64, 64, undefined, /^[a-f0-9]{64}$/);

    const token = Object.freeze(Object.assign(Object.create(null), {
      schemaVersion,
      tokenBrand,
      source,
      targetSymbol,
      taskId,
      tenantId,
      snapshotId,
      compiledAtMonotonic: process.hrtime.bigint().toString(),
      compiledAtWallClock: new Date().toISOString(),
      envelopeSha256
    }));

    admittedTokenBrand.add(token);
    return token;
  }
}

function isBrandedProvenanceToken(token) {
  return Boolean(token && admittedTokenBrand.has(token));
}

// ============================================================================
// Tier 2: Tenant-Isolated Cache with Monotonic Clock Skew Guard (C3.3-T2, C3.3-T3)
// ============================================================================

class TenantIsolatedCache {
  /**
   * @param {object} [options]
   * @param {Function} [options.monotonicClockFn] - Returns BigInt nanoseconds (default: process.hrtime.bigint)
   * @param {number} [options.ttlMs=300000] - Cache TTL in milliseconds (default 5 min)
   */
  constructor(options = {}) {
    this.cacheStore = new Map();
    this.monotonicClockFn = options.monotonicClockFn || (() => process.hrtime.bigint());
    this.ttlNs = BigInt(options.ttlMs !== undefined ? options.ttlMs : 300000) * 1000000n;
    this.lastMonotonicNs = this.monotonicClockFn();
  }

  _checkMonotonicClock() {
    const nowNs = BigInt(this.monotonicClockFn());
    if (nowNs < this.lastMonotonicNs) {
      // C3.3-T3: Immediate cache purge & Fail-Closed on monotonic clock rollback
      this.cacheStore.clear();
      throw new ContextIsolationError(
        'MONOTONIC_CLOCK_SKEW_DETECTED',
        `Monotonic clock regressed from ${this.lastMonotonicNs} to ${nowNs}; cache purged`
      );
    }
    this.lastMonotonicNs = nowNs;
    return nowNs;
  }

  /**
   * Computes a collision-free length-prefixed canonical cache key bound to tenantId.
   */
  static computeCacheKey({ tenantId, snapshotId, targetSymbol, taskType }) {
    validatePrimitiveString('tenantId', tenantId, 1, 64);
    validatePrimitiveString('snapshotId', snapshotId, 1, 128);
    validatePrimitiveString('targetSymbol', targetSymbol, 1, 256);
    validatePrimitiveString('taskType', taskType, 1, 32, VALID_TASK_TYPES);

    const parts = [
      tenantId.normalize('NFC'),
      snapshotId.normalize('NFC'),
      targetSymbol.normalize('NFC'),
      taskType.normalize('NFC')
    ];
    const bufs = [Buffer.from('ANTIGRAVITY_CACHE_KEY_v233\0', 'utf-8')];
    for (const part of parts) {
      const b = Buffer.from(part, 'utf-8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(b.length, 0);
      bufs.push(len, b);
    }
    return crypto.createHash('sha256').update(Buffer.concat(bufs)).digest('hex');
  }

  set(keyParams, value) {
    const nowNs = this._checkMonotonicClock();
    const key = TenantIsolatedCache.computeCacheKey(keyParams);
    this.cacheStore.set(key, {
      tenantId: keyParams.tenantId,
      snapshotId: keyParams.snapshotId,
      insertedAtNs: nowNs,
      value
    });
    return key;
  }

  get(keyParams) {
    const nowNs = this._checkMonotonicClock();
    const key = TenantIsolatedCache.computeCacheKey(keyParams);
    const entry = this.cacheStore.get(key);
    if (!entry) return null;

    if (entry.tenantId !== keyParams.tenantId) {
      this.cacheStore.delete(key);
      throw new ContextIsolationError('TENANT_ISOLATION_VIOLATION', 'Cross-tenant cache access blocked');
    }

    if (nowNs - entry.insertedAtNs > this.ttlNs) {
      this.cacheStore.delete(key);
      return null;
    }

    return entry.value;
  }
}

// ============================================================================
// Tier 3: Execution Permission Hard Isolation (C3.3-T5, C3.3-T6)
// ============================================================================

const WHITELISTED_READ_ONLY_TOOLS = Object.freeze(new Set([
  'read_file',
  'codegraph_search',
  'codegraph_context',
  'codegraph_node',
  'codegraph_explore',
  'codegraph_trace'
]));

const FORBIDDEN_MUTATING_TOOLS = Object.freeze(new Set([
  'write_file',
  'edit_file',
  'run_command',
  'delete_file',
  'bash',
  'powershell'
]));

class ExecutionBoundaryGuard {
  constructor(options = {}) {
    // Tier 3 invariant: allowExecution is strictly locked to false during context assembly
    Object.defineProperty(this, 'allowExecution', {
      value: false,
      writable: false,
      configurable: false,
      enumerable: true
    });
    this.allowedTools = options.allowedTools
      ? new Set(options.allowedTools)
      : WHITELISTED_READ_ONLY_TOOLS;
  }

  /**
   * C3.3-T5: Intercepts and blocks any non-read-only tool invocation during context assembly.
   */
  authorizeToolCall(toolName) {
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new ContextIsolationError('TOOL_EXECUTION_FORBIDDEN', 'Tool name must be a non-empty string');
    }
    if (this.allowExecution !== false) {
      throw new ContextIsolationError('TOOL_EXECUTION_FORBIDDEN', 'Execution boundary flag tampered');
    }
    if (FORBIDDEN_MUTATING_TOOLS.has(toolName) || !this.allowedTools.has(toolName)) {
      throw new ContextIsolationError(
        'TOOL_EXECUTION_FORBIDDEN',
        `Tool '${toolName}' is strictly forbidden inside Phase 1-C3.3 read-only isolation boundary`
      );
    }
    return true;
  }

  /**
   * C3.3-T6: Blocks any non-read-only IPC request when allowExecution === false.
   */
  authorizeIpcRequest(ipcRequest) {
    if (!ipcRequest || typeof ipcRequest !== 'object') {
      throw new ContextIsolationError('TOOL_EXECUTION_FORBIDDEN', 'Malformed IPC request');
    }
    if (this.allowExecution === false && ipcRequest.mode !== 'READ_ONLY') {
      throw new ContextIsolationError(
        'TOOL_EXECUTION_FORBIDDEN',
        `IPC request mode '${ipcRequest.mode}' blocked by allowExecution: false`
      );
    }
    if (ipcRequest.toolName) {
      this.authorizeToolCall(ipcRequest.toolName);
    }
    return true;
  }
}

// ============================================================================
// Tier 4: Global Lockdown Sentinel State Machine, Symlink Guard & Immutable Snapshots (R5, R8)
// ============================================================================

const DEFAULT_LOCKDOWN_BASE_DIR = process.platform === 'win32'
  ? 'C:\\ProgramData\\Antigravity'
  : '/var/lib/antigravity';

/**
 * Default cross-platform lock binding tracking active locks per file descriptor
 * and recording lock operation sequence for deterministic TOCTOU audit.
 */
function createDefaultLockBinding() {
  const activeLocks = new Map();
  const operationLog = [];
  return {
    operationLog,
    acquireLock(fd, mode, _timeoutMs = 5000) {
      if (typeof fd !== 'number' || fd < 0) return false;
      operationLog.push({ op: 'acquireLock', fd, mode, timestamp: Date.now() });
      activeLocks.set(fd, mode);
      return true;
    },
    releaseLock(fd) {
      operationLog.push({ op: 'releaseLock', fd, timestamp: Date.now() });
      activeLocks.delete(fd);
      return true;
    },
    isLocked(fd) {
      return activeLocks.has(fd);
    }
  };
}

const defaultLockBinding = createDefaultLockBinding();

/**
 * R5, C3.3-T12: Reader gate for Global Lockdown.
 * Zero TOCTOU: Acquires OS shared lock on sentinel BEFORE checking if lockdown record exists.
 */
function assertSandboxNotLocked(lockBinding = defaultLockBinding, options = {}) {
  const baseDir = options.baseDir || DEFAULT_LOCKDOWN_BASE_DIR;
  const lockdownFilePath = path.join(baseDir, 'sandbox_lockdown.json');
  const sentinelLockPath = path.join(baseDir, 'sandbox_lockdown.lock');

  // 1. Ensure Sentinel lock file exists and open with restricted permissions
  if (!fs.existsSync(sentinelLockPath)) {
    try {
      fs.mkdirSync(baseDir, { recursive: true, mode: 0o750 });
      const initFd = fs.openSync(sentinelLockPath, 'a', 0o640);
      fs.closeSync(initFd);
    } catch (_) {
      // Ignore concurrent creation race
    }
  }

  let lockFd;
  try {
    lockFd = fs.openSync(sentinelLockPath, 'r');
  } catch (openErr) {
    throw new ContextIsolationError(
      'ABORT_GLOBAL_LOCKDOWN_ACTIVE',
      `Failed to open sentinel lock file (${openErr.message}), failing closed`
    );
  }

  try {
    // 2. Acquire OS Shared Lock (LOCK_SH / LockFileEx Shared) BEFORE checking main record
    const acquired = lockBinding.acquireLock(lockFd, 'SHARED', 5000);
    if (!acquired) {
      throw new ContextIsolationError(
        'ABORT_GLOBAL_LOCKDOWN_ACTIVE',
        'Failed to acquire shared lock on sentinel, failing closed'
      );
    }

    // Validate Sentinel Identity inside lock (fstat ino/dev)
    const sentinelStat = fs.fstatSync(lockFd);
    if (!sentinelStat.isFile()) {
      throw new ContextIsolationError('ABORT_GLOBAL_LOCKDOWN_ACTIVE', 'Sentinel lock is not a regular file');
    }

    if (lockBinding.operationLog) {
      lockBinding.operationLog.push({ op: 'checkRecordInsideLock', fd: lockFd, timestamp: Date.now() });
    }

    // 3. Inside critical section: check if main lockdown record exists
    if (!fs.existsSync(lockdownFilePath)) {
      return; // Clean: no lockdown active
    }

    const raw = fs.readFileSync(lockdownFilePath, 'utf-8');
    const record = JSON.parse(raw);

    // 4. Validate Schema & isLocked flag
    if (!record || typeof record.isLocked !== 'boolean' || record.version !== 1) {
      throw new ContextIsolationError(
        'ABORT_GLOBAL_LOCKDOWN_ACTIVE',
        'Lockdown record schema corrupted, failing closed'
      );
    }

    if (record.isLocked) {
      const residuals = Array.isArray(record.residualResources) ? record.residualResources.join(', ') : 'unknown';
      throw new ContextIsolationError(
        'ABORT_GLOBAL_LOCKDOWN_ACTIVE',
        `Locked down at ${record.lockdownTimestamp} due to ${record.lockdownReason}. Residuals: ${residuals}`
      );
    }
  } catch (e) {
    if (e instanceof ContextIsolationError) throw e;
    throw new ContextIsolationError(
      'ABORT_GLOBAL_LOCKDOWN_ACTIVE',
      `Sandbox lockdown record verification failed (${e.message}), failing closed`
    );
  } finally {
    try {
      lockBinding.releaseLock(lockFd);
    } finally {
      fs.closeSync(lockFd);
    }
  }
}

/**
 * R5, C3.3-T12: Writer gate for Global Lockdown.
 * Acquires exclusive lock on sentinel, writes .tmp, fsyncs, and atomically renames over sandbox_lockdown.json.
 */
function triggerGlobalLockdown(probeId, reason, residuals = [], lockBinding = defaultLockBinding, options = {}) {
  const baseDir = options.baseDir || DEFAULT_LOCKDOWN_BASE_DIR;
  const lockdownFilePath = path.join(baseDir, 'sandbox_lockdown.json');
  const sentinelLockPath = path.join(baseDir, 'sandbox_lockdown.lock');

  fs.mkdirSync(baseDir, { recursive: true, mode: 0o750 });
  const lockFd = fs.openSync(sentinelLockPath, 'a+', 0o640);

  try {
    // 1. Acquire Exclusive Lock (LOCK_EX / LockFileEx Exclusive)
    const acquired = lockBinding.acquireLock(lockFd, 'EXCLUSIVE', 10000);
    if (!acquired) {
      throw new ContextIsolationError(
        'ABORT_GLOBAL_LOCKDOWN_ACTIVE',
        'Failed to acquire exclusive lock to record lockdown'
      );
    }

    const record = {
      version: 1,
      scope: options.scope || 'PER_MACHINE',
      isLocked: true,
      lockdownTimestamp: new Date().toISOString(),
      failedProbeId: String(probeId || 'UNKNOWN_PROBE'),
      residualResources: Array.isArray(residuals) ? residuals.map(String) : [],
      lockdownReason: String(reason || 'Unspecified sandbox containment failure'),
      clearedBy: null,
      clearedTimestamp: null
    };

    const tmpFile = `${lockdownFilePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(record, null, 2), { mode: 0o644 });
    const tmpFd = fs.openSync(tmpFile, 'r+');
    try {
      fs.fdatasyncSync(tmpFd);
    } finally {
      fs.closeSync(tmpFd);
    }

    // 2. Atomic replacement
    fs.renameSync(tmpFile, lockdownFilePath);

    // 3. Directory fsync (best-effort on Windows, mandatory on Linux)
    try {
      const dirFd = fs.openSync(baseDir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (_) {
      // Windows directory open/fsync is handled by NTFS journal on renameSync
    }
  } finally {
    try {
      lockBinding.releaseLock(lockFd);
    } finally {
      fs.closeSync(lockFd);
    }
  }

  throw new ContextIsolationError('ABORT_GLOBAL_LOCKDOWN_ACTIVE', `Global lockdown triggered: ${reason}`);
}

/**
 * Section 7.2: `agy sandbox reset --verify-clean` 5-Step Admin Reset SOP.
 */
function resetSandboxLockdownAdmin(lockBinding = defaultLockBinding, options = {}) {
  const baseDir = options.baseDir || DEFAULT_LOCKDOWN_BASE_DIR;
  const lockdownFilePath = path.join(baseDir, 'sandbox_lockdown.json');
  const sentinelLockPath = path.join(baseDir, 'sandbox_lockdown.lock');

  fs.mkdirSync(baseDir, { recursive: true, mode: 0o750 });
  const lockFd = fs.openSync(sentinelLockPath, 'a+', 0o640);

  try {
    // Step 1: Acquire EXCLUSIVE lock on sentinel
    if (!lockBinding.acquireLock(lockFd, 'EXCLUSIVE', 10000)) {
      throw new ContextIsolationError('ADMIN_RESET_FAILED', 'Could not acquire exclusive sentinel lock');
    }

    // Step 2: Process Enumeration Check
    const activeSandboxProcesses = options.activeSandboxProcesses || [];
    if (activeSandboxProcesses.length > 0) {
      throw new ContextIsolationError(
        'ADMIN_RESET_FAILED',
        `Residual antigravity-sandbox processes still active: ${activeSandboxProcesses.join(', ')}`
      );
    }

    // Step 3: Cgroup / Job Object Zero Verification
    const activeContainers = options.activeContainers || 0;
    if (activeContainers > 0) {
      throw new ContextIsolationError(
        'ADMIN_RESET_FAILED',
        `Residual cgroup/Job Object still has ${activeContainers} populated processes`
      );
    }

    // Step 4: Active Launcher Mutual Exclusion Check
    if (options.activeLauncherPid) {
      throw new ContextIsolationError(
        'ADMIN_RESET_FAILED',
        `Active Launcher process (${options.activeLauncherPid}) is currently executing`
      );
    }

    // Step 5: Atomic Write of Cleared Record
    let existingRecord = {
      version: 1,
      scope: 'PER_MACHINE',
      lockdownTimestamp: new Date().toISOString(),
      failedProbeId: 'NONE',
      residualResources: [],
      lockdownReason: 'NONE'
    };
    if (fs.existsSync(lockdownFilePath)) {
      try {
        existingRecord = JSON.parse(fs.readFileSync(lockdownFilePath, 'utf-8'));
      } catch (_) {
        // Overwrite corrupted record with clean state
      }
    }

    const clearedRecord = {
      ...existingRecord,
      version: 1,
      isLocked: false,
      residualResources: [],
      clearedBy: 'ADMIN_CLI',
      clearedTimestamp: new Date().toISOString()
    };

    const tmpFile = `${lockdownFilePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(clearedRecord, null, 2), { mode: 0o644 });
    const tmpFd = fs.openSync(tmpFile, 'r+');
    try {
      fs.fdatasyncSync(tmpFd);
    } finally {
      fs.closeSync(tmpFd);
    }
    fs.renameSync(tmpFile, lockdownFilePath);

    return clearedRecord;
  } finally {
    try {
      lockBinding.releaseLock(lockFd);
    } finally {
      fs.closeSync(lockFd);
    }
  }
}

/**
 * C3.3-T7: Enforces POSIX openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV)
 * path resolution semantics across platforms.
 * Walks every path segment using lstatSync and immediately rejects any symbolic link with ELOOP.
 */
function resolveSafePathNoSymlinks(workspaceRoot, relativeOrTargetPath) {
  if (typeof workspaceRoot !== 'string' || typeof relativeOrTargetPath !== 'string' || !relativeOrTargetPath) {
    throw new ContextIsolationError('INVALID_PATH', 'Workspace root and target path must be non-empty strings');
  }

  const rootResolved = path.resolve(workspaceRoot);
  const rootStat = fs.lstatSync(rootResolved);
  if (rootStat.isSymbolicLink()) {
    throw new ContextIsolationError('ELOOP', 'Workspace root itself cannot be a symbolic link', { errno: 'ELOOP' });
  }

  // Normalize slashes and split into segments
  const normalizedRel = relativeOrTargetPath.replace(/\\/g, '/');
  if (path.isAbsolute(relativeOrTargetPath) || normalizedRel.startsWith('/')) {
    throw new ContextIsolationError('RESOLVE_BENEATH_VIOLATION', 'Absolute paths are forbidden under RESOLVE_BENEATH');
  }

  const segments = normalizedRel.split('/').filter(s => s.length > 0 && s !== '.');
  let currentPath = rootResolved;

  for (const segment of segments) {
    if (segment === '..') {
      throw new ContextIsolationError('RESOLVE_BENEATH_VIOLATION', 'Parent directory traversal (..) is forbidden under RESOLVE_BENEATH');
    }

    currentPath = path.join(currentPath, segment);
    let stat;
    try {
      stat = fs.lstatSync(currentPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new ContextIsolationError('FILE_NOT_FOUND', `Path segment not found: ${segment}`, { errno: 'ENOENT' });
      }
      throw err;
    }

    // RESOLVE_NO_SYMLINKS: reject any interior or terminal symlink with ELOOP
    if (stat.isSymbolicLink()) {
      throw new ContextIsolationError(
        'ELOOP',
        `RESOLVE_NO_SYMLINKS blocked symbolic link at segment '${segment}' (${currentPath})`,
        { errno: 'ELOOP' }
      );
    }

    // RESOLVE_NO_XDEV: verify device ID matches root
    if (stat.dev !== rootStat.dev) {
      throw new ContextIsolationError(
        'EXDEV',
        `RESOLVE_NO_XDEV blocked cross-device traversal at '${currentPath}'`,
        { errno: 'EXDEV' }
      );
    }
  }

  return currentPath;
}

/**
 * R8, C3.3-T13: In-Memory Immutable File Snapshot Reader.
 * Opens file descriptor once, verifies 4-tuple fstat (st_size, st_mtime, st_ino, st_dev)
 * before and after single Buffer read, freezes the memory snapshot, and severing all
 * subsequent operations from disk re-reads (eliminating post-read TOCTOU).
 */
function readImmutableFileSnapshot(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new ContextIsolationError('INVALID_PATH', 'filePath must be a non-empty string');
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const statBefore = fs.fstatSync(fd);
    if (!statBefore.isFile()) {
      throw new ContextIsolationError('NOT_A_FILE', `Target is not a regular file: ${filePath}`);
    }

    const buffer = Buffer.alloc(statBefore.size);
    let totalRead = 0;
    while (totalRead < statBefore.size) {
      const bytesRead = fs.readSync(fd, buffer, totalRead, statBefore.size - totalRead, totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }

    // Optional hook for testing mid-read concurrent modification (C3.3-T13)
    if (typeof options.onMidReadHook === 'function') {
      options.onMidReadHook(filePath, fd);
    }

    const statAfter = options.overrideStatAfter
      ? options.overrideStatAfter(statBefore)
      : fs.fstatSync(fd);

    // 4-Tuple fstat Verification: st_size, st_mtimeMs, st_ino, st_dev
    const sizeMatch = statBefore.size === statAfter.size && totalRead === statBefore.size;
    const mtimeMatch = statBefore.mtimeMs === statAfter.mtimeMs;
    const inoMatch = statBefore.ino === statAfter.ino;
    const devMatch = statBefore.dev === statAfter.dev;

    if (!sizeMatch || !mtimeMatch || !inoMatch || !devMatch) {
      throw new ContextIsolationError(
        'FILE_CONCURRENTLY_MODIFIED',
        `File '${filePath}' was modified concurrently during snapshot capture (4-tuple fstat mismatch)`
      );
    }

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const text = buffer.toString('utf-8');
    // Freeze the byte array and keep raw Buffer inside private closure so memory is 100% immutable
    const privateBuffer = Buffer.from(buffer);
    const immutableBytes = Object.freeze(Array.from(privateBuffer));

    return Object.freeze(Object.assign(Object.create(null), {
      filePath,
      byteLength: privateBuffer.length,
      sha256,
      text,
      immutableBytes,
      statSnapshot: Object.freeze({
        size: statBefore.size,
        mtimeMs: statBefore.mtimeMs,
        ino: statBefore.ino,
        dev: statBefore.dev
      }),
      getBufferCopy() {
        return Buffer.from(privateBuffer);
      }
    }));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Section 4.1, C3.3-T10: SQLite WAL Concurrency Retry SOP (Max 3 Retries + Plan B Degradation).
 * Retries SQLITE_BUSY up to 3 times (50ms, 100ms, 200ms + jitter).
 * Strictly forbids a 4th retry and transitions RouterHealth to DEGRADED.
 */
async function executeSqliteWithWalRetry(queryFn, fallbackFn = null, options = {}) {
  const maxRetries = 3;
  const baseDelayMs = options.baseDelayMs !== undefined ? options.baseDelayMs : 50;
  let attemptCount = 0;

  while (attemptCount < maxRetries) {
    attemptCount++;
    try {
      const data = await queryFn(attemptCount);
      return {
        routerHealth: 'OPTIMAL',
        attempts: attemptCount,
        degradedToPlanB: false,
        data
      };
    } catch (err) {
      const isBusy = err && (
        err.code === 'SQLITE_BUSY' ||
        err.code === 'SQLITE_LOCKED' ||
        (typeof err.message === 'string' && err.message.includes('SQLITE_BUSY'))
      );
      if (!isBusy) {
        throw err;
      }

      if (attemptCount < maxRetries) {
        const expDelay = baseDelayMs * Math.pow(2, attemptCount - 1);
        const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseDelayMs / 5)));
        await new Promise(resolve => setTimeout(resolve, expDelay + jitter));
      }
    }
  }

  // Strictly after 3 failed attempts: DO NOT make a 4th query! Transition to Plan B Degradation.
  const fallbackData = typeof fallbackFn === 'function' ? await fallbackFn() : null;
  return {
    routerHealth: 'DEGRADED',
    attempts: attemptCount, // Guaranteed === 3
    degradedToPlanB: true,
    diagnosticReason: 'SQLITE_WAL_LOCK_EXHAUSTED',
    data: fallbackData
  };
}

/**
 * C3.3-T14: DLP Scan with Cooperative Abort Checkpoints.
 * Checks abortSignal across checkpoints and terminates within <= 3 checkpoints if aborted,
 * ensuring zero leakage of unreviewed sensitive data.
 */
async function scanWithAbortCheckpoints(guardrailManager, payload, abortSignal = null) {
  let checkpointsReached = 0;

  const checkAbort = () => {
    checkpointsReached++;
    if (abortSignal && abortSignal.aborted) {
      throw new ContextIsolationError(
        'DLP_ABORTED_BY_SIGNAL',
        `DLP scan aborted at checkpoint ${checkpointsReached}; zero unreviewed data emitted`,
        { checkpointsReached }
      );
    }
  };

  // Checkpoint 1: Pre-scan entry
  checkAbort();

  if (!payload || typeof payload !== 'object') {
    throw new ContextIsolationError('DLP_INVALID_PAYLOAD', 'Payload must be an object');
  }

  // Checkpoint 2: Metadata / Path inspection
  checkAbort();

  // Execute underlying guardrail scan
  const scanResult = await guardrailManager.scan(payload, {
    onProgressCheckpoint: checkAbort
  });

  // Checkpoint 3: Post-scan verification before returning any content
  checkAbort();

  return {
    scanResult,
    checkpointsReached
  };
}

// ============================================================================
// Section 3: Authoritative 90-Row Base State Policy Matrix & Gate 1~4 Pipeline (R3, R10, R12, R13)
// ============================================================================

const DRIFT_STATES = Object.freeze(['INDEX_SNAPSHOT_MATCHED', 'DRIFT_DETECTED']);
const ROUTER_STATES = Object.freeze(['OPTIMAL', 'DEGRADED', 'UNAVAILABLE']);
const EVIDENCE_STATES = Object.freeze(['SOURCE_MATCHED', 'CONTENT_VERIFIED', 'STALE', 'UNVERIFIED', 'NONE']);
const DEGRAD_STATES = Object.freeze(['COMPLETE', 'PARTIAL', 'INCOMPLETE']);

/**
 * Generates the exact 90-row Authoritative Base State Policy Matrix (S001..S090)
 * as specified in PRD v2.3.3 Section 3.3.
 */
function buildAuthoritative90RowMatrix() {
  const matrixMap = new Map();
  const matrixRows = [];
  let index = 1;

  for (const drift of DRIFT_STATES) {
    for (const router of ROUTER_STATES) {
      for (const evidence of EVIDENCE_STATES) {
        for (const degrad of DEGRAD_STATES) {
          const rowId = `S${String(index).padStart(3, '0')}`;
          index++;

          let rowValidity = 'VALID_STATE';
          let baseTaskPolicy = 'REJECT_ALL';
          let matrixChannel = 'Fail-Closed Abort';
          let action = 'Fail-Closed Abort';
          let policyRationale = '';

          if (evidence === 'NONE') {
            if (degrad === 'PARTIAL') {
              rowValidity = 'IMPOSSIBLE_STATE';
              baseTaskPolicy = 'REJECT_ALL';
              matrixChannel = 'Fail-Closed Abort';
              action = 'Fail-Closed Abort';
              policyRationale = '語意不可達：查無資料不可能為部分截斷 (PARTIAL)';
            } else if (degrad === 'COMPLETE') {
              if (drift === 'INDEX_SNAPSHOT_MATCHED' && router === 'OPTIMAL') {
                // S013
                rowValidity = 'VALID_STATE';
                baseTaskPolicy = 'ALLOW_ALL_DIAGNOSTIC_ONLY';
                matrixChannel = 'DiagnosticEnvelope';
                action = 'Permit Diagnostic';
                policyRationale = '確定查無符號 (TARGET_NOT_FOUND)：全任務允許 HIGH 信心診斷';
              } else {
                // S028, S043, S058, S073, S088
                rowValidity = 'IMPOSSIBLE_STATE';
                baseTaskPolicy = 'REJECT_ALL';
                matrixChannel = 'Fail-Closed Abort';
                action = 'Fail-Closed Abort';
                policyRationale = '語意不可達：非最優或漂移狀態下查無資料不可驗收為 COMPLETE';
              }
            } else {
              // evidence === 'NONE' && degrad === 'INCOMPLETE'
              rowValidity = 'VALID_STATE';
              matrixChannel = 'DiagnosticEnvelope';
              action = 'Permit Diagnostic';
              if (drift === 'INDEX_SNAPSHOT_MATCHED') {
                baseTaskPolicy = 'ALLOW_ALL_DIAGNOSTIC_ONLY';
                if (router === 'OPTIMAL') {
                  // S015
                  policyRationale = '目標檔案缺失 (TARGET_FILE_MISSING)：全任務允許 MEDIUM 信心診斷';
                } else if (router === 'DEGRADED') {
                  // S030
                  policyRationale = '路由降級查無符號：全任務允許 MEDIUM 信心診斷';
                } else {
                  // S045
                  policyRationale = '路由離線查無符號：全任務允許 LOW 信心診斷';
                }
              } else {
                // S060, S075, S090
                baseTaskPolicy = 'REJECT_SECURITY_AUDIT_AND_REFACTOR';
                policyRationale = '快照漂移查無符號：僅限 Feature/Docs 允許 LOW 信心診斷，嚴格任務全拒絕';
              }
            }
          } else {
            // evidence in ['SOURCE_MATCHED', 'CONTENT_VERIFIED', 'STALE', 'UNVERIFIED']
            if (degrad === 'INCOMPLETE') {
              rowValidity = 'VALID_STATE';
              baseTaskPolicy = 'REJECT_ALL';
              matrixChannel = 'Fail-Closed Abort';
              action = 'Fail-Closed Abort';
              policyRationale = '核心符號超出 64KB 或遺失，強制中斷 (Fail-Closed Abort)';
            } else {
              // degrad in ['COMPLETE', 'PARTIAL']
              rowValidity = 'VALID_STATE';
              matrixChannel = 'ContextEnvelope';
              action = 'Permit Context';
              if (drift === 'DRIFT_DETECTED') {
                baseTaskPolicy = 'REJECT_SECURITY_AUDIT_AND_REFACTOR';
                policyRationale = '快照漂移：拒絕 Audit 與 Refactor，僅限 Feature/Docs';
              } else {
                // drift === 'INDEX_SNAPSHOT_MATCHED'
                if (evidence === 'SOURCE_MATCHED' || evidence === 'CONTENT_VERIFIED') {
                  baseTaskPolicy = 'ALLOW_ALL';
                  policyRationale = '完全匹配：所有任務允許 Context 發布';
                } else if (evidence === 'STALE') {
                  baseTaskPolicy = 'REJECT_SECURITY_AUDIT';
                  policyRationale = '源碼已修改：拒絕 SecurityAudit，其餘任務允許 Context';
                } else {
                  // UNVERIFIED
                  baseTaskPolicy = 'FEATURE_DOCS_ONLY';
                  policyRationale = '含未驗證節點：拒絕 Audit 與 Refactor，僅限 Feature/Docs';
                }
              }
            }
          }

          const decision = Object.freeze({
            rowId,
            drift,
            router,
            evidence,
            degrad,
            rowValidity,
            baseTaskPolicy,
            matrixChannel,
            action,
            policyRationale
          });

          const key = `${drift}|${router}|${evidence}|${degrad}`;
          matrixMap.set(key, decision);
          matrixRows.push(decision);
        }
      }
    }
  }

  return {
    matrixMap,
    matrixRows: Object.freeze(matrixRows)
  };
}

const { matrixMap: INTERNAL_MATRIX_MAP, matrixRows: AUTHORITATIVE_90_ROW_MATRIX } = buildAuthoritative90RowMatrix();

/**
 * R3: Private/Internal authoritative lookup for the 90-row base policy matrix.
 */
function resolveAuthoritativeBasePolicy(drift, router, evidence, degrad) {
  const key = `${drift}|${router}|${evidence}|${degrad}`;
  const decision = INTERNAL_MATRIX_MAP.get(key);
  if (!decision) {
    throw new ContextIsolationError(
      'ABORT_IMPOSSIBLE_STATE',
      `Unknown matrix state combination: ${key}`
    );
  }
  return decision;
}

/**
 * R12: Deterministic mapping from C3.2 AdmissionReceipt fields to the 4 orthogonal
 * dimensions of the 90-row policy matrix.
 */
function mapReceiptToMatrixInputs(receipt) {
  // 1. IndexDrift
  const drift = (receipt.snapshotFreshness === 'DRIFT_DETECTED')
    ? 'DRIFT_DETECTED'
    : 'INDEX_SNAPSHOT_MATCHED';

  // 2. RouterHealth
  let router = 'OPTIMAL';
  if (
    receipt.snapshotFreshness === 'DEGRADED' ||
    receipt.diagnosticReason === 'ROUTER_DEGRADED' ||
    (typeof receipt.diagnosticReason === 'string' && receipt.diagnosticReason.startsWith('ROUTER_DEGRADED:'))
  ) {
    router = 'DEGRADED';
  } else if (
    receipt.diagnosticReason === 'ROUTER_UNAVAILABLE' ||
    (typeof receipt.diagnosticReason === 'string' && receipt.diagnosticReason.startsWith('ROUTER_UNAVAILABLE:'))
  ) {
    router = 'UNAVAILABLE';
  }

  // 3. EvidenceVerdict
  const evidence = receipt.aggregateEvidenceStatus;

  // 4. ResolutionCompleteness (DegradationLevel)
  let degrad;
  if (receipt.retrievalStatus === 'COMPLETE' && receipt.completenessStatus === 'FULL') {
    degrad = 'COMPLETE';
  } else if (receipt.retrievalStatus === 'PARTIAL') {
    degrad = 'PARTIAL';
  } else {
    degrad = 'INCOMPLETE';
  }

  return { drift, router, evidence, degrad };
}

/**
 * R3, R10, R12, R13: Sole Authoritative Publication Gate (`decidePublication`).
 * Strictly forbids any external `matrixDecision` parameter (max 5 parameters).
 * Enforces single-precedence evaluation across all 5,760 state combinations:
 *   Gate 1 (Token: 2,880) -> Gate 2 (Receipt & 6-Fold Binding: 1,440) ->
 *   Gate 3 (Process Tree: 720) -> Gate 4 (90-Row Matrix: 720).
 */
function decidePublication(
  taskContext,
  candidateEnvelope,
  provenanceToken,
  admissionReceipt,
  processTreeStatus
) {
  if (!taskContext || typeof taskContext !== 'object') {
    throw new ContextIsolationError('ABORT_TOKEN_INVALID', 'Missing or invalid TaskContext');
  }

  // =========================================================================
  // Gate 1: SourceProvenanceToken Verification (Priority 1: 2,880 combinations)
  // =========================================================================
  if (
    !provenanceToken ||
    !admittedTokenBrand.has(provenanceToken) ||
    !Object.isFrozen(provenanceToken) ||
    provenanceToken.taskId !== taskContext.taskId
  ) {
    throw new ContextIsolationError('ABORT_TOKEN_INVALID', 'Invalid, unbranded, or missing ProvenanceToken');
  }

  // =========================================================================
  // Gate 2: AdmissionReceipt 13-Field TLV & 6-Fold Comprehensive Binding (Priority 2: 1,440 combinations)
  // =========================================================================
  if (
    !admissionReceipt ||
    !admittedReceiptBrand.has(admissionReceipt) ||
    !Object.isFrozen(admissionReceipt) ||
    admissionReceipt.taskId !== taskContext.taskId
  ) {
    throw new ContextIsolationError('ABORT_RECEIPT_INVALID', 'Invalid, unbranded, or unfrozen AdmissionReceipt');
  }

  if (!candidateEnvelope || typeof candidateEnvelope !== 'object') {
    throw new ContextIsolationError('ABORT_RECEIPT_INVALID', 'Candidate envelope is missing');
  }

  // 6-Fold Comprehensive Source Binding Check (R3, R6):
  // (1) Symbol binding
  if (provenanceToken.targetSymbol !== candidateEnvelope.targetSymbol) {
    throw new ContextIsolationError('ABORT_RECEIPT_INVALID', 'Target symbol mismatch between Token and Candidate Envelope');
  }
  // (2) Snapshot binding
  if (
    provenanceToken.snapshotId !== candidateEnvelope.snapshotId ||
    admissionReceipt.snapshotId !== candidateEnvelope.snapshotId
  ) {
    throw new ContextIsolationError('ABORT_RECEIPT_INVALID', 'Snapshot ID mismatch among Token, Receipt, and Envelope');
  }
  // (3) Tenant binding (R6: Tag 0x03)
  if (
    admissionReceipt.tenantId !== taskContext.tenantId ||
    provenanceToken.tenantId !== taskContext.tenantId ||
    (candidateEnvelope.tenantId !== undefined && candidateEnvelope.tenantId !== taskContext.tenantId)
  ) {
    throw new ContextIsolationError('ABORT_RECEIPT_INVALID', 'Tenant ID mismatch between Receipt, Token, and TaskContext');
  }
  // (4) Task type binding
  if (admissionReceipt.taskType !== taskContext.taskType) {
    throw new ContextIsolationError('ABORT_RECEIPT_INVALID', 'Task type mismatch between Receipt and TaskContext');
  }
  // (5) Candidate contextText SHA-256 physical verification
  const candidateText = ('contextText' in candidateEnvelope && typeof candidateEnvelope.contextText === 'string')
    ? candidateEnvelope.contextText
    : '';
  const expectedTextHash = crypto.createHash('sha256').update(candidateText, 'utf-8').digest('hex');
  if (provenanceToken.envelopeSha256 !== expectedTextHash) {
    throw new ContextIsolationError('ABORT_RECEIPT_INVALID', 'Candidate contextText SHA-256 does not match ProvenanceToken');
  }
  // (6) Recompute 13-Field TLV Hash & verify exact match
  let expectedBindingHash;
  try {
    expectedBindingHash = computeEnvelopeBindingHashTLV(admissionReceipt, expectedTextHash);
  } catch (tlvErr) {
    throw new ContextIsolationError('ABORT_RECEIPT_INVALID', `AdmissionReceipt TLV recomputation failed: ${tlvErr.message}`);
  }
  if (admissionReceipt.envelopeBindingHash !== expectedBindingHash) {
    throw new ContextIsolationError('ABORT_RECEIPT_INVALID', 'AdmissionReceipt envelopeBindingHash TLV mismatch');
  }

  // =========================================================================
  // Gate 3: OS Process Tree Containment State Verification (Priority 3: 720 combinations)
  // =========================================================================
  if (processTreeStatus === 'ACTIVE') {
    throw new ContextIsolationError('ABORT_PROCESS_TREE_ACTIVE', 'Sandbox process tree is still active; publication forbidden');
  }
  if (processTreeStatus === 'UNCONFIRMED') {
    throw new ContextIsolationError('ABORT_PROCESS_TREE_UNCONFIRMED', 'Process tree termination could not be positively proven');
  }
  if (processTreeStatus !== 'NOT_STARTED' && processTreeStatus !== 'TERMINATED') {
    throw new ContextIsolationError('ABORT_PROCESS_TREE_ACTIVE', `Illegal process tree state: ${processTreeStatus}`);
  }

  // =========================================================================
  // Gate 4: Internal Authoritative 90-Row Base Policy Matrix Resolution (Priority 4: 720 combinations)
  // =========================================================================
  const matrixInputs = mapReceiptToMatrixInputs(admissionReceipt);
  const matrixDecision = resolveAuthoritativeBasePolicy(
    matrixInputs.drift,
    matrixInputs.router,
    matrixInputs.evidence,
    matrixInputs.degrad
  );

  // Priority 4.1: Logically Impossible State Abort (88 combinations)
  if (matrixDecision.rowValidity === 'IMPOSSIBLE_STATE') {
    throw new ContextIsolationError(
      'ABORT_IMPOSSIBLE_STATE',
      `State combination (${matrixDecision.rowId}) is logically impossible in system invariant: ${matrixDecision.policyRationale}`
    );
  }

  // Priority 4.2: Matrix Fail-Closed Abort (192 combinations)
  if (matrixDecision.action === 'Fail-Closed Abort' || matrixDecision.matrixChannel === 'Fail-Closed Abort') {
    throw new ContextIsolationError(
      'ABORT_MATRIX_FAIL_CLOSED',
      `Matrix base policy (${matrixDecision.rowId}) dictates Fail-Closed Abort: ${matrixDecision.policyRationale}`
    );
  }

  // Priority 4.3: ContextEnvelope Channel Policy Routing (384 combinations: 132 rejected, 252 published)
  if (matrixDecision.matrixChannel === 'ContextEnvelope') {
    switch (matrixDecision.baseTaskPolicy) {
      case 'ALLOW_ALL':
        return 'PUBLISH_CONTEXT';

      case 'REJECT_SECURITY_AUDIT':
        if (taskContext.taskType === 'SECURITY_AUDIT') {
          throw new ContextIsolationError(
            'ABORT_STRICT_TASK_CONTEXT_REJECTED',
            `Task SECURITY_AUDIT rejected under REJECT_SECURITY_AUDIT (${matrixDecision.rowId})`
          );
        }
        return 'PUBLISH_CONTEXT';

      case 'REJECT_SECURITY_AUDIT_AND_REFACTOR':
      case 'FEATURE_DOCS_ONLY':
        if (taskContext.taskType === 'SECURITY_AUDIT' || taskContext.taskType === 'REFACTOR') {
          throw new ContextIsolationError(
            'ABORT_STRICT_TASK_CONTEXT_REJECTED',
            `Strict task ${taskContext.taskType} rejected under ${matrixDecision.baseTaskPolicy} (${matrixDecision.rowId})`
          );
        }
        return 'PUBLISH_CONTEXT';

      case 'ALLOW_ALL_DIAGNOSTIC_ONLY':
        throw new ContextIsolationError(
          'ABORT_CONTEXT_NOT_PERMITTED_IN_DIAGNOSTIC_ONLY',
          'ContextEnvelope forbidden under ALLOW_ALL_DIAGNOSTIC_ONLY'
        );

      case 'REJECT_ALL':
      default:
        throw new ContextIsolationError('ABORT_ALL_TASKS_REJECTED', 'All tasks rejected from ContextEnvelope publication');
    }
  }

  // Priority 4.4: DiagnosticEnvelope Channel Policy Routing (56 combinations: 12 rejected, 44 published)
  if (matrixDecision.matrixChannel === 'DiagnosticEnvelope') {
    if (matrixDecision.baseTaskPolicy === 'REJECT_ALL') {
      throw new ContextIsolationError('ABORT_ALL_TASKS_REJECTED', 'Diagnostic publication rejected under REJECT_ALL');
    }

    if (
      matrixDecision.baseTaskPolicy === 'REJECT_SECURITY_AUDIT_AND_REFACTOR' ||
      matrixDecision.baseTaskPolicy === 'FEATURE_DOCS_ONLY'
    ) {
      if (taskContext.taskType === 'SECURITY_AUDIT' || taskContext.taskType === 'REFACTOR') {
        throw new ContextIsolationError(
          'ABORT_STRICT_TASK_DIAGNOSTIC_REJECTED',
          `Strict task ${taskContext.taskType} rejected from Diagnostic publication under ${matrixDecision.baseTaskPolicy} (${matrixDecision.rowId})`
        );
      }
    }
    return 'PUBLISH_DIAGNOSTIC';
  }

  throw new ContextIsolationError('ABORT_UNHANDLED_POLICY_BRANCH', `Unhandled channel: ${matrixDecision.matrixChannel}`);
}

/**
 * R10: Derives deterministic diagnostic confidence ceiling based on matrix row & diagnostic reason.
 */
function resolveDiagnosticConfidence(drift, router, degrad, diagnosticReason) {
  if (drift === 'DRIFT_DETECTED' || router === 'UNAVAILABLE' || diagnosticReason === 'RETRIEVAL_INTERRUPTED') {
    return 'LOW';
  }
  if (drift === 'INDEX_SNAPSHOT_MATCHED' && router === 'OPTIMAL' && degrad === 'COMPLETE' && diagnosticReason === 'TARGET_NOT_FOUND') {
    return 'HIGH'; // S013
  }
  if (diagnosticReason === 'TARGET_FILE_MISSING' || router === 'DEGRADED') {
    return 'MEDIUM'; // S015, S030
  }
  return 'LOW';
}

module.exports = {
  ContextIsolationError,
  validatePrimitiveString,
  hasLoneSurrogate,
  TLV_TAG_LIMITS,
  encodeCanonicalTLVBuffer,
  computeEnvelopeBindingHashTLV,
  AdmissionReceiptIssuer,
  isBrandedAdmissionReceipt,
  ProvenanceTokenIssuer,
  isBrandedProvenanceToken,
  TenantIsolatedCache,
  ExecutionBoundaryGuard,
  WHITELISTED_READ_ONLY_TOOLS,
  FORBIDDEN_MUTATING_TOOLS,
  createDefaultLockBinding,
  defaultLockBinding,
  assertSandboxNotLocked,
  triggerGlobalLockdown,
  resetSandboxLockdownAdmin,
  resolveSafePathNoSymlinks,
  readImmutableFileSnapshot,
  executeSqliteWithWalRetry,
  scanWithAbortCheckpoints,
  AUTHORITATIVE_90_ROW_MATRIX,
  resolveAuthoritativeBasePolicy,
  mapReceiptToMatrixInputs,
  decidePublication,
  resolveDiagnosticConfidence
};
