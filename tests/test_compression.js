/**
 * P0-B Step 1: Automated Assertion Test for ContextCompressor
 * 
 * Verifies:
 * 1. Key-Insight Anchoring preserves objective, constraints, task_id, version.
 * 2. Strategic pruning eliminates debug noise (debug_logs, internal_trace, raw_provider_response).
 * 3. Change log summarization keeps only recent 2 entries and creates historical_insights.
 * 4. Hard Truncation fallback protects immutable anchors and flags _warning.
 * 5. CIG Bypass Policy respects integrity flags without touching context.
 * 6. Module contract validation (compression_metadata present with strategy and original_size).
 * 
 * Uses node:assert/strict. Exits with non-zero code on any failure.
 */

const assert = require('node:assert/strict');
const ContextCompressor = require('../infrastructure/adapters/context_compressor');

const compressor = new ContextCompressor();

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

async function runAll() {
  console.log("\n==================================================");
  console.log("🗜️  [P0-B Test Suite] ContextCompressor Assertions");
  console.log("==================================================\n");

  const largeState = {
    task_id: "TASK-ENG-901",
    objective: "Build an interstellar navigation system with zero drift.",
    constraints: ["Must be faster than light", "Must support 1000 crew members", "CommonJS syntax"],
    version: 5,
    code_context: "function warpDrive() { return true; }",
    change_log: [
      { version: 1, changedFields: ["init"] },
      { version: 2, changedFields: ["engine"] },
      { version: 3, changedFields: ["navigation"] },
      { version: 4, changedFields: ["crew_quarters"] },
      { version: 5, changedFields: ["life_support"] }
    ],
    debug_logs: "A".repeat(3000),
    internal_trace: { traceId: "xyz-trace-99", hops: 15, latencyMs: 450 },
    raw_provider_response: "DUMMY_RAW_PROVIDER_PAYLOAD_TO_BE_STRIPPED"
  };

  // CC1: 標準壓縮 (Standard Key-Insight Anchoring)
  await runTestCase('CC1', 'Standard Compression: Preserves anchors and prunes debug noise', async () => {
    const result = await compressor.compress(largeState, { context_window: 500, provider: 'test-suite' });

    // 核心錨點不可遺失
    assert.strictEqual(result.objective, largeState.objective, 'Objective must be bit-exact preserved');
    assert.deepStrictEqual(result.constraints, largeState.constraints, 'Constraints array must be bit-exact preserved');
    assert.strictEqual(result.task_id, "TASK-ENG-901", 'task_id must be preserved');
    assert.strictEqual(result.version, 5, 'version must be preserved');
    assert.strictEqual(result.code_context, largeState.code_context, 'code_context must be preserved');

    // 非必要除錯雜訊必須被剔除
    assert.strictEqual(result.internal_trace, undefined, 'internal_trace must be pruned');
    assert.strictEqual(result.raw_provider_response, undefined, 'raw_provider_response must be pruned');

    // 歷史變更日誌收斂至最新 2 筆
    assert.ok(Array.isArray(result.change_log), 'change_log must remain an array');
    assert.strictEqual(result.change_log.length, 2, 'change_log must be condensed to 2 recent steps');
    assert.ok(Array.isArray(result.historical_insights), 'historical_insights must archive older steps');

    // 契約驗證
    assert.ok(result.compression_metadata, 'compression_metadata must be injected');
    assert.strictEqual(result.compression_metadata.strategy, "Key-Insight Anchoring");
  });

  // CC2: 極限硬截斷 (Hard Truncation Fallback)
  await runTestCase('CC2', 'Hard Truncation: Drops all flexible data to protect anchors under extreme limits', async () => {
    // 給予極小的 token 預算 (100 tokens)
    const result = await compressor.compress(largeState, { context_window: 100, provider: 'test-suite' });

    // 核心錨點依然必須守護
    assert.strictEqual(result.objective, largeState.objective, 'Objective must survive hard truncation');
    assert.deepStrictEqual(result.constraints, largeState.constraints, 'Constraints must survive hard truncation');
    assert.strictEqual(result.task_id, largeState.task_id, 'Task ID must survive hard truncation');

    // 所有可變動彈性資料必須被全數剝離
    assert.strictEqual(result.change_log, undefined, 'change_log must be dropped under hard truncation');
    assert.strictEqual(result.debug_logs, undefined, 'debug_logs must be dropped under hard truncation');

    // 必須標註警告與截斷策略
    assert.strictEqual(result.compression_metadata.strategy, "Hard Truncation (Anchors Only)");
    assert.ok(result._warning && result._warning.includes("Non-critical data lost"), '_warning must alert caller of loss');
  });

  // CC3: 上下文完整性閘門 (CIG Bypass Policy)
  await runTestCase('CC3', 'CIG Integrity Policy: Bypasses compression completely when code refactor policy is set', async () => {
    const protectedState = {
      ...largeState,
      integrity_metadata: {
        policies: {
          bypass_semantic_compression: true,
          bypass_ast_compression: true
        }
      }
    };

    // 即使給予極小預算，CIG 政策也必須禁止壓縮，回傳 100% 原始資料
    const result = await compressor.compress(protectedState, { context_window: 50, provider: 'test-suite' });

    assert.strictEqual(result.debug_logs, largeState.debug_logs, 'Debug logs must NOT be compressed when CIG bypass is set');
    assert.strictEqual(result.change_log.length, 5, 'All 5 change_log steps must be preserved 100%');
    assert.strictEqual(result.compression_metadata, undefined, 'No compression metadata should be generated on bypass');
  });

  // CC4: 安全裕度內免壓縮 (No-op when within safety budget)
  await runTestCase('CC4', 'Within Budget Passthrough: Returns unmodified state when below 85% window limit', async () => {
    const smallState = {
      task_id: "T1",
      objective: "Short text",
      constraints: []
    };

    // 巨大視窗 (1,000,000 tokens)
    const result = await compressor.compress(smallState, { context_window: 1000000, provider: 'test-suite' });
    assert.deepStrictEqual(result, smallState, 'State must be returned completely unmodified');
  });

  console.log("\n==================================================");
  console.log(`📊 [Compression Results]: ${passedCount} passed, ${failedCount} failed`);
  console.log("==================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAll().catch(err => {
  console.error("❌ Fatal unhandled error in test_compression.js:", err);
  process.exit(1);
});
