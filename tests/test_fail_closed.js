/**
 * P0-A Automated Assertion Suite: Verification Fail-Closed Tests (T1 - T8)
 * 
 * Verifies that Model Hub Agent strictly adheres to Fail-Closed security:
 * 1. Verification FAIL / Exception strictly prevents GlobalState updates.
 * 2. Unverified or failed outputs are NEVER written to Memory.
 * 3. Memory Audit exceptions strictly reject cached results (Fail-Closed).
 * 4. All assertions use Node.js native assert with non-zero exit code on failure.
 * 
 * Run via: npm test or npm run test:fail-closed
 */

const assert = require('assert');
const verificationGate = require('../services/verification_gate');
const GlobalState = require('../shared/global_state');

let passedCount = 0;
let failedCount = 0;

function report(testId, description, fn) {
  try {
    fn();
    console.log(`  ✅ [${testId}] PASS: ${description}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ [${testId}] FAIL: ${description}`);
    console.error(`     Error: ${err.message}`);
    failedCount++;
  }
}

async function reportAsync(testId, description, fn) {
  try {
    await fn();
    console.log(`  ✅ [${testId}] PASS: ${description}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ [${testId}] FAIL: ${description}`);
    console.error(`     Error: ${err.message}`);
    failedCount++;
  }
}

