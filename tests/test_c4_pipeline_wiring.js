/**
 * Phase 1-C4 Main Pipeline Wiring Integration Tests
 * Verifies CascadingExecutor.compileCodeGraphContext integration across
 * RoleAwareContextPlanner -> EvidenceAdmissionEngine -> ContextCompiler -> IsolationBoundary.
 */
const assert = require('assert');
const path = require('path');
const cascadingExecutor = require('../services/cascading_executor');
const roleManager = require('../services/role_manager');
const taskManagerModule = require('../services/task_manager');
const verificationGate = require('../services/verification_gate');
const GlobalState = require('../shared/global_state');

async function run() {
  console.log('=== Phase 1-C4 Pipeline Wiring Test Suite ===\n');
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}\n    ${err.stack || err.message}`);
      failed++;
    }
  }

  const workspaceRoot = path.resolve(__dirname, '..');
  const mockAdapter = {
    projectPath: workspaceRoot,
    async resolveAndValidatePath(relPath) {
      const full = path.resolve(workspaceRoot, relPath);
      if (!full.startsWith(workspaceRoot)) {
        throw new Error('Path traversal denied');
      }
      return full;
    },
    async getStatus() {
      return { snapshotId: 'snap-c4-test', lastSyncedAt: '2026-11-13T00:00:00Z' };
    },
    async getFileIndexSnapshot() {
      return null;
    }
  };

  await test('[C4-T1] Returns null cleanly when no CodeGraph targets are provided', async () => {
    const res = await cascadingExecutor.compileCodeGraphContext({ objective: 'Explain SOLID principles' });
    assert.strictEqual(res, null);
  });

  await test('[C4-T2] Compiles real workspace file via RoleAwareContextPlanner -> EvidenceAdmissionEngine -> ContextCompiler', async () => {
    const res = await cascadingExecutor.compileCodeGraphContext(
      {
        objective: 'Inspect TokenBudgetGuard',
        action: 'BUG_FIX',
        targetFiles: ['services/token_budget_guard.js'],
        targetSymbols: ['TokenBudgetGuard']
      },
      { workspaceRoot, codeGraphAdapter: mockAdapter }
    );
    assert.ok(res && typeof res.contextText === 'string' && res.contextText.length > 0, 'Expected non-empty contextText');
    assert.ok(res.contextText.includes('TokenBudgetGuard'), 'Expected compiled XML to contain target symbol');
    assert.ok(res.metadata && res.metadata.snapshotId === 'snap-c4-test', 'Expected snapshotId metadata');
  });

  await test('[C4-T3] Isolated envelope mode issues AdmissionReceipt and ProvenanceToken for valid tenant', async () => {
    const res = await cascadingExecutor.compileCodeGraphContext(
      {
        objective: 'Audit TokenBudgetGuard',
        taskId: 'task-c4-t3',
        tenantId: 'tenant-alpha',
        taskType: 'FEATURE_DEV',
        action: 'FEATURE',
        targetFiles: ['services/token_budget_guard.js'],
        targetSymbols: ['TokenBudgetGuard']
      },
      { workspaceRoot, codeGraphAdapter: mockAdapter, isolatedEnvelope: true }
    );
    assert.ok(res && res.contextText.includes('TokenBudgetGuard'), 'Expected compiled contextText');
    assert.ok(res.metadata && res.metadata.admissionReceipt, 'Expected admissionReceipt');
    assert.ok(res.metadata && res.metadata.provenanceToken, 'Expected provenanceToken');
    assert.ok(res.metadata && res.metadata.decision, 'Expected policy matrix decision');
  });

  await test('[C4-T4] Isolated envelope mode fails closed on DRIFT_DETECTED for SECURITY_AUDIT', async () => {
    let threw = false;
    try {
      await cascadingExecutor.compileCodeGraphContext(
        {
          objective: 'Security audit on drifted snapshot',
          taskId: 'task-c4-t4',
          tenantId: 'tenant-alpha',
          taskType: 'SECURITY_AUDIT',
          action: 'SECURITY_AUDIT',
          targetFiles: ['services/token_budget_guard.js'],
          targetSymbols: ['TokenBudgetGuard']
        },
        {
          workspaceRoot,
          codeGraphAdapter: mockAdapter,
          isolatedEnvelope: true,
          snapshotFreshness: 'DRIFT_DETECTED',
          aggregateEvidenceStatus: 'SOURCE_MATCHED'
        }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.name, 'ContextIsolationError', `Expected ContextIsolationError, got: ${err.name}`);
      assert.ok(err.message.includes('ABORT_STRICT_TASK_CONTEXT_REJECTED'), `Expected ABORT_STRICT_TASK_CONTEXT_REJECTED, got: ${err.message}`);
    }
    assert.strictEqual(threw, true, 'Expected Fail-Closed throw on DRIFT_DETECTED for SECURITY_AUDIT');
  });

  await test('[C4-T5] RoleManager.buildTask and GlobalState preserve structured CodeGraph & Tenant parameters', async () => {
    const built = roleManager.buildTask('code_reviewer', {
      objective: 'Review TokenBudgetGuard implementation',
      action: 'BUG_FIX',
      targetFiles: ['services/token_budget_guard.js'],
      targetSymbols: ['TokenBudgetGuard'],
      tenantId: 'tenant-beta',
      taskType: 'BUG_FIX',
      maxExecutionTokens: 2500
    });

    assert.strictEqual(built.taskPayload.roleId, 'code_reviewer');
    assert.strictEqual(built.taskPayload.action, 'BUG_FIX');
    assert.deepStrictEqual(built.taskPayload.targetFiles, ['services/token_budget_guard.js']);
    assert.deepStrictEqual(built.taskPayload.targetSymbols, ['TokenBudgetGuard']);
    assert.strictEqual(built.taskPayload.tenantId, 'tenant-beta');
    assert.strictEqual(built.taskPayload.maxExecutionTokens, 2500);

    // Verify GlobalState pure data validation accepts the enriched payload
    const gs = new GlobalState(built.taskPayload);
    const snap = gs.getSnapshot();
    assert.strictEqual(snap.roleId, 'code_reviewer');
    assert.deepStrictEqual(snap.targetFiles, ['services/token_budget_guard.js']);

    // Verify invalid action is rejected with INVALID_PARAMETER
    assert.throws(() => {
      roleManager.buildTask('code_reviewer', {
        objective: 'Invalid action test',
        action: 'UNKNOWN_ACTION'
      });
    }, /INVALID_PARAMETER: Invalid action/);
  });

  await test('[C4-T6] CallGraphEngine topology expansion discovers callers/callees and attaches BlastRadius metadata', async () => {
    const graphAdapter = {
      ...mockAdapter,
      validateSymbol(s) {
        return String(s).trim();
      },
      async querySymbols(sym) {
        return [{
          id: 'node-1',
          name: sym,
          qualifiedName: sym,
          kind: 'class',
          filePath: 'services/token_budget_guard.js',
          language: 'javascript',
          startLine: 1,
          endLine: 25
        }];
      },
      async findCallers() {
        return {
          symbol: 'TokenBudgetGuard',
          callers: [{
            name: 'ContextCompiler',
            qualifiedName: 'ContextCompiler',
            filePath: 'services/context_compiler.js',
            startLine: 1,
            endLine: 25,
            kind: 'class'
          }]
        };
      },
      async findCallees() {
        return { symbol: 'TokenBudgetGuard', callees: [] };
      },
      async analyzeImpact(sym, depth) {
        return {
          symbol: sym,
          depth: depth || 2,
          nodeCount: 2,
          edgeCount: 1,
          blastRadius: 'MEDIUM',
          affected: [
            { name: sym, kind: 'class', filePath: 'services/token_budget_guard.js', startLine: 1 },
            { name: 'ContextCompiler', kind: 'class', filePath: 'services/context_compiler.js', startLine: 1 }
          ]
        };
      }
    };

    const res = await cascadingExecutor.compileCodeGraphContext(
      {
        objective: 'Analyze TokenBudgetGuard and its callers',
        roleId: 'code_reviewer',
        action: 'BUG_FIX',
        targetFiles: ['services/token_budget_guard.js'],
        targetSymbols: ['TokenBudgetGuard']
      },
      { workspaceRoot, codeGraphAdapter: graphAdapter }
    );

    assert.ok(res && res.contextText.includes('TokenBudgetGuard'), 'Expected root target symbol in compiled XML');
    assert.ok(res.contextText.includes('ContextCompiler'), 'Expected discovered caller symbol in compiled XML');
    assert.strictEqual(res.metadata.roleId, 'code_reviewer');
    assert.strictEqual(res.metadata.policyName, 'REVIEW_BUGFIX');
    assert.ok(Array.isArray(res.metadata.blastRadius) && res.metadata.blastRadius.length === 1, 'Expected blastRadius assessment metadata');
  });

  await test('[C4-T7] TaskManager.submitTask forwards taskId and CodeGraph targets to underlying dispatcher', async () => {
    let capturedPayload = null;
    const tm = new taskManagerModule.TaskManager({
      dispatchFn: async (payload) => {
        capturedPayload = payload;
        const compiled = await cascadingExecutor.compileCodeGraphContext(payload, {
          workspaceRoot,
          codeGraphAdapter: mockAdapter
        });
        return {
          analysis: 'Verified',
          result: compiled ? `Compiled ${compiled.contextText.length} chars` : 'No context'
        };
      }
    });

    const sub = tm.submitTask({
      role: 'software_architect',
      objective: 'Refactor TokenBudgetGuard',
      action: 'REFACTOR',
      targetFiles: ['services/token_budget_guard.js'],
      targetSymbols: ['TokenBudgetGuard']
    });

    await new Promise(r => setTimeout(r, 40));
    const finished = tm.getTask(sub.taskId);
    assert.strictEqual(finished.status, 'COMPLETED');
    assert.ok(capturedPayload && capturedPayload.taskId === sub.taskId, 'Expected taskId bound into taskPayload');
    assert.strictEqual(capturedPayload.roleId, 'software_architect');
    assert.ok(finished.data.result.includes('Compiled '), 'Expected dispatcher to compile CodeGraph context');
  });

  await test('[C4-T8] Phase 2 SELF_CORRECTION dynamically expands CodeGraph traversal depth to 3 on verification failure', async () => {
    const memoryManager = require('../infrastructure/adapters/memory_manager');
    const instinctManager = require('../services/instinct_manager');
    const origClientMap = { ...cascadingExecutor.clientMap };
    const origVerify = verificationGate.verify;
    const origShouldVerify = verificationGate.shouldVerify;
    const origSearchMem = memoryManager.searchMemory;
    const origSaveMem = memoryManager.saveMemory;
    const origInjectInstinct = instinctManager.injectRelevantInstincts;
    const origSaveInstinct = instinctManager.saveInstinct;

    let depthObservedByGraph = [];
    let payloadsSeenByClient = [];

    const depthTrackingAdapter = {
      ...mockAdapter,
      validateSymbol(s) { return String(s).trim(); },
      async querySymbols(sym) {
        return [{
          id: 'n1',
          name: sym,
          qualifiedName: sym,
          kind: 'class',
          filePath: 'services/token_budget_guard.js',
          language: 'javascript',
          startLine: 1,
          endLine: 35
        }];
      },
      async findCallers(sym) {
        if (sym === 'TokenBudgetGuard') {
          return {
            symbol: sym,
            callers: [{
              name: 'ContextCompiler',
              qualifiedName: 'ContextCompiler',
              filePath: 'services/context_compiler.js',
              startLine: 1,
              endLine: 30,
              kind: 'class'
            }]
          };
        }
        // Depth 2 caller only reached when maxDepth >= 3
        depthObservedByGraph.push(sym);
        return { symbol: sym, callers: [] };
      },
      async findCallees() {
        return { symbol: 'TokenBudgetGuard', callees: [] };
      }
    };

    class MockSelfCorrectingCodeClient {
      constructor() {
        this.calls = 0;
      }
      async execute(payload) {
        this.calls++;
        payloadsSeenByClient.push(structuredClone(payload));
        if (this.calls === 1) {
          return { fix_ready: false };
        }
        return { fix_ready: true };
      }
    }

    try {
      cascadingExecutor.clientMap = {
        'nvidia-nim': MockSelfCorrectingCodeClient,
        'google': MockSelfCorrectingCodeClient,
        'deepseek': MockSelfCorrectingCodeClient,
        'vertex-ai': MockSelfCorrectingCodeClient
      };
      memoryManager.searchMemory = async () => null;
      memoryManager.saveMemory = async () => true;
      instinctManager.injectRelevantInstincts = async () => {};
      instinctManager.saveInstinct = async () => {};
      verificationGate.shouldVerify = () => true;
      verificationGate.verify = async (output) => {
        if (output && output.fix_ready === true) {
          return { success: true, data: output, verified: true };
        }
        return {
          success: false,
          reason: 'Missing caller boundary check',
          errorType: 'VERIFICATION_CONTENT_FAIL'
        };
      };

      const taskCtx = {
        objective: `Fix TokenBudgetGuard caller contract ${Date.now()}`,
        action: 'BUG_FIX',
        targetFiles: ['services/token_budget_guard.js'],
        targetSymbols: ['TokenBudgetGuard'],
        tags: ['critical']
      };
      const schema = {
        type: 'object',
        properties: { fix_ready: { type: 'boolean' } },
        required: ['fix_ready']
      };

      const execRes = await cascadingExecutor.execute(taskCtx, schema, {
        preferredTier: 'high',
        workspaceRoot,
        codeGraphAdapter: depthTrackingAdapter
      });

      assert.strictEqual(execRes.success, true);
      assert.strictEqual(payloadsSeenByClient.length, 2, 'Expected 1 initial call + 1 self-correction call');
      assert.strictEqual(
        payloadsSeenByClient[1]._correction_feedback.expanded_context_depth,
        3,
        'Expected self-correction payload to report expanded_context_depth === 3'
      );
      assert.ok(
        depthObservedByGraph.includes('ContextCompiler'),
        'Expected depth=3 expansion to traverse 2nd-hop callers of ContextCompiler'
      );
    } finally {
      cascadingExecutor.clientMap = origClientMap;
      verificationGate.verify = origVerify;
      verificationGate.shouldVerify = origShouldVerify;
      memoryManager.searchMemory = origSearchMem;
      memoryManager.saveMemory = origSaveMem;
      instinctManager.injectRelevantInstincts = origInjectInstinct;
      instinctManager.saveInstinct = origSaveInstinct;
    }
  });

  await test('[C4-T9] Phase 2 TaskManager x-idempotency-key deduplicates identical payloads and rejects conflicts with 409', async () => {
    let dispatchCount = 0;
    const tm = new taskManagerModule.TaskManager({
      dispatchFn: async () => {
        dispatchCount++;
        await new Promise(r => setTimeout(r, 20));
        return { analysis: 'Idempotent', result: 'OK' };
      }
    });

    // 1. First submission with idempotency key
    const sub1 = tm.submitTask(
      { objective: 'Idempotent deployment check', tier: 'high' },
      { idempotencyKey: 'idem-key-alpha-01' }
    );
    assert.ok(sub1.taskId, 'Expected valid taskId on first submission');
    assert.strictEqual(sub1.deduplicated, undefined);

    // 2. Duplicate submission with identical payload and same idempotency key
    const sub2 = tm.submitTask(
      { objective: 'Idempotent deployment check', tier: 'high' },
      { idempotencyKey: 'idem-key-alpha-01' }
    );
    assert.strictEqual(sub2.taskId, sub1.taskId, 'Must return exact same taskId');
    assert.strictEqual(sub2.deduplicated, true, 'Must flag deduplicated: true');

    // 3. Conflicting payload with same idempotency key -> 409 IDEMPOTENCY_KEY_CONFLICT
    assert.throws(() => {
      tm.submitTask(
        { objective: 'Different objective on same key', tier: 'high' },
        { idempotencyKey: 'idem-key-alpha-01' }
      );
    }, (err) => {
      assert.strictEqual(err.statusCode, 409);
      assert.strictEqual(err.type, 'IDEMPOTENCY_KEY_CONFLICT');
      return true;
    });

    // 4. Malformed idempotency key -> 400 INVALID_PARAMETER
    assert.throws(() => {
      tm.submitTask(
        { objective: 'Malformed key test' },
        { idempotencyKey: 'bad key with spaces!' }
      );
    }, (err) => {
      assert.strictEqual(err.statusCode, 400);
      return true;
    });

    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(dispatchCount, 1, 'Underlying dispatcher must only be called once for deduplicated submissions');
  });

  await test('[C4-T10] Phase 2 CodeGraph compilation telemetry is recorded in getCodeGraphTelemetry and attached to TaskManager.getTask', async () => {
    cascadingExecutor.resetCodeGraphTelemetry();

    const tm = new taskManagerModule.TaskManager({
      dispatchFn: async (payload) => {
        const compiled = await cascadingExecutor.compileCodeGraphContext(payload, {
          workspaceRoot,
          codeGraphAdapter: mockAdapter
        });
        return {
          analysis: 'Telemetry verified',
          result: compiled ? 'Compiled' : 'None'
        };
      }
    });

    const sub = tm.submitTask({
      role: 'code_reviewer',
      objective: 'Verify telemetry attachment',
      action: 'BUG_FIX',
      targetFiles: ['services/token_budget_guard.js'],
      targetSymbols: ['TokenBudgetGuard']
    });

    await new Promise(r => setTimeout(r, 40));

    const taskDetail = tm.getTask(sub.taskId);
    assert.strictEqual(taskDetail.status, 'COMPLETED');
    assert.ok(taskDetail.contextMeta, 'Expected contextMeta attached to completed task');
    assert.strictEqual(taskDetail.contextMeta.taskId, sub.taskId);
    assert.strictEqual(taskDetail.contextMeta.roleId, 'code_reviewer');
    assert.strictEqual(taskDetail.contextMeta.policyName, 'REVIEW_BUGFIX');
    assert.strictEqual(taskDetail.contextMeta.snapshotId, 'snap-c4-test');
    assert.ok(taskDetail.contextMeta.measuredTokens > 0, 'Expected positive measuredTokens in contextMeta');

    const globalTelemetry = cascadingExecutor.getCodeGraphTelemetry();
    assert.strictEqual(globalTelemetry.summary.totalCompilations, 1);
    assert.ok(globalTelemetry.summary.totalCompiledTokens > 0);
    assert.strictEqual(globalTelemetry.recentCompilations[0].taskId, sub.taskId);
  });

  await test('[C4-T11] Cross-Module Invariant: Upstream SOURCE_MATCHED / UNVERIFIED is never escalated to VERIFIED downstream', async () => {
    // Standard compilation path
    const stdRes = await cascadingExecutor.compileCodeGraphContext(
      {
        objective: 'Check evidence trust preservation',
        taskId: 'task-c4-t11-std',
        action: 'BUG_FIX',
        targetFiles: ['services/token_budget_guard.js'],
        targetSymbols: ['TokenBudgetGuard']
      },
      { workspaceRoot, codeGraphAdapter: mockAdapter }
    );
    assert.ok(stdRes && typeof stdRes.contextText === 'string' && stdRes.contextText.length > 0, 'Expected compiled output');
    assert.strictEqual(
      /\b(status|validity|validationStatus|evidence_status)=["']VERIFIED["']/i.test(stdRes.contextText),
      false,
      'Standard compiler must NEVER escalate evidence status to VERIFIED'
    );

    // Isolated envelope path (explicitly passing upstream SOURCE_MATCHED)
    const isoRes = await cascadingExecutor.compileCodeGraphContext(
      {
        objective: 'Check isolated evidence trust preservation',
        taskId: 'task-c4-t11-iso',
        tenantId: 'tenant-alpha',
        taskType: 'FEATURE_DEV',
        action: 'FEATURE',
        targetFiles: ['services/token_budget_guard.js'],
        targetSymbols: ['TokenBudgetGuard']
      },
      {
        workspaceRoot,
        codeGraphAdapter: mockAdapter,
        isolatedEnvelope: true,
        aggregateEvidenceStatus: 'SOURCE_MATCHED'
      }
    );
    assert.ok(isoRes && isoRes.metadata && isoRes.metadata.admissionReceipt, 'Expected admissionReceipt');
    assert.strictEqual(
      isoRes.metadata.admissionReceipt.aggregateEvidenceStatus,
      'SOURCE_MATCHED',
      'AdmissionReceipt must preserve SOURCE_MATCHED and never escalate to VERIFIED'
    );
    assert.notStrictEqual(
      isoRes.metadata.admissionReceipt.aggregateEvidenceStatus,
      'VERIFIED',
      'AdmissionReceipt aggregateEvidenceStatus must never be VERIFIED'
    );
    assert.strictEqual(
      /\b(status|validity|validationStatus|evidence_status)=["']VERIFIED["']/i.test(isoRes.contextText),
      false,
      'Isolated envelope must NEVER escalate evidence status to VERIFIED'
    );
  });

  await test('[C4-T12] Cross-Module Invariant: Telemetry faults never break main compilation or task execution', async () => {
    const origGetTaskTelemetry = cascadingExecutor.getTaskTelemetry;
    cascadingExecutor.getTaskTelemetry = () => {
      throw new Error('Simulated telemetry store outage');
    };

    try {
      const tm = new taskManagerModule.TaskManager({
        dispatchFn: async (payload) => {
          const compiled = await cascadingExecutor.compileCodeGraphContext(payload, {
            workspaceRoot,
            codeGraphAdapter: mockAdapter
          });
          return {
            analysis: 'Main task succeeded despite telemetry fault',
            result: compiled ? 'Compiled' : 'None'
          };
        }
      });

      const sub = tm.submitTask({
        role: 'code_reviewer',
        objective: 'Verify non-fatal telemetry isolation',
        action: 'BUG_FIX',
        targetFiles: ['services/token_budget_guard.js'],
        targetSymbols: ['TokenBudgetGuard']
      });

      await new Promise(r => setTimeout(r, 40));

      const taskDetail = tm.getTask(sub.taskId);
      assert.strictEqual(taskDetail.status, 'COMPLETED', 'Task must complete even when telemetry lookup throws');
      assert.strictEqual(taskDetail.data.result, 'Compiled', 'Main CodeGraph compilation result must remain intact');
    } finally {
      cascadingExecutor.getTaskTelemetry = origGetTaskTelemetry;
    }
  });

  console.log(`\n======================================================`);
  console.log(`Phase 1-C4 Pipeline Wiring Complete: ${passed} Passed, ${failed} Failed`);
  console.log(`======================================================\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
