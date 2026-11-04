/**
 * P1-C3.1 Verification Test Suite
 * Comprehensive verification for RoleAwareContextPlanner and TokenBudgetGuard.
 * 
 * Includes C3.1-TX: Token Estimation Adversarial Test across Traditional Chinese,
 * English, code, symbols, JSON, and SHA-256 hashes.
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
  TokenBudgetError
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
  // Subword approximation:
  // CJK: 1-2 tokens per char
  // English words: 1 token per ~3.5 chars
  // Numbers: 1 token per 2-3 digits
  // Symbols: 1 token each
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
    // doc_synthesizer naturally excludes tests, but BUG_FIX task mandatory requires tests
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

  await testAsync('Planner: Security Invariants - Depth capped at 3 and budget hard clamped', async () => {
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
    assert.strictEqual(plan.maxTokenBudget, 4000, 'Budget must be clamped to maxAllowedBudget');

    // Test extreme value > 32000 rejected by schema
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
      // Missing action and objective
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
    // Lone high surrogate without low surrogate
    const malformed = 'Valid string with lone surrogate: \uD800 and suffix';
    const est = guard.conservativeEstimate(malformed);
    assert.strictEqual(est.verifiable, false);
    assert.strictEqual(est.reason, 'MALFORMED_UTF16_SURROGATE');

    const estimateResult = guard.estimateTokens(malformed);
    assert.strictEqual(estimateResult.verifiable, false);
    assert.ok(estimateResult.error.includes('TOKEN_BUDGET_UNVERIFIABLE'));
  });

  test('BudgetGuard: Exact Tokenizer mode delegates to adapter and handles errors', () => {
    const mockAdapter = {
      countTokens: (text) => 42
    };
    const guard = new TokenBudgetGuard({ tokenizerAdapter: mockAdapter, mode: 'exact' });
    const res = guard.estimateTokens('any string');
    assert.strictEqual(res.verifiable, true);
    assert.strictEqual(res.tokens, 42);
    assert.strictEqual(res.method, 'EXACT_TOKENIZER');

    // Test adapter throwing error
    const faultyAdapter = {
      countTokens: () => { throw new Error('BPE vocab not loaded'); }
    };
    const faultyGuard = new TokenBudgetGuard({ tokenizerAdapter: faultyAdapter, mode: 'exact' });
    const errRes = faultyGuard.estimateTokens('any string');
    assert.strictEqual(errRes.verifiable, false);
    assert.ok(errRes.error.includes('TOKEN_BUDGET_UNVERIFIABLE'));
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
        evidenceValidity: 'VERIFIED'
      }
    ];

    const result = guard.enforceBudget(evidence, 100);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorCode, 'CORE_EVIDENCE_OVER_BUDGET');
    assert.ok(result.notices[0].includes('Fail-Closed: Core target symbol "HugeCoreTarget" requires'));
  });

  test('BudgetGuard: Pruning Ladder Level 1~4 executes deterministically', () => {
    const guard = new TokenBudgetGuard({ hardCapLimit: 300 });
    const evidence = [
      {
        symbol: 'CoreTarget',
        filePath: 'services/target.js',
        lineStart: 1,
        lineEnd: 10,
        snippet: 'function CoreTarget() { return 1; }',
        isCoreTarget: true,
        evidenceValidity: 'VERIFIED',
        depth: 0
      },
      {
        symbol: 'SecondaryCaller',
        filePath: 'services/caller.js',
        lineStart: 1,
        lineEnd: 20,
        snippet: 'function SecondaryCaller() {\n  // line 1\n  // line 2\n  return CoreTarget();\n}',
        isCoreTarget: false,
        evidenceValidity: 'VERIFIED',
        depth: 1
      },
      {
        symbol: 'DistantLeaf',
        filePath: 'services/leaf.js',
        lineStart: 1,
        lineEnd: 30,
        snippet: 'function DistantLeaf() {\n  ' + '// line\n'.repeat(25) + '}',
        isCoreTarget: false,
        evidenceValidity: 'VERIFIED',
        depth: 2
      }
    ];

    const result = guard.enforceBudget(evidence, 300);
    assert.strictEqual(result.success, true);
    assert.ok(result.totalTokens <= 300, `Total tokens (${result.totalTokens}) must be <= 300`);
    assert.ok(result.truncatedItems.length > 0, 'Pruning ladder must record truncated items');
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
        evidenceValidity: 'VERIFIED'
      }
    ];
    const metadata = { planId: 'plan-1234', policy: 'BALANCED_DEFAULT' };
    const result = guard.enforceBudget(evidence, 500, metadata);
    assert.strictEqual(result.success, true);
    // Envelope adds header, metadata, hash label, and markdown formatting
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
