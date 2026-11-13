/**
 * P1-C3.1 Verification Test Suite
 * Comprehensive verification for RoleAwareContextPlanner and TokenBudgetGuard.
 * 
 * Includes C3.1-TX: Token Estimation Adversarial Test,
 * Three-Mode Tokenizer Contract, Two-Layer Budget Distinction,
 * and Orthogonal Evidence Status Preservation.
 * 
 * Author: etrnya
 */

const assert = require('node:assert');
const {
  RoleAwareContextPlanner,
  CodeGraphSecurityError
} = require('../services/context_planner');
const {
  TokenBudgetGuard,
  TokenBudgetError,
  VERIFIED_BYTE_LEVEL_BPE_PROFILES
} = require('../services/token_budget_guard');
const {
  validateTaskPayload,
  validateRetrievalPlan,
  validateTokenBudgetResult,
  ContextValidationError
} = require('../services/context_schemas');

// Reference Subword / Exact Tokenizer for Adversarial Comparison
function referenceBpeTokenizer(text) {
  if (typeof text !== 'string') return 0;
  let count = 0;
  const cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  count += Math.ceil(cjk * 1.5);

  const symbols = (text.match(/[^a-zA-Z0-9\s\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af\uD800-\uDFFF]/g) || []).length;
  count += symbols;

  const numbers = text.match(/[0-9]+/g) || [];
  for (const n of numbers) {
    count += Math.max(1, Math.ceil(n.length / 2.5));
  }

  const words = text.match(/[a-zA-Z]+/g) || [];
  for (const w of words) {
    count += Math.max(1, Math.ceil(w.length / 3.5));
  }

  const ws = (text.match(/\n+/g) || []).length;
  count += ws;

  return Math.max(1, count);
}

