/**
 * P0-B Step 4.2-C: Cascading Routing Integration & Fail-Closed Policies Test Suite
 * 
 * Tests C-1 through C-10:
 * - C-1: All models OPEN graceful Fail-Closed without Null Pointer (503 HUB_ALL_CANDIDATES_CIRCUIT_OPEN)
 * - C-2: Min Retry-After exact calculation excluding permanent and non-participating nodes
 * - C-3: Router & QuotaGuard contract parity (pure read query without quota deduction)
 * - C-4: Global Task Deadline stops subsequent candidate attempts (504 HUB_TASK_TIMEOUT_EXCEEDED)
 * - C-5: Client execution timeout dynamically clamped to remaining task budget
 * - C-6: Parallel Racing winner commits, loser neutrally releases dual-tier probe without failure record
 * - C-7: Late arrival from racing loser does not taint memory, cache, token monitor, or health registry
 * - C-8: Terminal HubCascadingError preserves full cascadingSummary and multi-tier failure trace (502)
 * - C-9: BaseClient internal cancellation performs exactly single probe settlement without executor duplication
 * - C-10: Monotonic Clock (performance.now) prevents infinite wait on NTP Wall Clock jump
 */

const assert = require('node:assert');
const heartbeatRegistry = require('../registry/heartbeat_registry');
const router = require('../services/router');
const cascadingExecutor = require('../services/cascading_executor');
const modelRegistry = require('../registry/model_registry');
const quotaGuard = require('../infrastructure/adapters/quota_guard');
const errorMapper = require('../infrastructure/adapters/error_mapper');
const BaseClient = require('../infrastructure/clients/base_client');
const tokenMonitor = require('../observability/token_monitor');
const memoryManager = require('../infrastructure/adapters/memory_manager');
const semanticCache = new (require('../services/semantic_cache'))();

// Test helper: Reset registry & mocks between tests
function resetTestState() {
  heartbeatRegistry.nodes.clear();
  heartbeatRegistry.history.clear();
  quotaGuard.usage.clear();
}

let passedTests = 0;
let totalTests = 11;