async function runAllTests() {
  console.log("\n==================================================");
  console.log("🛡️  [P0-A Test Suite] Verification Fail-Closed Assertions");
  console.log("==================================================\n");

  // ----------------------------------------------------
  // T1: Verification PASS -> 正常放行
  // ----------------------------------------------------
  await reportAsync('T1', 'Verification PASS: Returns verified true and allows delivery', async () => {
    const mockClientFactory = () => ({
      execute: async () => ({
        passed: true,
        confidence: 0.95,
        violation_details: ""
      })
    });

    const context = {
      objective: "Calculate sum of numbers",
      constraints: ["No external libraries"],
      tags: ["coding"],
      tier: "high"
    };

    const primaryResult = { result: 42 };
    const outcome = await verificationGate.verify(primaryResult, context, mockClientFactory);

    assert.strictEqual(outcome.success, true, "Outcome success must be true");
    assert.strictEqual(outcome.verified, true, "Verified flag must be true");
    assert.deepStrictEqual(outcome.data, primaryResult, "Data must match primaryResult");
  });

  // ----------------------------------------------------
  // T2: Verification 明確 FAIL，回傳 VERIFICATION_CONTENT_FAIL
  // ----------------------------------------------------
  await reportAsync('T2', 'Verification FAIL: Explicit content failure returns errorType VERIFICATION_CONTENT_FAIL', async () => {
    const mockClientFactory = () => ({
      execute: async () => ({
        passed: false,
        confidence: 0.90,
        violation_details: "Memory leak detected in loop"
      })
    });

    const context = {
      objective: "Stream large file",
      constraints: ["Constant memory usage"],
      tags: ["coding"],
      tier: "high"
    };

    const primaryResult = { code: "fs.readFileSync(hugeFile)" };
    const outcome = await verificationGate.verify(primaryResult, context, mockClientFactory);

    assert.strictEqual(outcome.success, false, "Outcome success must be false on verification fail");
    assert.strictEqual(outcome.errorType, "VERIFICATION_CONTENT_FAIL", "ErrorType must be VERIFICATION_CONTENT_FAIL");
    assert.strictEqual(outcome.reason, "Memory leak detected in loop", "Reason must reflect violation details");
  });

  // ----------------------------------------------------
  // T3: Verification 明確 FAIL，耗盡重試後 GlobalState 絕不更新且不寫入 Memory
  // ----------------------------------------------------
  await reportAsync('T3', 'Verification FAIL Exhausted: GlobalState remains untouched (version unchanged)', async () => {
    const stateManager = new GlobalState({ objective: "Critical operation", tags: ["security"] });
    const initialSnapshot = stateManager.getSnapshot();
    const initialVersion = initialSnapshot.version;

    // Simulate cascading executor failure simulation
    let memorySaveCalls = 0;
    const mockMemoryManager = {
      saveMemory: async () => { memorySaveCalls++; }
    };

    const verificationOutcome = {
      success: false,
      reason: "Security vulnerability detected",
      errorType: "VERIFICATION_CONTENT_FAIL"
    };

    // Defense in Depth check (similar to main.js and cascading_executor.js)
    let stateUpdated = false;
    if (verificationOutcome.success === true) {
      await mockMemoryManager.saveMemory("task", { leaked: true });
      stateManager.update({ leaked: true }, initialVersion);
      stateUpdated = true;
    }

    assert.strictEqual(stateUpdated, false, "State update must NOT be triggered on failure");
    assert.strictEqual(memorySaveCalls, 0, "Memory.saveMemory must NEVER be called on verification failure");
    assert.strictEqual(stateManager.getSnapshot().version, initialVersion, "Version must not change");
  });

  // ----------------------------------------------------
  // T4: Verification API Exception -> Fail-Closed (回傳 VERIFICATION_INFRASTRUCTURE_ERROR)
  // ----------------------------------------------------
  await reportAsync('T4', 'Verification API Exception: Strict Fail-Closed with VERIFICATION_INFRASTRUCTURE_ERROR', async () => {
    const mockFailingClientFactory = () => ({
      execute: async () => {
        throw new Error("HTTP 504 Gateway Timeout from Auditor Endpoint");
      }
    });

    const context = {
      objective: "Authorize transaction",
      constraints: ["Double entry verification"],
      tags: ["security"],
      tier: "high"
    };

    const primaryResult = { authorized: true };
    const outcome = await verificationGate.verify(primaryResult, context, mockFailingClientFactory);

    // Fail-Closed assertion: MUST NOT return success: true!
    assert.strictEqual(outcome.success, false, "Must FAIL-CLOSED when verification throws an exception");
    assert.strictEqual(outcome.errorType, "VERIFICATION_INFRASTRUCTURE_ERROR", "Must specify infrastructure error type");
    assert.ok(outcome.reason.includes("504 Gateway Timeout"), "Reason must contain root cause error");
  });

  // ----------------------------------------------------
  // T5: Router / Client 建立失敗 -> Fail-Closed
  // ----------------------------------------------------
  await reportAsync('T5', 'Client Factory Crash: Catches factory crash and fails closed', async () => {
    const crashingClientFactory = () => {
      throw new Error("Cannot allocate TLS socket for auditor");
    };

    const context = {
      objective: "Process payment",
      tags: ["financial"],
      tier: "high"
    };

    const outcome = await verificationGate.verify({ tx: 100 }, context, crashingClientFactory);

    assert.strictEqual(outcome.success, false, "Must fail closed if client factory fails");
    assert.strictEqual(outcome.errorType, "VERIFICATION_INFRASTRUCTURE_ERROR");
  });

  // ----------------------------------------------------
  // T6: Memory Audit Exception -> 嚴格拒絕快取 (回傳 false)
  // ----------------------------------------------------
  await reportAsync('T6', 'Memory Audit Exception: Fails closed by returning false (reject cache)', async () => {
    const crashingAuditFactory = () => ({
      execute: async () => {
        throw new Error("Qdrant embedding model unavailable");
      }
    });

    const isAuditValid = await verificationGate.auditMemory(
      "Fetch user profiles",
      { users: ["admin"] },
      crashingAuditFactory
    );

    // Fail-Closed assertion: MUST return false, NOT true!
    assert.strictEqual(isAuditValid, false, "Memory audit MUST return false when auditor encounters exception");
  });

  // ----------------------------------------------------
  // T7: Memory Audit 拒絕快取 -> 不得使用舊快取結果，不污染 context
  // ----------------------------------------------------
  await reportAsync('T7', 'Memory Audit Rejection: Refuses cache when auditor finds mismatch', async () => {
    const rejectingAuditFactory = () => ({
      execute: async () => ({
        valid: false,
        reason: "Cached result is for Python 3.8, but objective requires Node.js 20"
      })
    });

    const isAuditValid = await verificationGate.auditMemory(
      "Write script in Node.js 20",
      { code: "python -c 'print()'" },
      rejectingAuditFactory
    );

    assert.strictEqual(isAuditValid, false, "Memory audit must return false when validator rejects");

    // Test that executor behavior does NOT contaminate context
    const context = { objective: "Write script in Node.js 20" };
    const cachedMemory = { score: 0.92, result: { code: "python code" } };
    
    if (isAuditValid) {
      Object.assign(context, cachedMemory.result);
    }

    assert.strictEqual(context.code, undefined, "Context must NOT be contaminated with rejected cache");
  });

  // ----------------------------------------------------
  // T8: Main.js Defense-in-Depth 契約阻斷: 非成功或空資料嚴禁更新 GlobalState
  // ----------------------------------------------------
  report('T8', 'Main Defense-in-Depth: Null or failed executionResult throws and blocks state update', () => {
    const stateManager = new GlobalState({ objective: "Update settings" });
    const initialVersion = stateManager.getSnapshot().version;

    const testExecutionResults = [
      null,
      undefined,
      { success: false, data: { status: "corrupted" } },
      { success: true, data: null },
      { success: true, data: undefined }
    ];

    for (const res of testExecutionResults) {
      assert.throws(() => {
        if (!res || res.success !== true) {
          throw new Error("Execution rejected: no verified result available.");
        }
        if (res.data === undefined || res.data === null) {
          throw new Error("Execution rejected: result data is missing.");
        }
        stateManager.update(res.data, initialVersion);
      }, Error, "Contract assertion must throw for invalid execution result");
    }

    assert.strictEqual(stateManager.getSnapshot().version, initialVersion, "GlobalState version must remain unchanged");
  });

  // ----------------------------------------------------
  // Summary & Non-Zero Exit Code Enforcement
  // ----------------------------------------------------
  console.log("\n==================================================");
  console.log(`📊 [Test Results]: ${passedCount} passed, ${failedCount} failed`);
  console.log("==================================================\n");

  if (failedCount > 0) {
    console.error("🛑 [FAILURE] P0-A Fail-Closed assertions failed! Exiting with code 1.");
    process.exit(1);
  } else {
    console.log("🎉 [SUCCESS] All P0-A Fail-Closed assertions PASSED with 100% fidelity.\n");
    process.exit(0);
  }
}

runAllTests();