async function runTests() {
  console.log('=== P1-C3.1 Context Planning & Budgeting Verification Suite ===\n');
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(`    ${err.message}`);
      if (err.stack) console.error(err.stack);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(`    ${err.message}`);
      if (err.stack) console.error(err.stack);
      failed++;
    }
  }

  // ==========================================
  // Part 1: RoleAwareContextPlanner Tests
  // ==========================================
  console.log('[Section 1: RoleAwareContextPlanner Tests]');

  await testAsync('Planner: Deterministic policy resolution for Software Architect & Refactor', async () => {
    const planner = new RoleAwareContextPlanner();
    const payload = {
      taskId: 'task-101',
      action: 'REFACTOR',
      objective: 'Refactor TaskManager to use separate queue module',
      targetSymbols: ['TaskManager'],
      targetFiles: ['services/task_manager.js']
    };
    const plan = await planner.plan('software_architect', payload);
    assert.strictEqual(plan.policyName, 'ARCH_REFACTOR');
    assert.strictEqual(plan.traversalDepth, 2);
    assert.strictEqual(plan.traversalDirection, 'bidirectional');
    assert.strictEqual(plan.includeAffectedTests, true);
    assert.strictEqual(plan.foldImplementations, true);
    assert.strictEqual(plan.maxTokenBudget, 3000);
    assert.doesNotThrow(() => validateRetrievalPlan(plan));
  });

  await testAsync('Planner: Deterministic policy resolution for Code Reviewer & Bug Fix', async () => {
    const planner = new RoleAwareContextPlanner();
    const payload = {
      taskId: 'task-102',
      action: 'BUG_FIX',
      objective: 'Fix concurrency leak in submitTask',
      targetSymbols: ['TaskManager.submitTask'],
      targetFiles: ['services/task_manager.js']
    };
    const plan = await planner.plan('code_reviewer', payload);
    assert.strictEqual(plan.policyName, 'REVIEW_BUGFIX');
    assert.strictEqual(plan.traversalDepth, 2);
    assert.strictEqual(plan.traversalDirection, 'incoming');
    assert.strictEqual(plan.includeAffectedTests, true);
    assert.strictEqual(plan.foldImplementations, false);
  });

  await testAsync('Planner: Deterministic policy resolution for Documentation & Synthesizer', async () => {
    const planner = new RoleAwareContextPlanner();
    const payload = {
      taskId: 'task-103',
      action: 'DOCUMENTATION',
      objective: 'Generate API docs for CodeGraphAdapter',
      targetSymbols: ['CodeGraphAdapter'],
      targetFiles: ['infrastructure/adapters/codegraph_adapter.js']
    };
    const plan = await planner.plan('doc_synthesizer', payload);
    assert.strictEqual(plan.policyName, 'DOCS_INTERFACES');
    assert.strictEqual(plan.traversalDepth, 1);
    assert.strictEqual(plan.traversalDirection, 'outgoing');
    assert.strictEqual(plan.includeAffectedTests, false);
    assert.strictEqual(plan.foldImplementations, true);
  });

  await testAsync('Planner: Tier 2 overrides Tier 3 (Doc Synthesizer on BUG_FIX must include tests)', async () => {
    const planner = new RoleAwareContextPlanner();
    const payload = {
      taskId: 'task-104',
      action: 'BUG_FIX',
      objective: 'Fix null pointer in error mapper',
      targetSymbols: ['ErrorMapper.map'],
      targetFiles: ['infrastructure/adapters/error_mapper.js']
    };
    const plan = await planner.plan('doc_synthesizer', payload);
    assert.strictEqual(plan.includeAffectedTests, true, 'Tier 2 Task requirement must override Tier 3 role preference');
  });

  await testAsync('Planner: Security Invariants - Rejects path traversal and absolute paths', async () => {
    const planner = new RoleAwareContextPlanner();
    const maliciousPayload1 = {
      taskId: 'task-sec-1',
      action: 'SECURITY_AUDIT',
      objective: 'Audit secret file',
      targetSymbols: ['root'],
      targetFiles: ['../../.env']
    };
    await assert.rejects(
      async () => await planner.plan('default', maliciousPayload1),
      (err) => err instanceof CodeGraphSecurityError && err.code === 'PATH_TRAVERSAL_DETECTED'
    );

    const maliciousPayload2 = {
      taskId: 'task-sec-2',
      action: 'SECURITY_AUDIT',
      objective: 'Audit windows absolute path',
      targetSymbols: ['root'],
      targetFiles: ['C:/Windows/System32/cmd.exe']
    };
    await assert.rejects(
      async () => await planner.plan('default', maliciousPayload2),
      (err) => err instanceof CodeGraphSecurityError && err.code === 'ABSOLUTE_PATH_PROHIBITED'
    );
  });

  await testAsync('Planner: Two-layer budget distinction - Planner planned vs Guard physical hard cap', async () => {
    // Layer 1 (Planner): maxAllowedBudget configured to 4000 clamps requested 5500 to 4000
    const planner = new RoleAwareContextPlanner({ defaultMaxTokens: 3000, maxAllowedBudget: 4000 });
    const payload = {
      taskId: 'task-105',
      action: 'SECURITY_AUDIT',
      objective: 'Deep security scan',
      targetSymbols: ['server'],
      targetFiles: ['server.js'],
      maxExecutionTokens: 5500 // Requests 5500, but planner maxAllowedBudget is 4000
    };
    const plan = await planner.plan('code_reviewer', payload);
    assert.strictEqual(plan.traversalDepth, 3, 'Depth must be capped at 3');
    assert.strictEqual(plan.maxTokenBudget, 4000, 'Planned budget must be clamped to planner maxAllowedBudget');

    // Layer 2 (Guard): Even if planner planned 4000, TokenBudgetGuard physically clamps to 3000
    const guard = new TokenBudgetGuard({ hardCapLimit: 3000 });
    const guardResult = guard.enforceBudget([], plan.maxTokenBudget);
    assert.strictEqual(guardResult.hardCapLimit, 3000, 'Guard physical hard cap strictly limits to 3000 regardless of planner 4000');

    // Extreme value > 32000 rejected by schema
    const extremePayload = { ...payload, maxExecutionTokens: 99999 };
    await assert.rejects(
      async () => await planner.plan('code_reviewer', extremePayload),
      (err) => err instanceof ContextValidationError
    );
  });

  await testAsync('Planner: Schema Validation - Rejects missing required fields', async () => {
    const planner = new RoleAwareContextPlanner();
    const invalidPayload = {
      taskId: 'task-inv-1',
      targetSymbols: ['foo'],
      targetFiles: ['foo.js']
    };
    await assert.rejects(
      async () => await planner.plan('default', invalidPayload),
      (err) => err instanceof ContextValidationError
    );
  });

  // ==========================================
  // Part 2: TokenBudgetGuard & C3.1-TX Tests
  // ==========================================
  console.log('\n[Section 2: TokenBudgetGuard & Adversarial Estimation Tests]');

  test('C3.1-TX: Adversarial - Traditional Chinese upper bound verification', () => {
    const guard = new TokenBudgetGuard();
    const tcText = '這是一個用於驗證 Token 預算防禦機制的繁體中文測試字串，包含複雜詞彙與專業領域知識。';
    const exact = referenceBpeTokenizer(tcText);
    const est = guard.conservativeEstimate(tcText);

    assert.strictEqual(est.verifiable, true);
    assert.ok(
      est.tokens >= exact,
      `Conservative estimate (${est.tokens}) must be >= exact BPE (${exact})`
    );
  });

  test('C3.1-TX: Adversarial - English & Code Keywords upper bound verification', () => {
    const guard = new TokenBudgetGuard();
    const codeText = `export async function handleAsyncPayloadExecution(req, res, next) {
  const { timeout, retryLimit, targetUrl } = req.body;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'INVALID_URL' });
  }
}`;
    const exact = referenceBpeTokenizer(codeText);
    const est = guard.conservativeEstimate(codeText);

    assert.strictEqual(est.verifiable, true);
    assert.ok(
      est.tokens >= exact,
      `Conservative estimate (${est.tokens}) must be >= exact BPE (${exact})`
    );
  });

  test('C3.1-TX: Adversarial - Mixed Language upper bound verification', () => {
    const guard = new TokenBudgetGuard();
    const mixedText = '當執行 `syncIndex()` 時，系統必須對 SQLite AST 資料庫進行 SHA-256 快照比對與 Mutex 鎖定，耗時大約 250ms。';
    const exact = referenceBpeTokenizer(mixedText);
    const est = guard.conservativeEstimate(mixedText);

    assert.strictEqual(est.verifiable, true);
    assert.ok(
      est.tokens >= exact,
      `Conservative estimate (${est.tokens}) must be >= exact BPE (${exact})`
    );
  });

  test('C3.1-TX: Adversarial - Special Symbols & Delimiters upper bound verification', () => {
    const guard = new TokenBudgetGuard();
    const symbolsText = `<!-- [CDATA[ <!DOCTYPE html> <div class="container" id="main_#12"> ? & % $ # @ ! / \\ | { } [ ] ~ \` ]] -->`;
    const exact = referenceBpeTokenizer(symbolsText);
    const est = guard.conservativeEstimate(symbolsText);

    assert.strictEqual(est.verifiable, true);
    assert.ok(
      est.tokens >= exact,
      `Conservative estimate (${est.tokens}) must be >= exact BPE (${exact})`
    );
  });

  test('C3.1-TX: Adversarial - JSON Payload upper bound verification', () => {
    const guard = new TokenBudgetGuard();
    const jsonText = JSON.stringify({
      taskId: 'task-test-99',
      action: 'BUG_FIX',
      targetSymbols: ['TaskManager.submitTask', 'Router.dispatch'],
      metadata: { priority: 1, retries: 3, debugMode: false }
    }, null, 2);
    const exact = referenceBpeTokenizer(jsonText);
    const est = guard.conservativeEstimate(jsonText);

    assert.strictEqual(est.verifiable, true);
    assert.ok(
      est.tokens >= exact,
      `Conservative estimate (${est.tokens}) must be >= exact BPE (${exact})`
    );
  });

  test('C3.1-TX: Adversarial - Long Hex Hashes upper bound verification', () => {
    const guard = new TokenBudgetGuard();
    const hashText = 'FullFileSha256: 8cdf4627b0b691d1f0438a2e5871f7a0e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const exact = referenceBpeTokenizer(hashText);
    const est = guard.conservativeEstimate(hashText);

    assert.strictEqual(est.verifiable, true);
    assert.ok(
      est.tokens >= exact,
      `Conservative estimate (${est.tokens}) must be >= exact BPE (${exact})`
    );
  });

  test('C3.1-TX: Adversarial - Malformed Surrogates return unverifiable result', () => {
    const guard = new TokenBudgetGuard();
    const malformed = 'Valid string with lone surrogate: \uD800 and suffix';
    const est = guard.conservativeEstimate(malformed);
    assert.strictEqual(est.verifiable, false);
    assert.strictEqual(est.reason, 'MALFORMED_UTF16_SURROGATE');

    const estimateResult = guard.estimateTokens(malformed);
    assert.strictEqual(estimateResult.verifiable, false);
    assert.strictEqual(estimateResult.errorCode, 'TOKEN_BUDGET_UNVERIFIABLE');
  });

  test('BudgetGuard Mode A: Exact Tokenizer mode delegates to adapter and fails closed on error', () => {
    const mockAdapter = {
      countTokens: (text) => 42
    };
    const guard = new TokenBudgetGuard({ tokenizerAdapter: mockAdapter, mode: 'exact' });
    const res = guard.estimateTokens('any string');
    assert.strictEqual(res.verifiable, true);
    assert.strictEqual(res.tokens, 42);
    assert.strictEqual(res.method, 'EXACT_TOKENIZER');

    // Test adapter throwing error -> FAIL-CLOSED (never falls back to unverified estimator)
    const faultyAdapter = {
      countTokens: () => { throw new Error('BPE vocab not loaded'); }
    };
    const faultyGuard = new TokenBudgetGuard({ tokenizerAdapter: faultyAdapter, mode: 'exact' });
    const errRes = faultyGuard.estimateTokens('any string');
    assert.strictEqual(errRes.verifiable, false);
    assert.strictEqual(errRes.errorCode, 'TOKEN_BUDGET_UNVERIFIABLE');
    assert.ok(errRes.error.includes('TOKEN_BUDGET_UNVERIFIABLE'));
  });

  test('BudgetGuard Mode B: Verified Byte-Level BPE Upper Bound with Framing Reserve', () => {
    const guard = new TokenBudgetGuard({
      mode: 'byte_level_bpe_upper_bound',
      tokenizerProfile: 'TIKTOKEN_CL100K',
      framingReserveTokens: 30
    });
    const sample = 'function test() { return 1; }';
    const expectedByteLength = Buffer.byteLength(sample, 'utf8');
    const res = guard.estimateTokens(sample);

    assert.strictEqual(res.verifiable, true);
    assert.strictEqual(res.method, 'BYTE_LEVEL_BPE_THEORETICAL_UPPER_BOUND');
    assert.strictEqual(res.byteLength, expectedByteLength);
    assert.strictEqual(res.tokens, expectedByteLength + 30);
  });

  test('BudgetGuard Mode C: Unverified tokenizer profile returns TOKEN_BUDGET_UNVERIFIABLE (Fail-Closed)', () => {
    const guard = new TokenBudgetGuard({
      mode: 'byte_level_bpe_upper_bound',
      tokenizerProfile: 'CLAUDE_UNKNOWN_PROPRIETARY' // Not in verified whitelist
    });
    const res = guard.estimateTokens('sample text');
    assert.strictEqual(res.verifiable, false);
    assert.strictEqual(res.errorCode, 'TOKEN_BUDGET_UNVERIFIABLE');
    assert.ok(res.error.includes('is not verified for byte-level BPE bounds'));
  });

  test('BudgetGuard: Core Evidence Over-Budget returns CORE_EVIDENCE_OVER_BUDGET (Fail-Closed)', () => {
    const guard = new TokenBudgetGuard({ hardCapLimit: 100 });
    const hugeCoreSnippet = 'const largeCode = ' + 'x'.repeat(1200) + ';';
    const evidence = [
      {
        symbol: 'HugeCoreTarget',
        filePath: 'services/huge.js',
        lineStart: 1,
        lineEnd: 50,
        snippet: hugeCoreSnippet,
        isCoreTarget: true,
        validationStatus: 'VERIFIED',
        contentCompleteness: 'FULL',
        sourceSnippetSha256: 'a'.repeat(64)
      }
    ];

    const result = guard.enforceBudget(evidence, 100);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorCode, 'CORE_EVIDENCE_OVER_BUDGET');
    assert.ok(result.notices[0].includes('Fail-Closed: Core target symbol "HugeCoreTarget" requires'));
  });

  test('BudgetGuard: Pruning Ladder Level 1~4 updates orthogonal status and full 64-char Hash', () => {
    const originalHash = 'b'.repeat(64);
    const guard = new TokenBudgetGuard({ hardCapLimit: 850 });
    const evidence = [
      {
        symbol: 'CoreTarget',
        filePath: 'services/target.js',
        lineStart: 1,
        lineEnd: 10,
        snippet: 'function CoreTarget() { return 1; }',
        isCoreTarget: true,
        validationStatus: 'VERIFIED',
        sourceSnippetSha256: originalHash,
        depth: 0
      },
      {
        symbol: 'SecondaryCaller',
        filePath: 'services/caller.js',
        lineStart: 1,
        lineEnd: 20,
        snippet: 'function SecondaryCaller() {\n  // line 1\n  // line 2\n  return CoreTarget();\n}',
        isCoreTarget: false,
        validationStatus: 'VERIFIED',
        sourceSnippetSha256: 'c'.repeat(64),
        depth: 1
      },
      {
        symbol: 'DistantLeaf',
        filePath: 'services/leaf.js',
        lineStart: 1,
        lineEnd: 30,
        snippet: 'function DistantLeaf() {\n  ' + '// line\n'.repeat(25) + '}',
        isCoreTarget: false,
        validationStatus: 'VERIFIED',
        sourceSnippetSha256: 'd'.repeat(64),
        depth: 2
      }
    ];

    const result = guard.enforceBudget(evidence, 850);
    assert.strictEqual(result.success, true);
    assert.ok(result.totalTokens <= 850, `Total tokens (${result.totalTokens}) must be <= 850`);
    assert.ok(result.truncatedItems.length > 0, 'Pruning ladder must record truncated items');

    // Orthogonal status checks on pruned items
    const coreItem = result.retainedItems.find(i => i.isCoreTarget);
    assert.strictEqual(coreItem.contentCompleteness, 'FULL');
    assert.strictEqual(coreItem.isTruncated, false);
    assert.strictEqual(coreItem.sourceSnippetSha256, originalHash, 'Source hash must NEVER be overwritten');
    assert.strictEqual(coreItem.emittedContentSha256.length, 64, 'emittedContentSha256 must be full 64-char hex');

    // Check pruned item has contentCompleteness = PARTIAL and isTruncated = true
    const prunedItem = result.retainedItems.find(i => i.symbol === 'DistantLeaf');
    assert.ok(prunedItem, 'DistantLeaf should be retained in Level 1 pruning');
    assert.strictEqual(prunedItem.contentCompleteness, 'PARTIAL');
    assert.strictEqual(prunedItem.isTruncated, true);
    assert.strictEqual(prunedItem.emittedContentSha256.length, 64);

    assert.doesNotThrow(() => validateTokenBudgetResult(result));
  });

  test('BudgetGuard: Final context measures metadata and wrapping envelope', () => {
    const guard = new TokenBudgetGuard({ hardCapLimit: 500 });
    const evidence = [
      {
        symbol: 'SimpleFn',
        filePath: 'utils/helper.js',
        lineStart: 1,
        lineEnd: 5,
        snippet: 'function helper() { return true; }',
        isCoreTarget: true,
        validationStatus: 'VERIFIED',
        sourceSnippetSha256: 'e'.repeat(64)
      }
    ];
    const metadata = { planId: 'plan-1234', policy: 'BALANCED_DEFAULT' };
    const result = guard.enforceBudget(evidence, 500, metadata);
    assert.strictEqual(result.success, true);
    assert.ok(result.totalTokens > 15, 'Serialized context must account for wrapper tokens');
  });

  // Summary
  console.log(`\n======================================================`);
  console.log(`P1-C3.1 Test Execution Complete: ${passed} Passed, ${failed} Failed`);
  console.log(`======================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Unhandled test suite failure:', err);
  process.exit(1);
});
