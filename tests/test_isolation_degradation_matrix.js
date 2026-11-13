/**
 * Phase 1-C3.3 Isolation Boundary, 13-Field TLV Receipt, & 90-Row / 5,760-Combination Matrix Test Suite
 * Verifies C3.3-T1, T2, T3, T4, T5, T6, T10, T11, T14, and T15 according to PRD v2.3.3 (R1 ~ R13).
 *
 * Part of Agent OS Phase 1-C3.3.
 * Author: etrnya
 */
const assert = require('assert');
const crypto = require('crypto');

const {
  ContextIsolationError,
  encodeCanonicalTLVBuffer,
  computeEnvelopeBindingHashTLV,
  AdmissionReceiptIssuer,
  isBrandedAdmissionReceipt,
  ProvenanceTokenIssuer,
  isBrandedProvenanceToken,
  TenantIsolatedCache,
  ExecutionBoundaryGuard,
  executeSqliteWithWalRetry,
  scanWithAbortCheckpoints,
  AUTHORITATIVE_90_ROW_MATRIX,
  resolveAuthoritativeBasePolicy,
  mapReceiptToMatrixInputs,
  decidePublication,
  resolveDiagnosticConfidence
} = require('../services/isolation_boundary');

console.log('=== P1-C3.3 Isolation Boundary & 90-Row / 5,760-Combination Matrix Test Suite ===\n');

