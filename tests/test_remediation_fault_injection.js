/**
 * CCF6420 Remediation & Fault-Injection Test Suite
 * Verifies P0/P1 security boundaries, cross-process atomic locking,
 * immutable FD snapshot admission, canonical idempotency hashing,
 * ExecutionBoundaryGuard immutability, Dashboard XSS elimination,
 * honest server startup health, and telemetry field accuracy.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  ContextIsolationError,
  ExecutionBoundaryGuard,
  WHITELISTED_READ_ONLY_TOOLS,
  FORBIDDEN_MUTATING_TOOLS,
  createDefaultLockBinding,
  createCrossProcessFileLockBinding
} = require('../services/isolation_boundary');
const { EvidenceAdmissionEngine } = require('../services/evidence_admission');
const cascadingExecutor = require('../services/cascading_executor');
const taskManagerModule = require('../services/task_manager');

async function run() {
  console.log('=== CCF6420 Remediation & Fault-Injection Test Suite ===\n');
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

  await test('[FI-1] P0-1 Lock semantics honesty & genuine two-process cross-process mutual exclusion', async () => {
    const simLock = createDefaultLockBinding();
    assert.strictEqual(simLock.lockSemantics, 'SIMULATED_IN_PROCESS');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mha-lock-'));
    const lockFilePath = path.join(tmpDir, 'sentinel.atomic.lock');
    const lockBindingPath = path.resolve(__dirname, '../services/isolation_boundary.js');

    try {
      const realLock = createCrossProcessFileLockBinding({ lockFilePath });
      assert.strictEqual(realLock.lockSemantics, 'CROSS_PROCESS_ATOMIC_LOCKFILE');

      // Child A acquires lock, signals ready, holds for 350ms, then releases
      const childAScript = `
        const { createCrossProcessFileLockBinding } = require(${JSON.stringify(lockBindingPath)});
        const b = createCrossProcessFileLockBinding({ lockFilePath: ${JSON.stringify(lockFilePath)} });
        const ok = b.acquireLock(10, 'EXCLUSIVE', 2000);
        if (!ok) process.exit(2);
        process.stdout.write('LOCKED\\n');
        setTimeout(() => {
          b.releaseLock(10);
          process.exit(0);
        }, 350);
      `;
      const childBScript = `
        const { createCrossProcessFileLockBinding } = require(${JSON.stringify(lockBindingPath)});
        const b = createCrossProcessFileLockBinding({ lockFilePath: ${JSON.stringify(lockFilePath)} });
        const acquiredWhileContended = b.acquireLock(11, 'EXCLUSIVE', 80);
        process.stdout.write(acquiredWhileContended ? 'ACQUIRED' : 'BLOCKED');
        if (acquiredWhileContended) b.releaseLock(11);
        process.exit(0);
      `;

      const childA = spawn(process.execPath, ['-e', childAScript], { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        childA.stdout.on('data', (d) => {
          if (d.toString().includes('LOCKED')) resolve();
        });
        childA.on('error', reject);
        childA.on('exit', (code) => {
          if (code !== 0) reject(new Error(`Child A exited early with code ${code}`));
        });
      });

      // While Child A holds the lock, Child B must be BLOCKED
      const childBOutput = await new Promise((resolve, reject) => {
        const childB = spawn(process.execPath, ['-e', childBScript], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        childB.stdout.on('data', d => { out += d.toString(); });
        childB.on('error', reject);
        childB.on('exit', () => resolve(out.trim()));
      });
      assert.strictEqual(childBOutput, 'BLOCKED', 'Second independent OS process MUST be blocked while first holds lock');

      // Wait for Child A to release
      const childAExit = await new Promise(resolve => childA.on('exit', resolve));
      assert.strictEqual(childAExit, 0);

      // Now parent process can acquire cleanly
      assert.strictEqual(realLock.acquireLock(12, 'EXCLUSIVE', 500), true, 'Lock must be acquirable after holder releases');
      assert.strictEqual(realLock.releaseLock(12), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('[FI-2] P0-2 EvidenceAdmission rejects FILE_CONCURRENTLY_MODIFIED and ContextCompiler derives isolationTier honestly', async () => {
    const mockAdapter = {
      projectPath: workspaceRoot,
      async resolveAndValidatePath(relPath) {
        return path.resolve(workspaceRoot, relPath);
      },
      async getStatus() {
        return { snapshotId: 'snap-fi-2', lastSyncedAt: '2026-11-19T00:00:00Z' };
      },
      async getFileIndexSnapshot() {
        return null;
      }
    };

    const faultEngine = new EvidenceAdmissionEngine({
      codeGraphAdapter: mockAdapter,
      workspaceRoot,
      snapshotReader: () => {
        throw new ContextIsolationError('FILE_CONCURRENTLY_MODIFIED', '4-tuple fstat mismatch simulated');
      }
    });

    const faultResult = await faultEngine.evaluateAdmission(
      [{ id: 'ev-fault', symbol: 'TokenBudgetGuard', filePath: 'services/token_budget_guard.js', startLine: 1, endLine: 10 }],
      'snap-fi-2',
      'FEATURE'
    );
    assert.strictEqual(faultResult.admittedEvidence.length, 0);
    assert.strictEqual(faultResult.rejectedEvidence.length, 1);
    assert.strictEqual(faultResult.rejectedEvidence[0].rejectionReason, 'FILE_CONCURRENTLY_MODIFIED');

    // Real FD snapshot path -> grants TIER_4_VERIFIED_FD
    const isoRes = await cascadingExecutor.compileCodeGraphContext(
      {
        objective: 'Verify FD isolationTier',
        taskId: 'task-fi-2-fd',
        tenantId: 'tenant-fi',
        taskType: 'FEATURE_DEV',
        action: 'FEATURE',
        targetFiles: ['services/token_budget_guard.js'],
        targetSymbols: ['TokenBudgetGuard']
      },
      { workspaceRoot, codeGraphAdapter: mockAdapter, isolatedEnvelope: true }
    );
    assert.ok(isoRes && isoRes.metadata && isoRes.metadata.admissionReceipt);
    const telemetry = cascadingExecutor.getTaskTelemetry('task-fi-2-fd');
    assert.strictEqual(telemetry.isolationTier, 'TIER_4_VERIFIED_FD');
  });

  await test('[FI-3] ExecutionBoundaryGuard whitelist is immutable and IPC requires explicit toolName', async () => {
    assert.strictEqual(Array.isArray(WHITELISTED_READ_ONLY_TOOLS), true);
    assert.strictEqual(Object.isFrozen(WHITELISTED_READ_ONLY_TOOLS), true);
    assert.strictEqual(Object.isFrozen(FORBIDDEN_MUTATING_TOOLS), true);
    assert.throws(() => {
      WHITELISTED_READ_ONLY_TOOLS.push('evil_tool');
    }, TypeError);

    // Attempting to expand whitelist via constructor options must fail
    const guard = new ExecutionBoundaryGuard({ allowedTools: ['read_file', 'run_command', 'custom_shell'] });
    assert.strictEqual(guard.authorizeToolCall('read_file'), true);
    assert.throws(() => guard.authorizeToolCall('run_command'), /TOOL_EXECUTION_FORBIDDEN/);
    assert.throws(() => guard.authorizeToolCall('custom_shell'), /TOOL_EXECUTION_FORBIDDEN/);

    // Missing toolName in READ_ONLY IPC request must be rejected
    assert.throws(() => guard.authorizeIpcRequest({ mode: 'READ_ONLY' }), /TOOL_EXECUTION_FORBIDDEN/);
    assert.strictEqual(guard.authorizeIpcRequest({ mode: 'READ_ONLY', toolName: 'read_file' }), true);
  });

  await test('[FI-4] P1-1 Canonical Idempotency Payload Hash detects code_context and maxExecutionTokens conflicts (409)', async () => {
    const tm = new taskManagerModule.TaskManager({
      dispatchFn: async () => ({ analysis: 'OK', result: 'Done' })
    });

    const sub1 = tm.submitTask(
      { objective: 'Review this code', code_context: 'const x = 1; // Version A', tier: 'high' },
      { idempotencyKey: 'fi-idem-code-ctx' }
    );
    assert.ok(sub1.taskId);

    // Identical payload (including code_context) deduplicates
    const subDup = tm.submitTask(
      { objective: 'Review this code', code_context: 'const x = 1; // Version A', tier: 'high' },
      { idempotencyKey: 'fi-idem-code-ctx' }
    );
    assert.strictEqual(subDup.taskId, sub1.taskId);
    assert.strictEqual(subDup.deduplicated, true);

    // Different code_context with SAME key -> 409 IDEMPOTENCY_KEY_CONFLICT
    assert.throws(() => {
      tm.submitTask(
        { objective: 'Review this code', code_context: 'const x = 2; // Version B', tier: 'high' },
        { idempotencyKey: 'fi-idem-code-ctx' }
      );
    }, (err) => {
      assert.strictEqual(err.statusCode, 409);
      assert.strictEqual(err.type, 'IDEMPOTENCY_KEY_CONFLICT');
      return true;
    });

    // Different maxExecutionTokens with SAME key -> 409 IDEMPOTENCY_KEY_CONFLICT
    assert.throws(() => {
      tm.submitTask(
        { objective: 'Review this code', code_context: 'const x = 1; // Version A', tier: 'high', maxExecutionTokens: 500 },
        { idempotencyKey: 'fi-idem-code-ctx' }
      );
    }, (err) => {
      assert.strictEqual(err.statusCode, 409);
      assert.strictEqual(err.type, 'IDEMPOTENCY_KEY_CONFLICT');
      return true;
    });
  });

  await test('[FI-5] P1-2 Dashboard memory rendering eliminates DOM-based XSS innerHTML interpolation', async () => {
    const html = fs.readFileSync(path.join(workspaceRoot, 'observability/dashboard.html'), 'utf-8');
    assert.strictEqual(
      /\$\{item\.objective\}/.test(html),
      false,
      'dashboard.html must NOT interpolate item.objective inside innerHTML template literals'
    );
    assert.ok(
      html.includes('tdObj.textContent = safeObjective'),
      'dashboard.html must render memory objective via textContent'
    );
  });

  await test('[FI-6] P1-3 server.js does not fabricate startup healthy heartbeats', async () => {
    const serverSrc = fs.readFileSync(path.join(workspaceRoot, 'server.js'), 'utf-8');
    assert.strictEqual(
      /heartbeatRegistry\.record\(['"](deepseek|vertex-ai|nvidia-nim)['"]/.test(serverSrc),
      false,
      'server.js must NOT seed synthetic healthy heartbeats at startup'
    );
  });

  await test('[FI-7] Telemetry captures real admissionReceipt.snapshotId and separates measured vs estimated tokens', async () => {
    cascadingExecutor.resetCodeGraphTelemetry();
    const mockAdapter = {
      projectPath: workspaceRoot,
      async resolveAndValidatePath(relPath) {
        return path.resolve(workspaceRoot, relPath);
      },
      async getStatus() {
        return { snapshotId: 'snap-fi-real-id', lastSyncedAt: '2026-11-19T00:00:00Z' };
      },
      async getFileIndexSnapshot() {
        return null;
      }
    };

    await cascadingExecutor.compileCodeGraphContext(
      {
        objective: 'Verify real snapshotId telemetry',
        taskId: 'task-fi-7',
        tenantId: 'tenant-fi',
        taskType: 'FEATURE_DEV',
        action: 'FEATURE',
        targetFiles: ['services/token_budget_guard.js'],
        targetSymbols: ['TokenBudgetGuard']
      },
      { workspaceRoot, codeGraphAdapter: mockAdapter, isolatedEnvelope: true }
    );

    const tel = cascadingExecutor.getTaskTelemetry('task-fi-7');
    assert.ok(tel, 'Expected task telemetry entry');
    assert.strictEqual(tel.snapshotId, 'snap-fi-real-id', 'Must capture real admissionReceipt.snapshotId, not fallback');
    assert.strictEqual(typeof tel.measuredTokens, 'number', 'Expected real numeric measuredTokens');
    assert.strictEqual(tel.estimatedTokens, null, 'estimatedTokens must be null when measuredTokens is available');
    assert.strictEqual(typeof tel.tokenEstimationMethod, 'string', 'Expected explicit tokenEstimationMethod');
  });

  console.log(`\n=============================================================`);
  console.log(`CCF6420 Remediation Fault-Injection Complete: ${passed} Passed, ${failed} Failed`);
  console.log(`=============================================================\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
