/**
 * Phase 1-C4 Main Pipeline Wiring Integration Tests
 * Verifies CascadingExecutor.compileCodeGraphContext integration across
 * RoleAwareContextPlanner -> EvidenceAdmissionEngine -> ContextCompiler -> IsolationBoundary.
 */
const assert = require('assert');
const path = require('path');
const cascadingExecutor = require('../services/cascading_executor');

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

  console.log(`\n======================================================`);
  console.log(`Phase 1-C4 Pipeline Wiring Complete: ${passed} Passed, ${failed} Failed`);
  console.log(`======================================================\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