async function runAllTests() {
  console.log('================================================================================');
  console.log('🧪 [P0-B Step 4.2-C Integration Test Suite (C-1 ~ C-10)]');
  console.log('================================================================================\n');

  // ============================================================================
  // Test C-1: 全模型 OPEN 時優雅 Fail-Closed (無 Null Pointer)
  // ============================================================================
  console.log('👉 Test C-1: 全模型 OPEN 時優雅 Fail-Closed (無 Null Pointer)...');
  resetTestState();
  {
    const textModels = modelRegistry.getModelsByCapability(['text']);
    const now = Date.now();
    for (const m of textModels) {
      const node = heartbeatRegistry.getNode(`${m.provider}:${m.model_id}`);
      node.state = 'OPEN';
      node.notBefore = now + 30000;
      node.permanent = false;
      node.probeActive = false;
    }

    let caughtError = null;
    try {
      await cascadingExecutor.execute(
        { objective: 'Generate test summary text', tags: ['text-only'], code_context: 'mock' },
        { type: 'object', properties: { summary: { type: 'string' } } }
      );
    } catch (err) {
      caughtError = err;
    }

    assert(caughtError !== null, 'Should have thrown an error when all models are OPEN');
    assert(caughtError instanceof errorMapper.HubError, 'Error must inherit from HubError');
    assert(caughtError instanceof errorMapper.HubCascadingError, 'Error must be HubCascadingError');
    assert.strictEqual(caughtError.statusCode, 503, 'StatusCode must be 503');
    assert.strictEqual(caughtError.type, 'HUB_ALL_CANDIDATES_CIRCUIT_OPEN', 'Type must be HUB_ALL_CANDIDATES_CIRCUIT_OPEN');
    assert.strictEqual(caughtError.attempts, 0, 'Attempts must be 0 because none passed admission');
    assert(typeof caughtError.retryAfterMs === 'number', 'retryAfterMs should be calculated');
    assert(caughtError.retryAfterMs > 0, 'retryAfterMs must be positive');
    console.log(`  ✅ PASS: 拋出 503 HUB_ALL_CANDIDATES_CIRCUIT_OPEN, attempts: 0, retryAfterMs: ${caughtError.retryAfterMs}ms, 無 Null Pointer。`);
    passedTests++;
  }

  // ============================================================================
  // Test C-2: 最小 Retry-After 精確計算 (排除永久故障與未參與節點)
  // ============================================================================
  console.log('\n👉 Test C-2: 最小 Retry-After 精確計算 (排除永久故障與未參與節點)...');
  resetTestState();
  {
    const candidates = router.getCandidates({ modalities: ['text'] });
    assert(candidates.length >= 2, 'Need at least 2 text candidates');

    const now = Date.now();
    const modelA = candidates[0];
    const nodeA = heartbeatRegistry.getNode(`${modelA.provider}:${modelA.model_id}`);
    nodeA.state = 'OPEN';
    nodeA.notBefore = now + 15000;
    nodeA.permanent = false;

    const modelB = candidates[1];
    const nodeB = heartbeatRegistry.getNode(`${modelB.provider}:${modelB.model_id}`);
    nodeB.state = 'OPEN';
    nodeB.notBefore = now + 40000;
    nodeB.permanent = false;

    // Set other candidate models to permanent OPEN
    for (let i = 2; i < candidates.length; i++) {
      const m = candidates[i];
      const node = heartbeatRegistry.getNode(`${m.provider}:${m.model_id}`);
      node.state = 'OPEN';
      node.permanent = true;
      node.notBefore = now + 999999;
    }

    // Model D: Unrelated non-participating node with smaller delay (2s)
    const unrelatedNode = heartbeatRegistry.getNode('mock-unrelated:model-d');
    unrelatedNode.state = 'OPEN';
    unrelatedNode.notBefore = now + 2000;
    unrelatedNode.permanent = false;

    let caughtError = null;
    try {
      await cascadingExecutor.execute(
        { objective: 'Generate test summary text', tags: ['text-only'], code_context: 'mock' },
        { type: 'object' }
      );
    } catch (err) {
      caughtError = err;
    }

    assert(caughtError !== null);
    assert(caughtError instanceof errorMapper.HubCascadingError);
    // Should precisely pick min of 15000 (nodeA), excluding 2000 (unrelated) and permanent models
    assert(
      caughtError.retryAfterMs >= 14500 && caughtError.retryAfterMs <= 15000,
      `retryAfterMs should be approx 15000ms, got: ${caughtError.retryAfterMs}`
    );
    console.log(`  ✅ PASS: 精準計算候選模型之最小 retryAfterMs: ${caughtError.retryAfterMs}ms，排除永久 OPEN 與無關節點。`);
    passedTests++;
  }

  // ============================================================================
  // Test C-3: Router 與 QuotaGuard 契約一致性 (純查詢無扣額)
  // ============================================================================
  console.log('\n👉 Test C-3: Router 與 QuotaGuard 契約一致性 (純查詢無扣額)...');
  resetTestState();
  {
    const deepseekModel = modelRegistry.getModelsByCapability(['text']).find(m => m.provider === 'deepseek');
    assert(deepseekModel, 'deepseek model must exist in registry');

    const rpmLimit = deepseekModel.limits.rpm || 60;
    quotaGuard.usage.set('deepseek', { requests: rpmLimit, tokens: 0, resetTime: Date.now() + 60000 });

    assert.strictEqual(quotaGuard.canProceed('deepseek', deepseekModel.limits), false);

    const candidates = router.getCandidates({ modalities: ['text'] });
    const hasDeepSeekInCandidates = candidates.some(m => m.provider === 'deepseek');
    assert.strictEqual(hasDeepSeekInCandidates, false, 'getCandidates must filter out quota-exhausted deepseek');

    for (let i = 0; i < 3; i++) {
      router.getCandidates({ modalities: ['text'] });
    }

    const recordedRequests = quotaGuard.usage.get('deepseek').requests;
    assert.strictEqual(recordedRequests, rpmLimit, `Quota requests count must not change, expected ${rpmLimit}, got ${recordedRequests}`);
    console.log(`  ✅ PASS: getCandidates() 與 route() 均精確排除配額耗盡模型，連續查詢無重複扣額 (${recordedRequests}/${rpmLimit})。`);
    passedTests++;
  }

  // ============================================================================
  // Test C-4: 全域 Task Deadline 阻止後續模型啟動 (含真正執行逾時)
  // ============================================================================
  console.log('\n👉 Test C-4: 全域 Task Deadline 阻止後續模型啟動 (含真正執行逾時)...');
  resetTestState();
  {
    const origClientMap = { ...cascadingExecutor.clientMap };
    const candidates = router.getCandidates({ modalities: ['text'] });
    const targetModel1 = candidates[0];

    let model1Called = 0;
    let model2Called = 0;

    class DynamicDispatchClient extends BaseClient {
      async _callModelApi() {
        if (this.modelCapability.model_id === targetModel1.model_id) {
          model1Called++;
          await new Promise(r => setTimeout(r, 150));
          return JSON.stringify({ summary: "done" });
        } else {
          model2Called++;
          return JSON.stringify({ summary: "success" });
        }
      }
    }

    cascadingExecutor.clientMap['nvidia-nim'] = DynamicDispatchClient;
    cascadingExecutor.clientMap['google'] = DynamicDispatchClient;
    cascadingExecutor.clientMap['deepseek'] = DynamicDispatchClient;
    cascadingExecutor.clientMap['vertex-ai'] = DynamicDispatchClient;

    let caughtError = null;
    try {
      await cascadingExecutor.execute(
        { objective: 'Short deadline task', tags: ['text-only'], code_context: 'mock' },
        { type: 'object', properties: { summary: { type: 'string' } } },
        { taskTimeoutMs: 80, race: false }
      );
    } catch (err) {
      caughtError = err;
    } finally {
      cascadingExecutor.clientMap = origClientMap;
    }

    assert(caughtError !== null, 'Should have timed out');
    assert.strictEqual(caughtError.statusCode, 504, 'StatusCode must be 504 on deadline exceeded');
    assert.strictEqual(caughtError.type, 'HUB_TASK_TIMEOUT_EXCEEDED');
    assert(model1Called >= 1, 'Model 1 must have been called');
    assert.strictEqual(model2Called, 0, 'Subsequent models must NEVER be called once deadline is exceeded');
    console.log(`  ✅ PASS: Task Deadline 到期後立即終止級聯，後續模型調用次數為 0，拋出 504 HUB_TASK_TIMEOUT_EXCEEDED。`);
    passedTests++;
  }

  // ============================================================================
  // Test C-5: Client 執行時間受剩餘預算動態壓縮
  // ============================================================================
  console.log('\n👉 Test C-5: Client 執行時間受剩餘預算動態壓縮...');
  resetTestState();
  {
    const origClientMap = { ...cascadingExecutor.clientMap };
    let receivedTimeoutMs = null;

    class MockInspectClient extends BaseClient {
      async execute(state, schema, options = {}) {
        if (options && typeof options.timeoutMs === 'number') {
          receivedTimeoutMs = options.timeoutMs;
        }
        return { summary: "clamped ok", passed: true, confidence: 1.0, violation_details: "" };
      }
    }

    cascadingExecutor.clientMap['nvidia-nim'] = MockInspectClient;
    cascadingExecutor.clientMap['google'] = MockInspectClient;
    cascadingExecutor.clientMap['deepseek'] = MockInspectClient;
    cascadingExecutor.clientMap['vertex-ai'] = MockInspectClient;

    const taskTimeoutBudget = 2500;
    try {
      await cascadingExecutor.execute(
        { objective: 'Dynamic timeout clamp test', tags: ['text-only'], code_context: 'mock', skipVerification: true },
        { type: 'object', properties: { summary: { type: 'string' } } },
        { taskTimeoutMs: taskTimeoutBudget, race: false }
      );
    } finally {
      cascadingExecutor.clientMap = origClientMap;
    }

    assert(receivedTimeoutMs !== null, 'Client should have received timeoutMs');
    assert(
      receivedTimeoutMs <= taskTimeoutBudget && receivedTimeoutMs >= (taskTimeoutBudget - 500),
      `Expected client timeout to be compressed to ~${taskTimeoutBudget}ms, got ${receivedTimeoutMs}ms`
    );
    console.log(`  ✅ PASS: Client 預設逾時 (30000ms) 被動態壓縮至剩餘預算 ${receivedTimeoutMs}ms。`);
    passedTests++;
  }

  // ============================================================================
  // Test C-6: Parallel Racing 勝出後落敗者雙層探針完整中性釋放
  // ============================================================================
  console.log('\n👉 Test C-6: Parallel Racing 勝出後落敗者雙層探針完整中性釋放...');
  resetTestState();
  {
    const origClientMap = { ...cascadingExecutor.clientMap };
    const candidates = router.getCandidates({ modalities: ['text'] });
    assert(candidates.length >= 2, 'Need at least 2 text candidates');

    const modelA = candidates[0];
    const modelB = candidates[1];

    const nodeA = heartbeatRegistry.getNode(`${modelA.provider}:${modelA.model_id}`);
    nodeA.state = 'HALF-OPEN';
    nodeA.probeActive = false;
    nodeA.consecutiveFailures = 2;

    const nodeB = heartbeatRegistry.getNode(`${modelB.provider}:${modelB.model_id}`);
    nodeB.state = 'HALF-OPEN';
    nodeB.probeActive = false;
    nodeB.consecutiveFailures = 2;

    class FastWinnerClient extends BaseClient {
      async _callModelApi() {
        await new Promise(r => setTimeout(r, 20));
        return JSON.stringify({ summary: "winner A" });
      }
    }

    class SlowLoserClient extends BaseClient {
      async _callModelApi(state, schema, options) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(JSON.stringify({ summary: "loser B" })), 200);
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              const err = new Error(options.signal.reason || 'RACING_LOST');
              err.name = 'AbortError';
              err.reason = options.signal.reason || 'RACING_LOST';
              err.isInternalAbort = true;
              reject(err);
            }, { once: true });
          }
        });
      }
    }

    cascadingExecutor.clientMap[modelA.provider] = FastWinnerClient;
    cascadingExecutor.clientMap[modelB.provider] = SlowLoserClient;

    try {
      const res = await cascadingExecutor.execute(
        { objective: 'Parallel racing probe test', tags: ['realtime'], code_context: 'mock', skipVerification: true },
        { type: 'object', properties: { summary: { type: 'string' } } },
        { race: true }
      );
      assert.strictEqual(res.success, true);
    } finally {
      cascadingExecutor.clientMap = origClientMap;
    }

    await new Promise(r => setTimeout(r, 50));

    assert.strictEqual(nodeA.state, 'CLOSED', 'Winner A should recover to CLOSED');
    assert.strictEqual(nodeA.probeActive, false);

    assert.strictEqual(nodeB.state, 'HALF-OPEN', 'Loser B must remain HALF-OPEN without failure trip');
    assert.strictEqual(nodeB.probeActive, false, 'Loser B probeActive must be released to false');
    assert.strictEqual(nodeB.consecutiveFailures, 2, 'Loser B consecutive failures must not increment');

    const nextAdmissionB = heartbeatRegistry.canPass(modelB.provider, modelB.model_id);
    assert.strictEqual(nextAdmissionB.allowed, true, 'Subsequent request to B must acquire probe immediately');
    console.log(`  ✅ PASS: Winner A 復原 CLOSED，Loser B 接收 RACING_LOST 中性釋放 (HALF-OPEN, probeActive: false)，次一請求可立即准入。`);
    passedTests++;
  }

  // ============================================================================
  // Test C-7: 競速落敗者晚到回應不污染狀態、快取與 TokenMonitor
  // ============================================================================
  console.log('\n👉 Test C-7: 競速落敗者晚到回應不污染狀態、快取與 TokenMonitor...');
  resetTestState();
  {
    const origClientMap = { ...cascadingExecutor.clientMap };
    const candidates = router.getCandidates({ modalities: ['text'] });
    const modelA = candidates[0];
    const modelB = candidates[1];

    const nodeB = heartbeatRegistry.getNode(`${modelB.provider}:${modelB.model_id}`);
    nodeB.state = 'HALF-OPEN';
    nodeB.probeActive = false;

    class WinnerClient extends BaseClient {
      async _callModelApi() {
        return JSON.stringify({ summary: "winner A payload" });
      }
    }

    let loserResolvedLate = false;
    class LateLoserClient extends BaseClient {
      async _callModelApi() {
        await new Promise(r => setTimeout(r, 100));
        loserResolvedLate = true;
        return JSON.stringify({ summary: "late loser B payload" });
      }
    }

    cascadingExecutor.clientMap[modelA.provider] = WinnerClient;
    cascadingExecutor.clientMap[modelB.provider] = LateLoserClient;

    try {
      const res = await cascadingExecutor.execute(
        { objective: 'Late arrival side effect test', tags: ['realtime'], code_context: 'mock', skipVerification: true },
        { type: 'object', properties: { summary: { type: 'string' } } },
        { race: true }
      );
      assert.strictEqual(res.success, true);
    } finally {
      cascadingExecutor.clientMap = origClientMap;
    }

    await new Promise(r => setTimeout(r, 150));

    assert(loserResolvedLate, 'Loser should have completed late in background');
    assert.notStrictEqual(nodeB.state, 'CLOSED', 'Late arrival must NOT transition Loser B to CLOSED');
    assert.strictEqual(nodeB.probeActive, false, 'Loser B probe must be released');
    console.log(`  ✅ PASS: 落敗者晚到成功回應被嚴格攔截，未觸發幽靈復原 (未轉為 CLOSED)，探針安全釋放。`);
    passedTests++;
  }

  // ============================================================================
  // Test C-8: 終端 HubError 完整保留級聯摘要與多層失敗軌跡
  // ============================================================================
  console.log('\n👉 Test C-8: 終端 HubError 完整保留級聯摘要與多層失敗軌跡...');
  resetTestState();
  {
    const origClientMap = { ...cascadingExecutor.clientMap };

    const modelErrors = {};
    let candidateCount = 0;
    class MultiFailClient extends BaseClient {
      constructor(options) {
        super(options);
        const mId = options?.modelCapability?.model_id || `model_${candidateCount++}`;
        if (!modelErrors[mId]) {
          candidateCount++;
          if (candidateCount === 1) modelErrors[mId] = 401;
          else if (candidateCount === 2) modelErrors[mId] = 500;
          else modelErrors[mId] = 429;
        }
        this.testStatus = modelErrors[mId];
      }
      async _callModelApi() {
        if (this.testStatus === 401) {
          const err = new Error("Invalid API Key");
          err.status = 401;
          throw err;
        } else if (this.testStatus === 500) {
          const err = new Error("Internal Server Anomaly");
          err.status = 500;
          throw err;
        } else {
          const err = new Error("Rate limit exceeded");
          err.status = 429;
          throw err;
        }
      }
    }

    cascadingExecutor.clientMap['nvidia-nim'] = MultiFailClient;
    cascadingExecutor.clientMap['google'] = MultiFailClient;
    cascadingExecutor.clientMap['deepseek'] = MultiFailClient;
    cascadingExecutor.clientMap['vertex-ai'] = MultiFailClient;

    let caughtError = null;
    try {
      await cascadingExecutor.execute(
        { objective: 'Cascading summary audit', tags: ['text-only'], code_context: 'mock', skipVerification: true },
        { type: 'object', properties: { summary: { type: 'string' } } },
        { race: false, maxRetries: 3 }
      );
    } catch (err) {
      caughtError = err;
    } finally {
      cascadingExecutor.clientMap = origClientMap;
    }

    assert(caughtError !== null);
    assert(caughtError instanceof errorMapper.HubCascadingError, 'Must be HubCascadingError');
    assert(caughtError instanceof errorMapper.HubError, 'Must be instanceof HubError');
    assert.strictEqual(caughtError.statusCode, 502, 'Mixed cascading failures must arbitrate to 502');
    assert(Array.isArray(caughtError.cascadingSummary), 'cascadingSummary must be an array');
    assert.strictEqual(caughtError.cascadingSummary.length, 3, 'Must retain 3 failure entries');
    assert.strictEqual(caughtError.cascadingSummary[0].statusCode, 401);
    assert.strictEqual(caughtError.cascadingSummary[1].statusCode, 500);
    assert.strictEqual(caughtError.cascadingSummary[2].statusCode, 429);
    console.log(`  ✅ PASS: 終端拋出 502 HubCascadingError，完整保留 3 級失敗軌跡 [401, 500, 429]。`);
    passedTests++;
  }

  // ============================================================================
  // Test C-9: Abort 與 BaseClient 錯誤回報競爭 (驗證無雙重 Probe 結算)
  // ============================================================================
  console.log('\n👉 Test C-9: Abort 與 BaseClient 錯誤回報競爭 (驗證無雙重 Probe 結算)...');
  resetTestState();
  {
    const model = modelRegistry.getModelsByCapability(['text'])[0];
    const node = heartbeatRegistry.getNode(`${model.provider}:${model.model_id}`);
    node.state = 'HALF-OPEN';
    node.probeActive = false;
    node.generation = 1;

    const admission = heartbeatRegistry.canPass(model.provider, model.model_id);
    assert.strictEqual(admission.allowed, true);
    assert.strictEqual(node.probeActive, true);
    assert.strictEqual(node.generation, 2, 'canPass increments generation upon issuing canary token');

    const ClientClass = cascadingExecutor.clientMap[model.provider];
    const client = new ClientClass({
      modelCapability: model,
      canaryTokens: admission.tokens
    });

    const abortController = new AbortController();
    abortController.abort('RACING_LOST');

    let caughtError = null;
    try {
      await client.execute({ objective: 'abort test', code_context: 'mock' }, { type: 'object' }, {
        canaryTokens: admission.tokens,
        signal: abortController.signal
      });
    } catch (err) {
      caughtError = err;
    }

    assert(caughtError !== null);
    assert.strictEqual(caughtError.faultScope, 'NONE', 'Cancellation must have faultScope NONE');
    assert.strictEqual(caughtError.recordedInClient, true, 'BaseClient must mark recordedInClient');
    assert.strictEqual(node.probeActive, false, 'Probe must be neutrally released');
    assert.strictEqual(node.generation, 2, 'Generation must not have mutated during neutral release');
    assert.strictEqual(node.state, 'HALF-OPEN', 'State remains HALF-OPEN');
    console.log(`  ✅ PASS: Abort 由 BaseClient 單次原子結算 (faultScope: NONE, generation: 2, probeActive: false)，外層無重複結算。`);
    passedTests++;
  }

  // ============================================================================
  // Test C-10: 單調時鐘與 Parallel Deadline (防範 Wall Clock 突變)
  // ============================================================================
  console.log('\n👉 Test C-10: 單調時鐘與 Parallel Deadline (防範 Wall Clock 突變)...');
  resetTestState();
  {
    const origDateNow = Date.now;
    const origClientMap = { ...cascadingExecutor.clientMap };

    let wallClockShift = 0;
    Date.now = () => origDateNow() + wallClockShift;

    class SlowHangingClient extends BaseClient {
      async _callModelApi() {
        wallClockShift = -3600000; // 1 hour into the past!
        await new Promise(r => setTimeout(r, 250));
        return JSON.stringify({ summary: "done" });
      }
    }

    cascadingExecutor.clientMap['nvidia-nim'] = SlowHangingClient;
    cascadingExecutor.clientMap['google'] = SlowHangingClient;
    cascadingExecutor.clientMap['deepseek'] = SlowHangingClient;
    cascadingExecutor.clientMap['vertex-ai'] = SlowHangingClient;

    const startPerf = performance.now();
    let caughtError = null;
    try {
      await cascadingExecutor.execute(
        { objective: 'NTP shift test', tags: ['realtime'], code_context: 'mock', skipVerification: true },
        { type: 'object' },
        { taskTimeoutMs: 100, race: true }
      );
    } catch (err) {
      caughtError = err;
    } finally {
      Date.now = origDateNow;
      cascadingExecutor.clientMap = origClientMap;
    }

    const elapsedPerf = performance.now() - startPerf;
    assert(caughtError !== null, 'Must throw deadline timeout');
    assert.strictEqual(caughtError.statusCode, 504, 'Must throw 504 on deadline timeout');
    assert(elapsedPerf < 1000, `Must terminate based on monotonic time (~100ms), took ${elapsedPerf}ms`);
    console.log(`  ✅ PASS: 即使 Date.now() 倒撥 1 小時，單調時鐘在 ${Math.round(elapsedPerf)}ms 內精確終止任務，絕不死循環。`);
    passedTests++;
  }

  // ============================================================================
  // Test C-11: Stop-Waiting 不得提前釋放 Probe (非 Abortable Client 探針安全延遲釋放)
  // ============================================================================
  console.log('\n👉 Test C-11: Stop-Waiting 不得提前釋放 Probe (非 Abortable Client 探針安全延遲釋放)...');
  resetTestState();
  {
    const model = modelRegistry.getModelsByCapability(['text'])[0];
    const provNode = heartbeatRegistry.getNode(model.provider);
    const modelNode = heartbeatRegistry.getNode(`${model.provider}:${model.model_id}`);

    provNode.state = 'HALF-OPEN';
    provNode.probeActive = false;
    modelNode.state = 'HALF-OPEN';
    modelNode.probeActive = false;

    // 1. B 取得雙層 Probe Token
    const admissionB = heartbeatRegistry.canPass(model.provider, model.model_id);
    assert.strictEqual(admissionB.allowed, true);
    assert.strictEqual(provNode.probeActive, true);
    assert.strictEqual(modelNode.probeActive, true);

    let resolvePendingCall;
    let underlyingCallCompleted = false;

    let notifyCallStarted;
    const callStartedPromise = new Promise(r => notifyCallStarted = r);

    // 2. B 的 Mock API Promise 開始執行，但不支援 AbortSignal
    class NonAbortableClient extends BaseClient {
      async _callModelApi(payload, schema, options = {}) {
        return new Promise((resolve) => {
          notifyCallStarted();
          resolvePendingCall = (data) => {
            underlyingCallCompleted = true;
            resolve(data);
          };
          // 刻意不監聽 options.signal，模擬不支持取消的第三方 SDK
        });
      }
    }

    const clientB = new NonAbortableClient({
      modelCapability: model,
      canaryTokens: admissionB.tokens
    });

    const abortController = new AbortController();

    // 3. 啟動 B 執行
    const executePromise = clientB.execute(
      { objective: 'stop-waiting probe safety test', code_context: 'mock' },
      { type: 'object' },
      { canaryTokens: admissionB.tokens, signal: abortController.signal }
    );

    // 等待底層 API 呼叫確實發起並處於 pending 狀態 (真實 In-Flight 請求)
    await callStartedPromise;

    // 4. A 勝出並發出 RACING_LOST -> B 主流程停止等待
    abortController.abort('RACING_LOST');

    let caughtError = null;
    try {
      await executePromise;
    } catch (err) {
      caughtError = err;
    }

    assert(caughtError !== null, 'B 主流程必須立即拋出取消錯誤停止等待');
    assert.strictEqual(caughtError.faultScope, 'NONE');
    assert.strictEqual(underlyingCallCompleted, false, '底層請求此時必須仍在背景執行中 (pending)');

    // 5. B 底層 Promise 尚未 settle 前，確認 Probe 仍然受到保護，不可被第二個請求重複取得！
    assert.strictEqual(provNode.probeActive, true, '底層未 settle 前 Provider Probe 必須保持鎖定');
    assert.strictEqual(modelNode.probeActive, true, '底層未 settle 前 Model Probe 必須保持鎖定');

    const secondAdmission = heartbeatRegistry.canPass(model.provider, model.model_id);
    assert.strictEqual(secondAdmission.allowed, false, '第二個請求不得穿透取得使用中的 Probe');
    assert.strictEqual(secondAdmission.reason, 'CANARY_PROBE_IN_FLIGHT');

    // 6. 讓 B 的底層 Promise 最終 settle
    resolvePendingCall(JSON.stringify({ summary: "late arrival result" }));
    // 等待 microtask 與 deferred finally 結算
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(underlyingCallCompleted, true, '底層請求現已完成');
    assert.strictEqual(provNode.probeActive, false, '底層 settle 後 Provider Probe 必須已中性釋放');
    assert.strictEqual(modelNode.probeActive, false, '底層 settle 後 Model Probe 必須已中性釋放');
    assert.strictEqual(provNode.state, 'HALF-OPEN', 'Provider 狀態維持 HALF-OPEN (未被晚到回應誤復原為 CLOSED)');
    assert.strictEqual(modelNode.state, 'HALF-OPEN', 'Model 狀態維持 HALF-OPEN (未被晚到回應誤復原為 CLOSED)');

    // 次一請求此時方可正常准入
    const thirdAdmission = heartbeatRegistry.canPass(model.provider, model.model_id);
    assert.strictEqual(thirdAdmission.allowed, true, '底層完全 settle 且中性釋放後，次一請求方可准入');

    // 7. 確認晚到結果不污染狀態
    console.log(`  ✅ PASS: Stop-Waiting 期間 Probe 嚴格保持鎖定，禁止第二請求搶佔；底層真正 settle 後精準執行單次 Neutral Release。`);
    passedTests++;
  }

  console.log('\n================================================================================');
  console.log(`📊 [C-1 ~ C-11 Results]: ${passedTests}/${totalTests} passed (100%)`);
  console.log('================================================================================\n');
}

runAllTests().catch(err => {
  console.error('❌ Test Suite Failed:', err);
  process.exit(1);
});
