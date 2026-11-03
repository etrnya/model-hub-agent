/**
 * P0-B Step 1: Automated Assertion Test for CascadingExecutor Self-Correction Loop
 * 
 * Verifies complete state transitions:
 * 1. Initial primary output violates constraints.
 * 2. Initial verification explicitly returns FAIL.
 * 3. Self-Correction loop is genuinely triggered (payload carries _correction_feedback).
 * 4. Re-verification audits corrected output.
 * 5. Final output passes and returns verified data.
 * 6. Correction attempts do not exceed maximum limit (max 3).
 * 7. Exhaustion failure: When model fails all correction attempts, execution strictly rejects
 *    and does NOT masquerade as success.
 * 
 * Uses node:assert/strict. Exits with non-zero code on any failure.
 */

const assert = require('node:assert/strict');
const cascadingExecutor = require('../services/cascading_executor');
const verificationGate = require('../services/verification_gate');

let passedCount = 0;
let failedCount = 0;

async function runTestCase(testId, description, fn) {
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

// Preserve original methods for cleanup
const originalClientMap = { ...cascadingExecutor.clientMap };
const originalVerify = verificationGate.verify;
const originalShouldVerify = verificationGate.shouldVerify;

async function runAll() {
  console.log("\n==================================================");
  console.log("🔄 [P0-B Test Suite] Self-Correction State Transition Assertions");
  console.log("==================================================\n");

  const schema = {
    type: "object",
    properties: {
      magic_word: { type: "string" },
      number_check: { type: "number" }
    },
    required: ["magic_word", "number_check"]
  };

  try {
    // ----------------------------------------------------
    // SC1: 正常自癒狀態流 (FAIL -> Feedback -> Corrected -> PASS)
    // ----------------------------------------------------
    await runTestCase('SC1', 'Full State Transition: FAIL -> Feedback Injection -> Re-verify -> Success', async () => {
      let clientExecutionHistory = [];
      let auditExecutionHistory = [];

      class MockHealingClient {
        constructor(config) {
          this.attemptCount = 0;
        }
        async execute(payload, s) {
          this.attemptCount++;
          const hasCorrectionFeedback = Boolean(payload._correction_feedback);
          clientExecutionHistory.push({
            attempt: this.attemptCount,
            hasFeedback: hasCorrectionFeedback,
            feedbackError: payload._correction_feedback?.validation_error
          });

          // Attempt 1: Violates constraints
          if (this.attemptCount === 1) {
            return { magic_word: "wrong_word", number_check: 100 };
          }
          // Attempt 2: Properly corrects output based on feedback
          return { magic_word: "antigravity", number_check: 999 };
        }
      }

      // Mock Client Map
      cascadingExecutor.clientMap = {
        'nvidia-nim': MockHealingClient,
        'google': MockHealingClient,
        'deepseek': MockHealingClient,
        'vertex-ai': MockHealingClient
      };

      // Mock Verification Gate
      verificationGate.shouldVerify = () => true;
      verificationGate.verify = async (primaryResult) => {
        const passed = primaryResult.magic_word === "antigravity" && primaryResult.number_check === 999;
        auditExecutionHistory.push({
          evaluatedOutput: primaryResult,
          passed
        });
        if (passed) {
          return { success: true, data: primaryResult, verified: true };
        }
        return { 
          success: false, 
          reason: "magic_word must be 'antigravity' and number_check must be 999.", 
          errorType: "VERIFICATION_CONTENT_FAIL" 
        };
      };

      const context = {
        objective: `Generate token with magic_word antigravity and number_check 999: ${Date.now()}`,
        constraints: ["magic_word must be 'antigravity'", "number_check must be 999"],
        tags: ["critical"],
        code_context: "// Offline deterministic unit test context - bypasses CLI extraction"
      };

      const result = await cascadingExecutor.execute(context, schema, { preferredTier: 'high' });

      // 1. 初次輸出違規斷言
      assert.strictEqual(clientExecutionHistory[0].hasFeedback, false, 'Attempt 1 must NOT have correction feedback');
      
      // 2. 初次驗證 FAIL 斷言
      assert.strictEqual(auditExecutionHistory[0].passed, false, 'Initial verification must return FAIL');
      assert.strictEqual(auditExecutionHistory[0].evaluatedOutput.magic_word, "wrong_word");

      // 3. Self-Correction 確實被觸發斷言
      assert.strictEqual(clientExecutionHistory.length, 2, 'Client must be called exactly twice (1 initial + 1 correction)');
      assert.strictEqual(clientExecutionHistory[1].hasFeedback, true, 'Correction attempt must receive _correction_feedback');
      assert.ok(clientExecutionHistory[1].feedbackError.includes("magic_word must be 'antigravity'"), 'Feedback must describe the exact validation error');

      // 4. 再次審查斷言
      assert.strictEqual(auditExecutionHistory.length, 2, 'Audit must be called twice (initial + post-correction)');
      assert.strictEqual(auditExecutionHistory[1].passed, true, 'Re-verification must evaluate to PASS');

      // 5. 最終結果通過斷言
      assert.strictEqual(result.success, true, 'Execution result must report success');
      assert.strictEqual(result.data.magic_word, "antigravity", 'Result magic_word must be corrected to antigravity');
      assert.strictEqual(result.data.number_check, 999, 'Result number_check must be corrected to 999');

      // 6. 修正次數未超標斷言
      assert.ok(clientExecutionHistory.length <= 3, 'Correction attempts must not exceed maxCorrectionAttempts');
    });

    // ----------------------------------------------------
    // SC2: 修正耗盡狀態流 (連續失敗 3 次 -> 明確拋錯拒絕，不得宣稱成功)
    // ----------------------------------------------------
    await runTestCase('SC2', 'Correction Exhaustion: Fails cleanly and throws error when 3 attempts all fail', async () => {
      let clientCallCount = 0;

      class MockStubbornClient {
        async execute() {
          clientCallCount++;
          // Always return incorrect data
          return { magic_word: "unfixable_bad_output", number_check: 0 };
        }
      }

      cascadingExecutor.clientMap = {
        'nvidia-nim': MockStubbornClient,
        'google': MockStubbornClient,
        'deepseek': MockStubbornClient,
        'vertex-ai': MockStubbornClient
      };

      verificationGate.shouldVerify = () => true;
      verificationGate.verify = async () => {
        return { 
          success: false, 
          reason: "Output stubbornly violated constraints", 
          errorType: "VERIFICATION_CONTENT_FAIL" 
        };
      };

      const failingContext = {
        objective: `Perform strict impossible calculation: ${Date.now()}`,
        constraints: ["Zero tolerance"],
        tags: ["critical"],
        code_context: "// Offline deterministic unit test context - bypasses CLI extraction"
      };

      // 7. 修正耗盡時必須明確失敗，不得回報成功
      await assert.rejects(async () => {
        await cascadingExecutor.execute(failingContext, schema, { preferredTier: 'high', maxRetries: 1 });
      }, (err) => {
        assert.ok(err.message.includes("Model output did not pass verification after 3 self-correction attempts") || err.message.includes("All 1 candidates failed"), "Error message must report exhaustion failure");
        return true;
      }, "Exhausted self-correction MUST reject and throw Error");

      // 初次 1 次 + 自我修正重試 3 次 = 4 次執行
      assert.strictEqual(clientCallCount, 4, 'Client must execute 1 initial + exactly 3 self-correction attempts before exhausting');
    });

  } finally {
    // Clean restore
    cascadingExecutor.clientMap = originalClientMap;
    verificationGate.verify = originalVerify;
    verificationGate.shouldVerify = originalShouldVerify;
  }

  console.log("\n==================================================");
  console.log(`📊 [Self-Correction Results]: ${passedCount} passed, ${failedCount} failed`);
  console.log("==================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAll().catch(err => {
  console.error("❌ Fatal unhandled error in test_self_correction_flow.js:", err);
  process.exit(1);
});