async function runTests() {
  let passed = 0;
  let failed = 0;

  function pass(testId, name) {
    passed++;
    console.log(`  ✓ PASS: [${testId}] ${name}`);
  }

  function fail(testId, name, err) {
    failed++;
    console.error(`  ✗ FAIL: [${testId}] ${name}`);
    console.error(err);
  }

  const dummyContextText = '<untrusted_code_context id="ev-01">const x = 1;</untrusted_code_context>';
  const dummyContextHash = crypto.createHash('sha256').update(dummyContextText, 'utf-8').digest('hex');
  const dummyEvalHash = 'a'.repeat(64);

  function createValidPureParams(overrides = {}) {
    return {
      schemaVersion: '1.0',
      taskId: 'task-001',
      tenantId: 'tenant-alpha',
      taskType: 'FEATURE_DEV',
      snapshotId: 'snap-20261109',
      snapshotFreshness: 'OPTIMAL',
      policyVersion: '2.3.3',
      aggregateEvidenceStatus: 'SOURCE_MATCHED',
      retrievalStatus: 'COMPLETE',
      completenessStatus: 'FULL',
      evaluatedItemsHash: dummyEvalHash,
      diagnosticReason: null,
      diagnosticConfidence: 'HIGH',
      ...overrides
    };
  }

  // -------------------------------------------------------------------------
  // C3.3-T1: PureAdmissionParams Ingestion & AdmissionReceiptIssuer Branding (R1, R4)
  // -------------------------------------------------------------------------
  try {
    // 1. Lone surrogate rejection
    let surrogateCaught = false;
    try {
      AdmissionReceiptIssuer.issueReceipt(
        createValidPureParams({ taskId: 'bad-\uD800-surrogate' }),
        dummyContextHash
      );
    } catch (e) {
      if (e.code === 'INVALID_UNICODE_SURROGATE') surrogateCaught = true;
    }
    assert.strictEqual(surrogateCaught, true, 'Must reject lone high surrogate with INVALID_UNICODE_SURROGATE');

    let lowSurrogateCaught = false;
    try {
      AdmissionReceiptIssuer.issueReceipt(
        createValidPureParams({ diagnosticReason: 'bad-\uDC00-low' }),
        dummyContextHash
      );
    } catch (e) {
      if (e.code === 'INVALID_UNICODE_SURROGATE') lowSurrogateCaught = true;
    }
    assert.strictEqual(lowSurrogateCaught, true, 'Must reject lone low surrogate with INVALID_UNICODE_SURROGATE');

    // 2. UTF-8 byte length overflow check (multi-byte UTF-8 characters: '測' is 3 bytes in UTF-8)
    let byteLenCaught = false;
    try {
      // 25 chars of '測' = 75 bytes > 64 bytes limit for tenantId (even though .length === 25 <= 64!)
      AdmissionReceiptIssuer.issueReceipt(
        createValidPureParams({ tenantId: '測'.repeat(25) }),
        dummyContextHash
      );
    } catch (e) {
      if (e.code === 'LENGTH_VALIDATION_FAILED') byteLenCaught = true;
    }
    assert.strictEqual(byteLenCaught, true, 'Must enforce UTF-8 Buffer.byteLength rather than UTF-16 string.length');

    // 3. Valid receipt issuance, null prototype, freeze, and private WeakSet branding
    const validReceipt = AdmissionReceiptIssuer.issueReceipt(createValidPureParams(), dummyContextHash);
    assert.strictEqual(Object.getPrototypeOf(validReceipt), null, 'Receipt must have null prototype');
    assert.strictEqual(Object.isFrozen(validReceipt), true, 'Receipt must be frozen');
    assert.strictEqual(isBrandedAdmissionReceipt(validReceipt), true, 'Receipt must carry private WeakSet brand');

    // Forged receipt cloned externally must fail brand verification
    const forgedReceipt = Object.freeze(Object.assign(Object.create(null), validReceipt));
    assert.strictEqual(isBrandedAdmissionReceipt(forgedReceipt), false, 'Externally constructed clone must not pass brand check');

    pass('C3.3-T1', 'PureAdmissionParams ingestion, UTF-8 byte length, surrogate rejection, and WeakSet brand verified');
  } catch (err) {
    fail('C3.3-T1', 'PureAdmissionParams & AdmissionReceiptIssuer verification', err);
  }

  // -------------------------------------------------------------------------
  // C3.3-T2: Tenant Boundary & 13-Field TLV Cache Key Isolation (R6)
  // -------------------------------------------------------------------------
  try {
    const paramsTenantA = createValidPureParams({ tenantId: 'tenant-alpha' });
    const paramsTenantB = createValidPureParams({ tenantId: 'tenant-beta' });

    const tlvA = encodeCanonicalTLVBuffer(paramsTenantA);
    const tlvB = encodeCanonicalTLVBuffer(paramsTenantB);
    assert.strictEqual(tlvA.equals(tlvB), false, 'Different tenantId must produce distinct TLV binary stream');

    const receiptA = AdmissionReceiptIssuer.issueReceipt(paramsTenantA, dummyContextHash);
    const receiptB = AdmissionReceiptIssuer.issueReceipt(paramsTenantB, dummyContextHash);
    assert.notStrictEqual(
      receiptA.envelopeBindingHash,
      receiptB.envelopeBindingHash,
      'Different tenantId must produce distinct envelopeBindingHash'
    );

    // Verify TenantIsolatedCache isolation
    const cache = new TenantIsolatedCache();
    cache.set(
      { tenantId: 'tenant-alpha', snapshotId: 'snap-1', targetSymbol: 'OrderService', taskType: 'FEATURE_DEV' },
      { secret: 'alpha-only-data' }
    );

    const hitAlpha = cache.get({
      tenantId: 'tenant-alpha',
      snapshotId: 'snap-1',
      targetSymbol: 'OrderService',
      taskType: 'FEATURE_DEV'
    });
    const missBeta = cache.get({
      tenantId: 'tenant-beta',
      snapshotId: 'snap-1',
      targetSymbol: 'OrderService',
      taskType: 'FEATURE_DEV'
    });

    assert.deepStrictEqual(hitAlpha, { secret: 'alpha-only-data' });
    assert.strictEqual(missBeta, null, 'Tenant Beta must never hit Tenant Alpha cache entry');

    pass('C3.3-T2', '13-Field TLV Tag 0x03 tenantId produces distinct binary streams, hashes, and isolated cache keys');
  } catch (err) {
    fail('C3.3-T2', 'Tenant boundary & 13-Field TLV isolation', err);
  }

  // -------------------------------------------------------------------------
  // C3.3-T3: Monotonic Clock Skew Detection & Immediate Cache Purge
  // -------------------------------------------------------------------------
  try {
    let currentClockNs = 1000000000n;
    const skewCache = new TenantIsolatedCache({
      monotonicClockFn: () => currentClockNs
    });

    skewCache.set(
      { tenantId: 'tenant-alpha', snapshotId: 'snap-1', targetSymbol: 'SymA', taskType: 'FEATURE_DEV' },
      'cached-payload'
    );
    assert.strictEqual(skewCache.cacheStore.size, 1);

    // Advance clock normally
    currentClockNs = 2000000000n;
    assert.strictEqual(
      skewCache.get({ tenantId: 'tenant-alpha', snapshotId: 'snap-1', targetSymbol: 'SymA', taskType: 'FEATURE_DEV' }),
      'cached-payload'
    );

    // Simulate monotonic clock rollback
    currentClockNs = 1500000000n;
    let skewCaught = false;
    try {
      skewCache.get({ tenantId: 'tenant-alpha', snapshotId: 'snap-1', targetSymbol: 'SymA', taskType: 'FEATURE_DEV' });
    } catch (e) {
      if (e.code === 'MONOTONIC_CLOCK_SKEW_DETECTED') skewCaught = true;
    }

    assert.strictEqual(skewCaught, true, 'Must throw MONOTONIC_CLOCK_SKEW_DETECTED on clock rollback');
    assert.strictEqual(skewCache.cacheStore.size, 0, 'Must immediately purge all cache entries on clock skew');

    pass('C3.3-T3', 'Monotonic clock rollback immediately clears cacheStore (size === 0) and throws MONOTONIC_CLOCK_SKEW_DETECTED');
  } catch (err) {
    fail('C3.3-T3', 'Monotonic clock skew disposal', err);
  }

  // -------------------------------------------------------------------------
  // C3.3-T4: 13-Field TLV Per-Tag Byte Ceilings & Unicode NFC Normalization (R7)
  // -------------------------------------------------------------------------
  try {
    // 1. Tag 0x01 schemaVersion > 16B (17 bytes)
    let tag01Caught = false;
    try {
      encodeCanonicalTLVBuffer(createValidPureParams({ schemaVersion: '1'.repeat(17) }));
    } catch (e) {
      if (e.code === 'TLV_FIELD_SIZE_EXCEEDED') tag01Caught = true;
    }
    assert.strictEqual(tag01Caught, true, 'Tag 0x01 (17B > 16B) must throw TLV_FIELD_SIZE_EXCEEDED');

    // 2. Tag 0x0C diagnosticReason > 2048B (2049 bytes)
    let tag0cCaught = false;
    try {
      encodeCanonicalTLVBuffer(createValidPureParams({ diagnosticReason: 'x'.repeat(2049) }));
    } catch (e) {
      if (e.code === 'TLV_FIELD_SIZE_EXCEEDED') tag0cCaught = true;
    }
    assert.strictEqual(tag0cCaught, true, 'Tag 0x0C (2049B > 2048B) must throw TLV_FIELD_SIZE_EXCEEDED');

    // 3. Unicode NFC Normalization equivalence: NFD ('e\u0301') vs NFC ('\u00e9')
    const nfdParams = createValidPureParams({ taskId: 'task-cafe\u0301' });
    const nfcParams = createValidPureParams({ taskId: 'task-caf\u00e9' });
    const hashFromNfd = computeEnvelopeBindingHashTLV(nfdParams, dummyContextHash);
    const hashFromNfc = computeEnvelopeBindingHashTLV(nfcParams, dummyContextHash);
    assert.strictEqual(hashFromNfd, hashFromNfc, 'NFD and NFC equivalent strings must yield identical TLV hash');

    pass('C3.3-T4', 'Per-tag UTF-8 byte ceilings (TLV_FIELD_SIZE_EXCEEDED) and Unicode NFC canonical hashing verified');
  } catch (err) {
    fail('C3.3-T4', '13-Field TLV limits & Unicode NFC', err);
  }

  // -------------------------------------------------------------------------
  // C3.3-T5 & C3.3-T6: Execution Boundary Tool Whitelist & Read-Only Flag
  // -------------------------------------------------------------------------
  try {
    const boundaryGuard = new ExecutionBoundaryGuard();
    assert.strictEqual(boundaryGuard.allowExecution, false);

    // Attempt to mutate allowExecution must fail
    try {
      boundaryGuard.allowExecution = true;
    } catch (_) {
      // Ignore strict mode TypeError
    }
    assert.strictEqual(boundaryGuard.allowExecution, false, 'allowExecution must remain strictly false');

    // Whitelisted read-only tools pass
    assert.strictEqual(boundaryGuard.authorizeToolCall('read_file'), true);
    assert.strictEqual(boundaryGuard.authorizeToolCall('codegraph_search'), true);

    // Mutating tools throw TOOL_EXECUTION_FORBIDDEN (C3.3-T5)
    for (const forbiddenTool of ['write_file', 'edit_file', 'run_command']) {
      let caught = false;
      try {
        boundaryGuard.authorizeToolCall(forbiddenTool);
      } catch (e) {
        if (e.code === 'TOOL_EXECUTION_FORBIDDEN') caught = true;
      }
      assert.strictEqual(caught, true, `Tool ${forbiddenTool} must throw TOOL_EXECUTION_FORBIDDEN`);
    }

    // Non-read-only IPC request blocked (C3.3-T6)
    let ipcBlocked = false;
    try {
      boundaryGuard.authorizeIpcRequest({ mode: 'READ_WRITE', toolName: 'read_file' });
    } catch (e) {
      if (e.code === 'TOOL_EXECUTION_FORBIDDEN') ipcBlocked = true;
    }
    assert.strictEqual(ipcBlocked, true, 'Non-READ_ONLY IPC request must be blocked');
    assert.strictEqual(boundaryGuard.authorizeIpcRequest({ mode: 'READ_ONLY', toolName: 'read_file' }), true);

    pass('C3.3-T5 & C3.3-T6', 'Tool whitelist blocks write_file/edit_file/run_command and enforces allowExecution: false');
  } catch (err) {
    fail('C3.3-T5 & C3.3-T6', 'Execution boundary guard', err);
  }

  // -------------------------------------------------------------------------
  // C3.3-T10: SQLite WAL 3-Retry Cap & Plan B Degradation
  // -------------------------------------------------------------------------
  try {
    let queryCallCount = 0;
    const busyQueryFn = async () => {
      queryCallCount++;
      const err = new Error('SQLITE_BUSY: database is locked');
      err.code = 'SQLITE_BUSY';
      throw err;
    };

    const fallbackFn = async () => ({ fallbackSource: 'MEMORY_SNAPSHOT_PLAN_B' });

    const walRes = await executeSqliteWithWalRetry(busyQueryFn, fallbackFn, { baseDelayMs: 2 });
    assert.strictEqual(queryCallCount, 3, 'Must execute exactly 3 attempts and never a 4th query');
    assert.strictEqual(walRes.attempts, 3);
    assert.strictEqual(walRes.routerHealth, 'DEGRADED', 'Must transition RouterHealth to DEGRADED');
    assert.strictEqual(walRes.degradedToPlanB, true);
    assert.deepStrictEqual(walRes.data, { fallbackSource: 'MEMORY_SNAPSHOT_PLAN_B' });

    pass('C3.3-T10', 'SQLite WAL lock retries exactly 3 times (zero 4th call) and degrades cleanly to Plan B');
  } catch (err) {
    fail('C3.3-T10', 'SQLite WAL 3-retry & Plan B degradation', err);
  }

  // -------------------------------------------------------------------------
  // C3.3-T11: Snapshot Drift Strict Task Abort & Diagnostic Confidence Split (R10)
  // -------------------------------------------------------------------------
  try {
    // 1. S013: INDEX_SNAPSHOT_MATCHED + OPTIMAL + NONE + COMPLETE -> TARGET_NOT_FOUND (HIGH confidence)
    assert.strictEqual(
      resolveDiagnosticConfidence('INDEX_SNAPSHOT_MATCHED', 'OPTIMAL', 'COMPLETE', 'TARGET_NOT_FOUND'),
      'HIGH'
    );
    // 2. S015: INDEX_SNAPSHOT_MATCHED + OPTIMAL + NONE + INCOMPLETE -> TARGET_FILE_MISSING (MEDIUM confidence)
    assert.strictEqual(
      resolveDiagnosticConfidence('INDEX_SNAPSHOT_MATCHED', 'OPTIMAL', 'INCOMPLETE', 'TARGET_FILE_MISSING'),
      'MEDIUM'
    );
    // 3. RETRIEVAL_INTERRUPTED or DRIFT_DETECTED -> LOW confidence
    assert.strictEqual(
      resolveDiagnosticConfidence('INDEX_SNAPSHOT_MATCHED', 'OPTIMAL', 'INCOMPLETE', 'RETRIEVAL_INTERRUPTED'),
      'LOW'
    );
    assert.strictEqual(
      resolveDiagnosticConfidence('DRIFT_DETECTED', 'OPTIMAL', 'INCOMPLETE', 'TARGET_FILE_MISSING'),
      'LOW'
    );

    // Verify DRIFT_DETECTED behavior in decidePublication (S060):
    // Strict task (SECURITY_AUDIT) -> throws ABORT_STRICT_TASK_DIAGNOSTIC_REJECTED
    // General task (FEATURE_DEV) -> returns PUBLISH_DIAGNOSTIC (LOW confidence)
    const emptyTextHash = crypto.createHash('sha256').update('', 'utf-8').digest('hex');

    for (const taskType of ['SECURITY_AUDIT', 'REFACTOR', 'FEATURE_DEV', 'DOCS_UPDATE']) {
      const taskCtx = { taskId: 't-drift', tenantId: 'ten-1', taskType };
      const receipt = AdmissionReceiptIssuer.issueReceipt(
        createValidPureParams({
          taskId: 't-drift',
          tenantId: 'ten-1',
          taskType,
          snapshotId: 'snap-drift',
          snapshotFreshness: 'DRIFT_DETECTED',
          aggregateEvidenceStatus: 'NONE',
          retrievalStatus: 'INCOMPLETE',
          completenessStatus: 'TRUNCATED',
          diagnosticReason: 'RETRIEVAL_INTERRUPTED',
          diagnosticConfidence: 'LOW'
        }),
        emptyTextHash
      );
      const token = ProvenanceTokenIssuer.issueToken({
        targetSymbol: 'DriftSym',
        taskId: 't-drift',
        tenantId: 'ten-1',
        snapshotId: 'snap-drift',
        source: 'DIAGNOSTIC_SYNTHESIS',
        envelopeSha256: emptyTextHash
      });
      const diagEnv = {
        targetSymbol: 'DriftSym',
        snapshotId: 'snap-drift',
        tenantId: 'ten-1',
        diagnosticConfidence: 'LOW',
        diagnosticReason: 'RETRIEVAL_INTERRUPTED'
      };

      if (taskType === 'SECURITY_AUDIT' || taskType === 'REFACTOR') {
        assert.throws(
          () => decidePublication(taskCtx, diagEnv, token, receipt, 'TERMINATED'),
          (err) => err.code === 'ABORT_STRICT_TASK_DIAGNOSTIC_REJECTED'
        );
      } else {
        const res = decidePublication(taskCtx, diagEnv, token, receipt, 'TERMINATED');
        assert.strictEqual(res, 'PUBLISH_DIAGNOSTIC');
      }
    }

    pass('C3.3-T11', 'Snapshot drift aborts strict tasks and degrades general tasks to LOW confidence DiagnosticEnvelope (R10 split verified)');
  } catch (err) {
    fail('C3.3-T11', 'Snapshot drift & R10 diagnostic confidence split', err);
  }

  // -------------------------------------------------------------------------
  // C3.3-T14: DLP Cooperative Abort Checkpoints (<= 3 checkpoints)
  // -------------------------------------------------------------------------
  try {
    const abortController = { aborted: false };
    let scanInvoked = false;
    const mockGuardrail = {
      async scan(payload, opts) {
        scanInvoked = true;
        // Trigger abort right before progress checkpoint inside scan
        abortController.aborted = true;
        if (opts && typeof opts.onProgressCheckpoint === 'function') {
          opts.onProgressCheckpoint();
        }
        return { safe: true, reason: 'Clean', sanitizedPayload: payload };
      }
    };

    let caughtAbort = null;
    try {
      await scanWithAbortCheckpoints(mockGuardrail, { snippet: 'sensitive_unreviewed_code' }, abortController);
    } catch (e) {
      caughtAbort = e;
    }

    assert.ok(caughtAbort, 'Must throw when abortSignal is triggered during DLP scan');
    assert.strictEqual(caughtAbort.code, 'DLP_ABORTED_BY_SIGNAL');
    assert.strictEqual(scanInvoked, true);
    assert.ok(
      caughtAbort.details.checkpointsReached <= 3,
      `Must halt within <= 3 checkpoints, reached ${caughtAbort.details.checkpointsReached}`
    );

    pass('C3.3-T14', 'DLP cooperative abort halts within <= 3 checkpoints without leaking unreviewed data');
  } catch (err) {
    fail('C3.3-T14', 'DLP cooperative abort checkpoints', err);
  }

  // -------------------------------------------------------------------------
  // C3.3-T15: 90-Row Authoritative Matrix & 5,760-Combination Single-Precedence Verification (R3, R12, R13)
  // -------------------------------------------------------------------------
  try {
    // 1. Verify 90-Row Matrix completeness and exact row count
    assert.strictEqual(AUTHORITATIVE_90_ROW_MATRIX.length, 90, 'Matrix must have exactly 90 orthogonal rows');
    assert.strictEqual(decidePublication.length, 5, 'decidePublication must accept exactly 5 arguments (zero external matrixDecision)');

    // 2. Helper to construct PureAdmissionParams that deterministically maps to any of the 90 matrix rows
    function buildParamsForRow(row, taskType, taskId = 'task-5760', tenantId = 'tenant-5760', snapshotId = 'snap-5760') {
      let snapshotFreshness = 'OPTIMAL';
      let diagnosticReason = null;

      if (row.drift === 'DRIFT_DETECTED') {
        snapshotFreshness = 'DRIFT_DETECTED';
        if (row.router === 'DEGRADED') {
          diagnosticReason = 'ROUTER_DEGRADED';
        } else if (row.router === 'UNAVAILABLE') {
          diagnosticReason = 'ROUTER_UNAVAILABLE';
        } else if (row.evidence === 'NONE') {
          diagnosticReason = 'RETRIEVAL_INTERRUPTED';
        }
      } else {
        // INDEX_SNAPSHOT_MATCHED
        if (row.router === 'DEGRADED') {
          snapshotFreshness = 'DEGRADED';
          if (row.evidence === 'NONE') diagnosticReason = 'ROUTER_DEGRADED';
        } else if (row.router === 'UNAVAILABLE') {
          snapshotFreshness = 'OPTIMAL';
          diagnosticReason = 'ROUTER_UNAVAILABLE';
        } else if (row.evidence === 'NONE') {
          diagnosticReason = row.degrad === 'COMPLETE' ? 'TARGET_NOT_FOUND' : 'TARGET_FILE_MISSING';
        }
      }

      let retrievalStatus = 'COMPLETE';
      let completenessStatus = 'FULL';
      if (row.degrad === 'PARTIAL') {
        retrievalStatus = 'PARTIAL';
        completenessStatus = 'TRUNCATED';
      } else if (row.degrad === 'INCOMPLETE') {
        retrievalStatus = 'INCOMPLETE';
        completenessStatus = 'TRUNCATED';
      }

      return createValidPureParams({
        taskId,
        tenantId,
        taskType,
        snapshotId,
        snapshotFreshness,
        aggregateEvidenceStatus: row.evidence,
        retrievalStatus,
        completenessStatus,
        diagnosticReason,
        diagnosticConfidence: row.evidence === 'NONE' ? 'MEDIUM' : 'HIGH'
      });
    }

    // Verify all 90 rows round-trip through mapReceiptToMatrixInputs & resolveAuthoritativeBasePolicy
    for (const row of AUTHORITATIVE_90_ROW_MATRIX) {
      const p = buildParamsForRow(row, 'FEATURE_DEV');
      const r = AdmissionReceiptIssuer.issueReceipt(p, dummyContextHash);
      const mapped = mapReceiptToMatrixInputs(r);
      assert.strictEqual(mapped.drift, row.drift, `Row ${row.rowId} drift mapping mismatch`);
      assert.strictEqual(mapped.router, row.router, `Row ${row.rowId} router mapping mismatch`);
      assert.strictEqual(mapped.evidence, row.evidence, `Row ${row.rowId} evidence mapping mismatch`);
      assert.strictEqual(mapped.degrad, row.degrad, `Row ${row.rowId} degrad mapping mismatch`);
      const resolved = resolveAuthoritativeBasePolicy(mapped.drift, mapped.router, mapped.evidence, mapped.degrad);
      assert.strictEqual(resolved.rowId, row.rowId);
    }

    // 3. Exhaustive 5,760-Combination Cartesian Product Verification
    // Dimensions: Token(2) x Receipt(2) x Process(4) x Matrix(90) x TaskType(4) = 5,760
    const tokenStates = ['VALID', 'INVALID'];
    const receiptStates = ['VALID', 'INVALID'];
    const processStates = ['NOT_STARTED', 'TERMINATED', 'ACTIVE', 'UNCONFIRMED'];
    const taskTypes = ['SECURITY_AUDIT', 'REFACTOR', 'FEATURE_DEV', 'DOCS_UPDATE'];

    const counters = {
      total: 0,
      gate1TokenBlocked: 0,
      gate2ReceiptBlocked: 0,
      gate3ProcessBlocked: 0,
      gate4ImpossibleState: 0,
      gate4MatrixFailClosed: 0,
      gate4StrictContextRejected: 0,
      gate4StrictDiagnosticRejected: 0,
      gate4PublishContext: 0,
      gate4PublishDiagnostic: 0
    };

    const validEnvelope = {
      targetSymbol: 'OrderService::calculateTotal',
      snapshotId: 'snap-5760',
      tenantId: 'tenant-5760',
      contextText: dummyContextText
    };

    const validToken = ProvenanceTokenIssuer.issueToken({
      targetSymbol: 'OrderService::calculateTotal',
      taskId: 'task-5760',
      tenantId: 'tenant-5760',
      snapshotId: 'snap-5760',
      envelopeSha256: dummyContextHash
    });

    // Unbranded forged token for INVALID token state
    const invalidToken = Object.freeze({ ...validToken });

    // Pre-issue valid receipts for each (rowId, taskType) pair (90 * 4 = 360 receipts)
    const validReceiptsMap = new Map();
    for (const row of AUTHORITATIVE_90_ROW_MATRIX) {
      for (const taskType of taskTypes) {
        const params = buildParamsForRow(row, taskType);
        const receipt = AdmissionReceiptIssuer.issueReceipt(params, dummyContextHash);
        validReceiptsMap.set(`${row.rowId}|${taskType}`, receipt);
      }
    }

    for (const tokenState of tokenStates) {
      for (const receiptState of receiptStates) {
        for (const procState of processStates) {
          for (const row of AUTHORITATIVE_90_ROW_MATRIX) {
            for (const taskType of taskTypes) {
              counters.total++;

              const taskContext = {
                taskId: 'task-5760',
                tenantId: 'tenant-5760',
                taskType
              };

              const tokenArg = tokenState === 'VALID' ? validToken : invalidToken;
              const validRec = validReceiptsMap.get(`${row.rowId}|${taskType}`);
              // For INVALID receipt state, pass an unbranded clone
              const receiptArg = receiptState === 'VALID' ? validRec : Object.freeze({ ...validRec });

              try {
                const outcome = decidePublication(
                  taskContext,
                  validEnvelope,
                  tokenArg,
                  receiptArg,
                  procState
                );
                if (outcome === 'PUBLISH_CONTEXT') {
                  counters.gate4PublishContext++;
                } else if (outcome === 'PUBLISH_DIAGNOSTIC') {
                  counters.gate4PublishDiagnostic++;
                } else {
                  throw new Error(`Unexpected return outcome: ${outcome}`);
                }
              } catch (err) {
                if (!(err instanceof ContextIsolationError)) {
                  throw err;
                }
                switch (err.code) {
                  case 'ABORT_TOKEN_INVALID':
                    counters.gate1TokenBlocked++;
                    break;
                  case 'ABORT_RECEIPT_INVALID':
                    counters.gate2ReceiptBlocked++;
                    break;
                  case 'ABORT_PROCESS_TREE_ACTIVE':
                  case 'ABORT_PROCESS_TREE_UNCONFIRMED':
                    counters.gate3ProcessBlocked++;
                    break;
                  case 'ABORT_IMPOSSIBLE_STATE':
                    counters.gate4ImpossibleState++;
                    break;
                  case 'ABORT_MATRIX_FAIL_CLOSED':
                    counters.gate4MatrixFailClosed++;
                    break;
                  case 'ABORT_STRICT_TASK_CONTEXT_REJECTED':
                    counters.gate4StrictContextRejected++;
                    break;
                  case 'ABORT_STRICT_TASK_DIAGNOSTIC_REJECTED':
                    counters.gate4StrictDiagnosticRejected++;
                    break;
                  default:
                    throw new Error(`Unexpected ContextIsolationError code: ${err.code}`);
                }
              }
            }
          }
        }
      }
    }

    // Assert exact arithmetic decomposition from PRD v2.3.3 R13 & C3.3-T15:
    // Total = 5,760: Gate 1 (2,880) -> Gate 2 (1,440) -> Gate 3 (720) -> Gate 4 (720: 88 + 192 + 132 + 12 + 252 + 44)
    assert.strictEqual(counters.total, 5760, 'Total Cartesian combinations must be 5,760');
    assert.strictEqual(counters.gate1TokenBlocked, 2880, 'Gate 1 must block exactly 2,880 combinations');
    assert.strictEqual(counters.gate2ReceiptBlocked, 1440, 'Gate 2 must block exactly 1,440 combinations');
    assert.strictEqual(counters.gate3ProcessBlocked, 720, 'Gate 3 must block exactly 720 combinations');
    assert.strictEqual(counters.gate4ImpossibleState, 88, 'Gate 4.1 must block 88 IMPOSSIBLE_STATE combinations');
    assert.strictEqual(counters.gate4MatrixFailClosed, 192, 'Gate 4.2 must block 192 MATRIX_FAIL_CLOSED combinations');
    assert.strictEqual(counters.gate4StrictContextRejected, 132, 'Gate 4.3 must reject 132 strict context combinations');
    assert.strictEqual(counters.gate4StrictDiagnosticRejected, 12, 'Gate 4.4 must reject 12 strict diagnostic combinations');
    assert.strictEqual(counters.gate4PublishContext, 252, 'Gate 4.3 must permit 252 PUBLISH_CONTEXT combinations');
    assert.strictEqual(counters.gate4PublishDiagnostic, 44, 'Gate 4.4 must permit 44 PUBLISH_DIAGNOSTIC combinations');

    const gate4Sum =
      counters.gate4ImpossibleState +
      counters.gate4MatrixFailClosed +
      counters.gate4StrictContextRejected +
      counters.gate4StrictDiagnosticRejected +
      counters.gate4PublishContext +
      counters.gate4PublishDiagnostic;
    assert.strictEqual(gate4Sum, 720, 'Gate 4 sub-totals must sum to 720');

    pass(
      'C3.3-T15',
      '90-Row Matrix & 5,760-Combination Single-Precedence verified (2880 + 1440 + 720 + [88+192+132+12+252+44] = 5760)'
    );
  } catch (err) {
    fail('C3.3-T15', '90-Row Matrix & 5,760-combination verification', err);
  }

  console.log('\n======================================================');
  console.log(`P1-C3.3 Matrix Test Suite Complete: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal Test Suite Error:', err);
  process.exit(1);
});

