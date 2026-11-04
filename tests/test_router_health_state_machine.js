const assert = require('assert');
const heartbeatRegistry = require('../registry/heartbeat_registry');
const errorMapper = require('../infrastructure/adapters/error_mapper');
const BaseClient = require('../infrastructure/clients/base_client');
const cascadingExecutor = require('../services/cascading_executor');
const router = require('../services/router');

async function runTests() {
  console.log("==================================================");
  console.log("🧪 [P0-B Step 4.2-B-2] Router Health State Machine Tests (28 Cases)");
  console.log("==================================================");

  // Virtual Mock Clock Engine
  let virtualNow = 1000000000;
  const mockNow = () => virtualNow;
  const advanceTime = (ms) => { virtualNow += ms; };

  // Timer mock for active watchdog test
  let activeTimers = [];
  const mockTimerFn = {
    setTimeout: (fn, delay) => {
      const id = { triggerAt: virtualNow + delay, fn };
      activeTimers.push(id);
      return id;
    },
    clearTimeout: (id) => {
      activeTimers = activeTimers.filter(t => t !== id);
    }
  };
  const triggerTimers = () => {
    const due = activeTimers.filter(t => virtualNow >= t.triggerAt);
    activeTimers = activeTimers.filter(t => virtualNow < t.triggerAt);
    for (const t of due) {
      t.fn();
    }
  };

  heartbeatRegistry.setClock(mockNow, mockTimerFn);

  // ----------------------------------------------------
  // Test 1: CLOSED 正常放行
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 1: CLOSED 正常放行 (Closed Passthrough)...");
    heartbeatRegistry.reset();
    const pass = heartbeatRegistry.canPass('test-p1', 'test-m1');
    assert.strictEqual(pass.allowed, true, "Test 1 failed: Initial state must be allowed");
    assert.strictEqual(pass.isCanary, false, "Test 1 failed: Normal request must not be canary");
    assert.strictEqual(heartbeatRegistry.isHealthy('test-p1', 'test-m1'), true, "Test 1 failed: Initial state must be healthy");
    console.log("  ✅ PASS: 初始 CLOSED 狀態正常放行。");
  }

  // ----------------------------------------------------
  // Test 2: CLOSED 容錯閥值未達標不熔斷
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 2: CLOSED 容錯閥值未達標不熔斷 (Fault Tolerance)...");
    heartbeatRegistry.reset();
    
    // 第一次失敗
    heartbeatRegistry.record(
      { provider: 'test-p2', modelId: 'test-m2' },
      100,
      false,
      { error: errorMapper.createError('test-p2', { status: 503, message: "transient 1" }) }
    );
    assert.strictEqual(heartbeatRegistry.canPass('test-p2', 'test-m2').allowed, true, "1 fail should still pass");

    // 第二次失敗
    heartbeatRegistry.record(
      { provider: 'test-p2', modelId: 'test-m2' },
      100,
      false,
      { error: errorMapper.createError('test-p2', { status: 503, message: "transient 2" }) }
    );
    assert.strictEqual(heartbeatRegistry.canPass('test-p2', 'test-m2').allowed, true, "2 fails should still pass");
    assert.strictEqual(heartbeatRegistry.isHealthy('test-p2', 'test-m2'), true, "2 fails should still be healthy");
    console.log("  ✅ PASS: 失敗次數小於 3 時保持 CLOSED 放行。");
  }

  // ----------------------------------------------------
  // Test 3: 連續失敗達標進入 OPEN
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 3: 連續失敗達標進入 OPEN (Trip to Open)...");
    heartbeatRegistry.reset();
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'test-p3', modelId: 'test-m3' },
        100,
        false,
        { error: errorMapper.createError('test-p3', { status: 503, message: `transient ${i}` }) }
      );
    }
    const node = heartbeatRegistry.getNode('test-p3:test-m3');
    assert.strictEqual(node.state, 'OPEN', "Test 3 failed: 3 consecutive failures must trip to OPEN");
    assert.strictEqual(heartbeatRegistry.isHealthy('test-p3', 'test-m3'), false, "Test 3 failed: Node should not be healthy");
    console.log("  ✅ PASS: 連續失敗 3 次順利轉移至 OPEN。");
  }

  // ----------------------------------------------------
  // Test 4: OPEN 冷卻期內嚴格拒絕一般請求
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 4: OPEN 冷卻期內嚴格拒絕一般請求 (Fast-Fail)...");
    heartbeatRegistry.reset();
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'test-p4', modelId: 'test-m4' },
        100,
        false,
        { error: errorMapper.createError('test-p4', { status: 503, message: "overloaded" }) }
      );
    }
    // 前進 10 秒 (冷卻為 30 秒)
    advanceTime(10000);
    const pass = heartbeatRegistry.canPass('test-p4', 'test-m4');
    assert.strictEqual(pass.allowed, false, "Test 4 failed: Must be rejected during cooldown");
    assert.strictEqual(pass.reason, 'CIRCUIT_OPEN', "Test 4 failed: Reason must be CIRCUIT_OPEN");
    assert.strictEqual(pass.retryAfterMs, 20000, "Test 4 failed: Remaining cooldown must be 20000ms");
    console.log("  ✅ PASS: 冷卻期間內正確拒絕准入並回傳剩餘時間。");
  }

  // ----------------------------------------------------
  // Test 5: OPEN 冷卻期滿自動進入 HALF-OPEN
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 5: OPEN 冷卻期滿自動進入 HALF-OPEN (Transition)...");
    heartbeatRegistry.reset();
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'test-p5', modelId: 'test-m5' },
        100,
        false,
        { error: errorMapper.createError('test-p5', { status: 503, message: "overloaded" }) }
      );
    }
    // 前進 30 秒滿冷卻
    advanceTime(30000);
    const node = heartbeatRegistry.getNode('test-p5:test-m5');
    // 呼叫 canPass 觸發轉移
    const pass = heartbeatRegistry.canPass('test-p5', 'test-m5');
    assert.strictEqual(node.state, 'HALF-OPEN', "Test 5 failed: Must transition to HALF-OPEN");
    assert.strictEqual(pass.allowed, true, "Test 5 failed: First request should acquire probe");
    assert.strictEqual(pass.isCanary, true, "Test 5 failed: Must be marked as canary probe");
    console.log("  ✅ PASS: 冷卻結束成功切換至 HALF-OPEN。");
  }

  // ----------------------------------------------------
  // Test 6: HALF-OPEN 僅發放單一 Canary Probe Token
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 6: HALF-OPEN 僅發放單一 Canary Probe Token...");
    heartbeatRegistry.reset();
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'test-p6', modelId: 'test-m6' },
        100,
        false,
        { error: errorMapper.createError('test-p6', { status: 503, message: "overloaded" }) }
      );
    }
    advanceTime(30000);

    const firstPass = heartbeatRegistry.canPass('test-p6', 'test-m6');
    assert(firstPass.token && firstPass.token.startsWith('probe_'), "Test 6 failed: Token must be generated");
    assert.strictEqual(firstPass.isCanary, true);
    console.log("  ✅ PASS: 成功簽發唯一 Canary Token:", firstPass.token);
  }

  // ----------------------------------------------------
  // Test 7: Canary Probe 執行中併發請求全數被拒
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 7: Canary Probe 執行中併發請求全數被拒...");
    heartbeatRegistry.reset();
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'test-p7', modelId: 'test-m7' },
        100,
        false,
        { error: errorMapper.createError('test-p7', { status: 503, message: "overloaded" }) }
      );
    }
    advanceTime(30000);

    // Request 1 取得探針
    const probe = heartbeatRegistry.canPass('test-p7', 'test-m7');
    assert.strictEqual(probe.allowed, true);

    // 模擬 10 個併發請求抵達
    for (let i = 1; i <= 10; i++) {
      const rejected = heartbeatRegistry.canPass('test-p7', 'test-m7');
      assert.strictEqual(rejected.allowed, false, `Concurrent req ${i} must be rejected`);
      assert.strictEqual(rejected.reason, 'CANARY_PROBE_IN_FLIGHT', `Concurrent req ${i} reason mismatch`);
    }
    console.log("  ✅ PASS: 10 個併發請求全數拒絕，無一穿透探針鎖。");
  }

  // ----------------------------------------------------
  // Test 8: Canary Probe 成功使狀態回歸 CLOSED
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 8: Canary Probe 成功使狀態回歸 CLOSED...");
    heartbeatRegistry.reset();
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'test-p8', modelId: 'test-m8' },
        100,
        false,
        { error: errorMapper.createError('test-p8', { status: 503, message: "overloaded" }) }
      );
    }
    advanceTime(30000);
    const probe = heartbeatRegistry.canPass('test-p8', 'test-m8');

    // 探針回報成功
    heartbeatRegistry.record(
      { provider: 'test-p8', modelId: 'test-m8' },
      150,
      true,
      { token: probe.token }
    );

    const node = heartbeatRegistry.getNode('test-p8:test-m8');
    assert.strictEqual(node.state, 'CLOSED', "Test 8 failed: Must heal back to CLOSED");
    assert.strictEqual(node.consecutiveFailures, 0, "Test 8 failed: Failures must reset to 0");
    assert.strictEqual(heartbeatRegistry.canPass('test-p8', 'test-m8').allowed, true, "Future requests must pass");
    console.log("  ✅ PASS: 探針成功回報使熔斷器安全復原為 CLOSED。");
  }

  // ----------------------------------------------------
  // Test 9: Canary Probe 失敗使狀態打回 OPEN 且冷卻加倍
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 9: Canary Probe 失敗使狀態打回 OPEN 且冷卻加倍...");
    heartbeatRegistry.reset();
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'test-p9', modelId: 'test-m9' },
        100,
        false,
        { error: errorMapper.createError('test-p9', { status: 503, message: "overloaded" }) }
      );
    }
    advanceTime(30000);
    const probe = heartbeatRegistry.canPass('test-p9', 'test-m9');

    // 探針回報失敗
    heartbeatRegistry.record(
      { provider: 'test-p9', modelId: 'test-m9' },
      100,
      false,
      { token: probe.token, error: errorMapper.createError('test-p9', { status: 503, message: "still failing" }) }
    );

    const node = heartbeatRegistry.getNode('test-p9:test-m9');
    assert.strictEqual(node.state, 'OPEN', "Test 9 failed: Must trip back to OPEN");
    assert.strictEqual(node.currentCooldownMs, 60000, "Test 9 failed: Cooldown must double to 60000ms");
    console.log("  ✅ PASS: 探針失敗立即重返 OPEN，冷卻時間翻倍至 60,000ms。");
  }

  // ----------------------------------------------------
  // Test 10: Canary Probe 懸掛主動超時保護
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 10: Canary Probe 懸掛主動超時保護 (Active Timer)...");
    heartbeatRegistry.reset();
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'test-p10', modelId: 'test-m10' },
        100,
        false,
        { error: errorMapper.createError('test-p10', { status: 503, message: "overloaded" }) }
      );
    }
    advanceTime(30000);
    const probe = heartbeatRegistry.canPass('test-p10', 'test-m10');
    assert.strictEqual(probe.allowed, true);

    // 時鐘前進 15001ms 並觸發主動 Timer
    advanceTime(15001);
    triggerTimers();

    const node = heartbeatRegistry.getNode('test-p10:test-m10');
    assert.strictEqual(node.state, 'OPEN', "Test 10 failed: Timer must trip node back to OPEN");
    assert.strictEqual(node.openReason, 'WATCHDOG_TIMER_EXPIRED');
    console.log("  ✅ PASS: Watchdog Timer 超時主動回收 Token 並退回 OPEN。");
  }

  // ----------------------------------------------------
  // Test 11: Model 級故障隔離不影響同 Provider 的其他 Model
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 11: Model 級故障隔離不影響同 Provider 其他 Model...");
    heartbeatRegistry.reset();

    // 隔離 gemini-1.5-pro
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'google', modelId: 'gemini-1.5-pro' },
        100,
        false,
        { error: errorMapper.createError('google', { status: 503, message: "Pro is overloaded" }) }
      );
    }

    assert.strictEqual(heartbeatRegistry.isHealthy('google', 'gemini-1.5-pro'), false, "Pro should be unhealthy");
    assert.strictEqual(heartbeatRegistry.canPass('google', 'gemini-1.5-pro').allowed, false, "Pro should be rejected");

    // Flash 應依然健康放行
    assert.strictEqual(heartbeatRegistry.isHealthy('google', 'gemini-1.5-flash'), true, "Flash must remain healthy");
    assert.strictEqual(heartbeatRegistry.canPass('google', 'gemini-1.5-flash').allowed, true, "Flash must pass");
    assert.strictEqual(heartbeatRegistry.isHealthy('google'), true, "Provider overall must remain healthy");
    console.log("  ✅ PASS: gemini-1.5-pro 故障隔離，gemini-1.5-flash 完全不受干擾。");
  }

  // ----------------------------------------------------
  // Test 12: Provider 級故障全體連鎖隔離
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 12: Provider 級故障全體連鎖隔離...");
    heartbeatRegistry.reset();

    // 502 Bad Gateway (Provider 級故障)
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'vertex-ai', modelId: 'any-model' },
        100,
        false,
        { error: errorMapper.createError('vertex-ai', { status: 502, message: "Bad Gateway" }) }
      );
    }

    assert.strictEqual(heartbeatRegistry.isHealthy('vertex-ai'), false, "Provider must be unhealthy");
    assert.strictEqual(heartbeatRegistry.isHealthy('vertex-ai', 'model-a'), false, "All child models must be unhealthy");
    assert.strictEqual(heartbeatRegistry.canPass('vertex-ai', 'model-a').allowed, false, "Child model must be rejected");
    console.log("  ✅ PASS: Provider 502 閘道故障時，轄下所有模型一併連鎖隔離。");
  }

  // ----------------------------------------------------
  // Test 13: 401 憑證錯誤立即長效隔離
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 13: 401 憑證錯誤立即長效隔離...");
    heartbeatRegistry.reset();

    heartbeatRegistry.record(
      { provider: 'nvidia-nim', modelId: 'meta/llama' },
      50,
      false,
      { error: errorMapper.createError('nvidia-nim', { status: 401, message: "Invalid API key" }) }
    );

    const provNode = heartbeatRegistry.getNode('nvidia-nim');
    assert.strictEqual(provNode.state, 'OPEN', "401 must trip Provider to OPEN immediately on strike 1");
    assert.strictEqual(provNode.permanent, true, "401 must be permanent fault");
    assert.strictEqual(heartbeatRegistry.canPass('nvidia-nim', 'meta/llama').allowed, false);
    console.log("  ✅ PASS: 401 憑證錯誤單次直接永久 OPEN，不浪費無謂重試。");
  }

  // ----------------------------------------------------
  // Test 14: Retry-After 正常範圍對齊冷卻
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 14: Retry-After 正常範圍對齊冷卻...");
    heartbeatRegistry.reset();

    const rateLimitErr = errorMapper.createError('deepseek', {
      status: 429,
      message: "Rate limit reached",
      headers: { 'retry-after': '45' }
    });

    heartbeatRegistry.record(
      { provider: 'deepseek', modelId: 'deepseek-chat' },
      100,
      false,
      { error: rateLimitErr }
    );

    const node = heartbeatRegistry.getNode('deepseek:deepseek-chat');
    assert.strictEqual(node.state, 'OPEN');
    assert.strictEqual(node.currentCooldownMs, 45000, "Cooldown must align with 45s");

    advanceTime(44000);
    assert.strictEqual(heartbeatRegistry.canPass('deepseek', 'deepseek-chat').allowed, false, "44s must reject");
    advanceTime(2000);
    assert.strictEqual(heartbeatRegistry.canPass('deepseek', 'deepseek-chat').allowed, true, "46s must pass to probe");
    console.log("  ✅ PASS: Retry-After: 45 精準對齊 45,000ms 冷卻期。");
  }

  // ----------------------------------------------------
  // Test 15: 舊版 API 完全向下相容性
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 15: 舊版 API 完全向下相容性...");
    heartbeatRegistry.reset();

    // 舊版 record(provider, latency, success)
    heartbeatRegistry.record('legacy-provider', 200, true);
    assert.strictEqual(heartbeatRegistry.isHealthy('legacy-provider'), true);
    assert.strictEqual(heartbeatRegistry.getStatus('legacy-provider'), 'healthy');
    assert.strictEqual(heartbeatRegistry.getAverageLatency('legacy-provider'), 200);

    // 舊版 markDegraded(provider, reason)
    heartbeatRegistry.markDegraded('legacy-provider', 'Test Degrade');
    assert.strictEqual(heartbeatRegistry.isHealthy('legacy-provider'), false);
    assert.strictEqual(heartbeatRegistry.getStatus('legacy-provider'), 'degraded');

    // 舊版 getAllStats()
    const stats = heartbeatRegistry.getAllStats();
    assert(stats['legacy-provider'] !== undefined);
    assert.strictEqual(stats['legacy-provider'].status, 'degraded');
    console.log("  ✅ PASS: 既有對外簽名與資料結構 100% 向下相容。");
  }

  // ----------------------------------------------------
  // Test 16: 舊 Probe Token 過期後回報成功，不得解除新 OPEN 狀態
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 16: 舊 Probe Token 過期後回報成功，不得解除新 OPEN 狀態 (Stale Token)...");
    heartbeatRegistry.reset();
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record({ provider: 'p16', modelId: 'm16' }, 100, false, {
        error: errorMapper.createError('p16', { status: 503, message: "fail" })
      });
    }
    advanceTime(30000);
    const staleProbe = heartbeatRegistry.canPass('p16', 'm16');
    const staleToken = staleProbe.token;

    // 探針超時 16 秒
    advanceTime(16000);
    // 次一請求觸發超時檢測退回 OPEN
    heartbeatRegistry.canPass('p16', 'm16');
    const node = heartbeatRegistry.getNode('p16:m16');
    assert.strictEqual(node.state, 'OPEN', "Node must have reverted to OPEN on timeout");

    // 此時舊探針遲來回報「成功」
    const accepted = heartbeatRegistry.getNode('p16:m16').recordSuccess({ token: staleToken, now: virtualNow });
    assert.strictEqual(accepted, false, "Stale token report must be rejected");
    assert.strictEqual(node.state, 'OPEN', "State must REMAIN OPEN and not be hijacked by stale probe");
    console.log("  ✅ PASS: 過期舊 Token 回報成功遭到捨棄，新 OPEN 狀態未受污染。");
  }

  // ----------------------------------------------------
  // Test 17: Watchdog Timer 未及時執行時，被動 Deadline 仍能回收過期 Probe
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 17: Watchdog Timer 未及時執行時，被動 Deadline 仍能回收過期 Probe...");
    heartbeatRegistry.reset();
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record({ provider: 'p17', modelId: 'm17' }, 100, false, {
        error: errorMapper.createError('p17', { status: 503, message: "fail" })
      });
    }
    advanceTime(30000);
    const probe = heartbeatRegistry.canPass('p17', 'm17');
    assert.strictEqual(probe.allowed, true);

    // 模擬 Event Loop 嚴重阻塞，Timer 完全沒觸發，但時間已前進 20 秒
    advanceTime(20000);
    // 沒有呼叫 triggerTimers()！直接進入下一次查詢
    const pass = heartbeatRegistry.canPass('p17', 'm17');
    const node = heartbeatRegistry.getNode('p17:m17');

    assert.strictEqual(node.openReason, 'WATCHDOG_DEADLINE_EXPIRED', "Passive deadline check must detect expired probe");
    assert.strictEqual(node.state, 'OPEN', "Must trip back to OPEN via passive check");
    assert.strictEqual(pass.allowed, false, "Request must be rejected");
    console.log("  ✅ PASS: 零 Timer 觸發情境下，被動 Deadline 檢查精準回收過期探針。");
  }

  // ----------------------------------------------------
  // Test 18: Retry-After 超過 5 分鐘時，不得提早進入 HALF-OPEN
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 18: Retry-After 超過 5 分鐘時，不得提早進入 HALF-OPEN (No Truncation)...");
    heartbeatRegistry.reset();

    const hugeDelayErr = errorMapper.createError('p18', {
      status: 429,
      message: "Model RPM limit reached: please slow down",
      headers: { 'retry-after': '3600' } // 1 小時 (3600 秒)
    });

    heartbeatRegistry.record({ provider: 'p18', modelId: 'm18' }, 100, false, { error: hugeDelayErr });
    const node = heartbeatRegistry.getNode('p18:m18');

    // 經過 6 分鐘 (360,000ms)，超過一般預設的 5 分鐘上限
    advanceTime(360000);

    // 若系統默認截短為 5 分鐘，此時會錯誤進入 HALF-OPEN
    const checkAt6m = heartbeatRegistry.canPass('p18', 'm18');
    assert.strictEqual(checkAt6m.allowed, false, "Must NOT enter HALF-OPEN after 6 mins when provider requested 1 hour");
    assert.strictEqual(node.state, 'OPEN', "Must strictly stay OPEN until full 3600s elapsed");

    // 經過 61 分鐘 (3,660,000ms)
    advanceTime(3300000);
    const checkAt61m = heartbeatRegistry.canPass('p18', 'm18');
    assert.strictEqual(checkAt61m.allowed, true, "Must only enter HALF-OPEN after full 3600s notBefore satisfied");
    console.log("  ✅ PASS: 3600 秒 Retry-After 嚴格遵守 notBefore，絕無靜默縮短至 5 分鐘。");
  }

  // ----------------------------------------------------
  // Test 19: OPEN_PERMANENT 永久故障防護
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 19: OPEN_PERMANENT 永久故障防護 (404 Model Not Found)...");
    heartbeatRegistry.reset();

    const notFoundErr = errorMapper.createError('p19', {
      status: 404,
      message: "The model `p19:deprecated-model` does not exist",
      code: "model_not_found"
    });

    heartbeatRegistry.record({ provider: 'p19', modelId: 'deprecated-model' }, 50, false, { error: notFoundErr });
    const node = heartbeatRegistry.getNode('p19:deprecated-model');
    assert.strictEqual(node.state, 'OPEN');
    assert.strictEqual(node.permanent, true, "Model Not Found must be marked permanent: true");

    // 即使前進 24 小時，永不自動進入 HALF-OPEN
    advanceTime(86400000);
    const pass = heartbeatRegistry.canPass('p19', 'deprecated-model');
    assert.strictEqual(pass.allowed, false);
    assert.strictEqual(pass.reason, 'PERMANENT_OPEN');

    // 唯有管理員手動 unblock 方可重啟
    heartbeatRegistry.unblock('p19', 'deprecated-model');
    assert.strictEqual(node.state, 'CLOSED');
    assert.strictEqual(heartbeatRegistry.canPass('p19', 'deprecated-model').allowed, true);
    console.log("  ✅ PASS: 404 永久故障永不自動探針，經手動 unblock 後安全重置。");
  }

  // ----------------------------------------------------
  // Test 20: Credential / Account 故障精確隔離不污染其他對象
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 20: Credential / Account 故障精確隔離不污染其他對象...");
    heartbeatRegistry.reset();

    // 帳號 A 額度耗盡
    const accLimitErr = errorMapper.createError('p20', {
      status: 429,
      message: "Daily project quota exceeded for project alpha"
    });

    heartbeatRegistry.record({ provider: 'p20' }, 100, false, {
      error: accLimitErr,
      accountId: 'project-alpha'
    });

    const nodeA = heartbeatRegistry.getNode('p20:account:project-alpha');
    assert.strictEqual(nodeA.state, 'OPEN', "Project Alpha must be OPEN");

    // 檢查同 Provider 下的 Project Beta
    const nodeB = heartbeatRegistry.getNode('p20:account:project-beta');
    assert.strictEqual(nodeB.state, 'CLOSED', "Project Beta must remain CLOSED and unaffected");
    console.log("  ✅ PASS: Project Alpha 配額耗盡隔離，Project Beta 保持獨立健康。");
  }

  // ----------------------------------------------------
  // Test 21: UNKNOWN + modelId 缺失，不得自動隔離 Provider
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 21: UNKNOWN + modelId 缺失，不得自動隔離 Provider (Scope Safety)...");
    heartbeatRegistry.reset();

    // 1. 產生 UNKNOWN faultScope 且無 modelId 之錯誤
    const unknownErr = errorMapper.createError('p21', {
      status: 500,
      message: "Unclassified unexpected upstream anomaly"
    });
    unknownErr.faultScope = 'UNKNOWN';

    // 記錄失敗但缺少 modelId
    heartbeatRegistry.record({ provider: 'p21' }, 100, false, { error: unknownErr });

    const provNode = heartbeatRegistry.getNode('p21');
    assert.strictEqual(provNode.state, 'CLOSED', "Test 21 failed: Provider node must remain CLOSED on UNKNOWN error without modelId");
    assert.strictEqual(provNode.consecutiveFailures, 0, "Provider failure count must NOT increase on unisolated UNKNOWN error");
    assert.strictEqual(heartbeatRegistry.isHealthy('p21'), true, "Provider must remain healthy");
    assert.strictEqual(heartbeatRegistry.canPass('p21').allowed, true, "Provider must still allow traffic");

    // 2. 測試 MODEL scope 但缺少 modelId 時，同樣不得降級 Provider
    heartbeatRegistry.record({ provider: 'p21' }, 100, false, { faultScope: 'MODEL' });
    assert.strictEqual(provNode.state, 'CLOSED', "Provider must remain CLOSED when MODEL scope is missing modelId");
    assert.strictEqual(heartbeatRegistry.isHealthy('p21'), true, "Provider must still be healthy");

    console.log("  ✅ PASS: UNKNOWN 與 MODEL 在缺失 modelId 時，精確拒絕升級為 Provider 故障，保留系統可用性。");
  }

  // ----------------------------------------------------
  // Test 22: Router → CascadingExecutor → BaseClient → Registry 完整 Canary Probe 閉環
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 22: Router → CascadingExecutor → BaseClient → Registry 完整 Canary Probe 閉環...");
    heartbeatRegistry.reset();

    // 1. 準備 Mock Client 攔截 BaseClient 呼叫
    const originalClientMap = { ...cascadingExecutor.clientMap };

    let executedTokens = [];
    class MockPrimaryClient extends BaseClient {
      async _callModelApi(readyState, outputSchema) {
        executedTokens.push(this.canaryToken);
        return JSON.stringify({
          result: "primary-success"
        });
      }
    }

    class MockSecondaryClient extends BaseClient {
      async _callModelApi(readyState, outputSchema) {
        executedTokens.push(this.canaryToken);
        return JSON.stringify({
          result: "secondary-fallback-success"
        });
      }
    }

    cascadingExecutor.clientMap['deepseek'] = MockPrimaryClient;
    cascadingExecutor.clientMap['vertex-ai'] = MockSecondaryClient;

    // 2. 將 primary model (deepseek-chat) 觸發進入 OPEN
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'deepseek', modelId: 'deepseek-chat' },
        100,
        false,
        { error: errorMapper.createError('deepseek', { status: 503, message: `fail ${i}` }) }
      );
    }

    const primaryNode = heartbeatRegistry.getNode('deepseek:deepseek-chat');
    assert.strictEqual(primaryNode.state, 'OPEN', "Primary model must be OPEN");
    assert.strictEqual(heartbeatRegistry.isHealthy('deepseek', 'deepseek-chat'), false, "Primary model is not healthy");

    // 3. 冷卻期結束，進入可探針狀態
    advanceTime(30000);
    assert.strictEqual(heartbeatRegistry.isCandidateEligible('deepseek', 'deepseek-chat'), true, "Must be eligible as candidate after cooldown");
    assert.strictEqual(heartbeatRegistry.isHealthy('deepseek', 'deepseek-chat'), false, "Must still not be general healthy");

    // 4. 驗證 Router.getCandidates 順利將 deepseek-chat 納為第一順位
    const candidates = router.getCandidates({ modalities: ['text'], preferredTier: 'high' });
    assert.ok(candidates.length >= 2, "Must return at least 2 candidates");
    assert.strictEqual(candidates[0].model_id, 'deepseek-chat', "First candidate must be recovering primary model");
    assert.strictEqual(candidates[1].model_id, 'vertex/gemini-2.5-pro', "Second candidate must be secondary model");

    // 5. 執行第一個請求 (Canary Probe)：經由 CascadingExecutor -> canPass -> 取得 Token -> BaseClient -> recordSuccess
    const mockContext1 = {
      objective: `Canary probe test 1: ${Date.now()}`,
      constraints: [],
      tags: ["text-only"],
      skipVerification: true,
      code_context: "// offline test"
    };
    const schema = {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"]
    };

    const res1 = await cascadingExecutor.execute(mockContext1, schema, { preferredTier: 'high' });
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.modelUsed.model_id, 'deepseek-chat');
    assert.strictEqual(primaryNode.state, 'CLOSED', "Primary model circuit breaker must heal to CLOSED after canary success");
    assert.strictEqual(heartbeatRegistry.isHealthy('deepseek', 'deepseek-chat'), true, "Primary model must now be fully healthy");
    assert.ok(executedTokens[0] && executedTokens[0].startsWith('probe_gen1_'), `Canary token must be passed to BaseClient: ${executedTokens[0]}`);

    // 6. 再次驗證併發探針阻擋與 Fallback：
    // 先將 primary 打回 OPEN 並讓冷卻期滿，取得第一個探針
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'deepseek', modelId: 'deepseek-chat' },
        100,
        false,
        { error: errorMapper.createError('deepseek', { status: 503, message: `fail round 2 - ${i}` }) }
      );
    }
    advanceTime(30000);
    // 第一個探針被佔用（模擬另一個併發請求正在執行中持有 Token）
    const activeProbe = heartbeatRegistry.canPass('deepseek', 'deepseek-chat');
    assert.strictEqual(activeProbe.allowed, true);
    assert.ok(activeProbe.token.startsWith('probe_gen2_'));

    // 此時 CascadingExecutor 嘗試執行第二個請求：因為 deepseek-chat 正在 probeActive，
    // CascadingExecutor 遭遇 CANARY_PROBE_IN_FLIGHT 阻擋，自動 Fallback 至次要模型 vertex/gemini-2.5-pro
    const mockContext2 = {
      objective: `Concurrent fallback test 2: ${Date.now()}`,
      constraints: [],
      tags: ["text-only"],
      skipVerification: true,
      code_context: "// offline test"
    };
    const res2 = await cascadingExecutor.execute(mockContext2, schema, { preferredTier: 'high' });
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.modelUsed.model_id, 'vertex/gemini-2.5-pro', "Must cascade to secondary candidate when primary canary is in-flight");

    // 清理還原 clientMap
    cascadingExecutor.clientMap = originalClientMap;
    console.log("  ✅ PASS: Router → CascadingExecutor → BaseClient → Registry 完整 Canary Probe 閉環驗證成功（含探針准入、Token 傳遞、成功修復、併發 Fallback）。");
  }

  // ----------------------------------------------------
  // Test 23: 一般 CLOSED 請求成功，不得解除或污染另一個 HALF-OPEN Probe
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 23: 一般 CLOSED 請求成功，不得解除或污染另一個 HALF-OPEN Probe (Probe Integrity)...");
    heartbeatRegistry.reset();

    // 1. Model A 連續 3 次失敗進入 OPEN
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'p23', modelId: 'model-A' },
        100,
        false,
        { error: errorMapper.createError('p23', { status: 503, message: "overloaded" }) }
      );
    }
    advanceTime(30000);

    // 2. Model A 取得合法探針 Token 進入 HALF-OPEN
    const probeA = heartbeatRegistry.canPass('p23', 'model-A');
    assert.strictEqual(probeA.allowed, true);
    assert.strictEqual(probeA.isCanary, true);
    const tokenA = probeA.token;
    assert.ok(tokenA.startsWith('probe_gen1_'));

    const nodeA = heartbeatRegistry.getNode('p23:model-A');
    assert.strictEqual(nodeA.state, 'HALF-OPEN');
    assert.strictEqual(nodeA.probeActive, true);
    assert.strictEqual(nodeA.probeToken, tokenA);

    // 3. 同 Provider 下的 Model B 處於正常 CLOSED 狀態，發起請求並回報成功（token: null）
    heartbeatRegistry.record(
      { provider: 'p23', modelId: 'model-B' },
      50,
      true,
      { token: null }
    );
    const nodeB = heartbeatRegistry.getNode('p23:model-B');
    assert.strictEqual(nodeB.state, 'CLOSED');

    // 4. Provider 舊介面 record(p, l, s) 回報成功
    heartbeatRegistry.record('p23', 60, true);

    // 5. 斷言：Model A 的 HALF-OPEN 探針狀態絕不受 Model B 或 Provider 成功的污染或解除
    assert.strictEqual(nodeA.state, 'HALF-OPEN', "Model A must remain in HALF-OPEN");
    assert.strictEqual(nodeA.probeActive, true, "Model A probe must remain active");
    assert.strictEqual(nodeA.probeToken, tokenA, "Model A probe token must remain unchanged");
    assert.strictEqual(nodeA.generation, 1, "Model A generation must remain intact");

    // 6. 錯誤或過期 Token 回報成功：絕不可提前關閉探針
    heartbeatRegistry.record(
      { provider: 'p23', modelId: 'model-A' },
      50,
      true,
      { token: 'probe_gen99_stale_token' }
    );
    heartbeatRegistry.record(
      { provider: 'p23', modelId: 'model-A' },
      50,
      true,
      { token: null }
    );
    assert.strictEqual(nodeA.state, 'HALF-OPEN', "Stale/null token must be rejected");
    assert.strictEqual(nodeA.probeActive, true);

    // 7. 只有持有原始 Token A 回報成功，方可將 Model A 復原為 CLOSED
    heartbeatRegistry.record(
      { provider: 'p23', modelId: 'model-A' },
      50,
      true,
      { token: tokenA }
    );
    assert.strictEqual(nodeA.state, 'CLOSED', "Only original token can heal to CLOSED");
    assert.strictEqual(nodeA.probeActive, false);
    assert.strictEqual(nodeA.probeToken, null);

    console.log("  ✅ PASS: CLOSED 請求與舊版成功回報完全隔離，絕不污染或誤解除在途 Canary Probe。");
  }

  // ----------------------------------------------------
  // Test 24: Provider HALF-OPEN + Model CLOSED，成功後 Provider 正確復原
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 24: Provider HALF-OPEN + Model CLOSED，成功後 Provider 正確復原...");
    heartbeatRegistry.reset();

    // 1. Provider p24 觸發 3 次失敗進入 OPEN
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record(
        { provider: 'p24' },
        100,
        false,
        { error: errorMapper.createError('p24', { status: 502, message: "bad gateway" }) }
      );
    }
    const provNode = heartbeatRegistry.getNode('p24');
    assert.strictEqual(provNode.state, 'OPEN', "Provider must be OPEN");
    assert.strictEqual(heartbeatRegistry.isHealthy('p24'), false);

    // 2. 冷卻結束，Provider 進入 HALF-OPEN 可准入探針
    advanceTime(30000);
    assert.strictEqual(heartbeatRegistry.isCandidateEligible('p24', 'model-A'), true);

    // 3. canPass('p24', 'model-A'): Model A 為全新 CLOSED 節點
    const admission = heartbeatRegistry.canPass('p24', 'model-A');
    assert.strictEqual(admission.allowed, true);
    assert.strictEqual(admission.isCanary, true);
    assert.ok(admission.tokens, "Two-tier tokens envelope must be present");
    assert.ok(admission.tokens.providerToken, "providerToken must be signed");
    assert.strictEqual(admission.tokens.modelToken, null, "modelToken must be null for CLOSED model");
    assert.strictEqual(admission.token, admission.tokens.providerToken, "Backwards-compatible token must match providerToken");

    assert.strictEqual(provNode.state, 'HALF-OPEN');
    assert.strictEqual(provNode.probeActive, true);
    assert.strictEqual(provNode.probeToken, admission.tokens.providerToken);

    // 4. 成功回報（攜帶 tokens envelope）
    heartbeatRegistry.record(
      { provider: 'p24', modelId: 'model-A' },
      50,
      true,
      { tokens: admission.tokens }
    );

    // 5. 斷言 Provider 正確復原為 CLOSED
    assert.strictEqual(provNode.state, 'CLOSED', "Provider node must heal to CLOSED on valid canary success");
    assert.strictEqual(provNode.probeActive, false, "Provider probeActive must be false");
    assert.strictEqual(provNode.probeToken, null, "Provider probeToken must be cleared");
    assert.strictEqual(provNode.consecutiveFailures, 0, "Provider failures must be reset to 0");
    assert.strictEqual(heartbeatRegistry.isHealthy('p24'), true, "Provider must now be healthy");

    // 6. 後續請求已恢復常態准入，非 Canary
    const normalAdmission = heartbeatRegistry.canPass('p24', 'model-A');
    assert.strictEqual(normalAdmission.allowed, true);
    assert.strictEqual(normalAdmission.isCanary, false);
    assert.strictEqual(normalAdmission.token, null);

    console.log("  ✅ PASS: Provider HALF-OPEN + Model CLOSED 在收到 Provider Token 後精確復原為 CLOSED。");
  }

  // ----------------------------------------------------
  // Test 25: Provider HALF-OPEN + Model HALF-OPEN，兩個 Token 各自簽發、各自結算
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 25: Provider HALF-OPEN + Model HALF-OPEN，雙層 Token 各自簽發、各自結算...");
    heartbeatRegistry.reset();

    // 1. Provider 與 Model 各自觸發失敗進入 OPEN
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record({ provider: 'p25' }, 100, false, { error: errorMapper.createError('p25', { status: 502, message: "prov fail" }) });
      heartbeatRegistry.record({ provider: 'p25', modelId: 'model-M' }, 100, false, { error: errorMapper.createError('p25', { status: 429, message: "model rate limit" }) });
    }
    const provNode = heartbeatRegistry.getNode('p25');
    const modelNode = heartbeatRegistry.getNode('p25:model-M');
    assert.strictEqual(provNode.state, 'OPEN');
    assert.strictEqual(modelNode.state, 'OPEN');

    // 2. 冷卻期滿，皆可准入
    advanceTime(30000);
    const admission = heartbeatRegistry.canPass('p25', 'model-M');
    assert.strictEqual(admission.allowed, true);
    assert.strictEqual(admission.isCanary, true);
    assert.ok(admission.tokens.providerToken, "Must have providerToken");
    assert.ok(admission.tokens.modelToken, "Must have modelToken");
    assert.notStrictEqual(admission.tokens.providerToken, admission.tokens.modelToken, "Provider and Model tokens must be distinct");

    assert.strictEqual(provNode.state, 'HALF-OPEN');
    assert.strictEqual(provNode.probeActive, true);
    assert.strictEqual(modelNode.state, 'HALF-OPEN');
    assert.strictEqual(modelNode.probeActive, true);

    // 3. 成功回報（同時結算兩個 Token）
    heartbeatRegistry.record(
      { provider: 'p25', modelId: 'model-M' },
      60,
      true,
      { tokens: admission.tokens }
    );

    // 4. 斷言雙方各自正確復原為 CLOSED
    assert.strictEqual(provNode.state, 'CLOSED', "Provider must heal to CLOSED");
    assert.strictEqual(provNode.probeActive, false);
    assert.strictEqual(modelNode.state, 'CLOSED', "Model must heal to CLOSED");
    assert.strictEqual(modelNode.probeActive, false);
    assert.strictEqual(heartbeatRegistry.isHealthy('p25', 'model-M'), true);

    console.log("  ✅ PASS: Provider 與 Model 同時 HALF-OPEN 時，獨立簽發與獨立結算雙層 Token 成功。");
  }

  // ----------------------------------------------------
  // Test 26: Provider HALF-OPEN + Model 404，不能錯誤判定 Provider 故障，且不得留下懸掛 Probe
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 26: Provider HALF-OPEN + Model 404，中性釋放 Provider Probe，不得誤判 Provider 故障且無懸掛 Probe...");
    heartbeatRegistry.reset();

    // 1. Provider 進入 OPEN
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record({ provider: 'p26' }, 100, false, { error: errorMapper.createError('p26', { status: 502, message: "prov fail" }) });
    }
    const provNode = heartbeatRegistry.getNode('p26');
    assert.strictEqual(provNode.state, 'OPEN');

    // 2. 冷卻結束，簽發 Provider 探針
    advanceTime(30000);
    const admission = heartbeatRegistry.canPass('p26', 'model-nonexistent');
    assert.strictEqual(admission.allowed, true);
    assert.strictEqual(admission.isCanary, true);
    const pToken = admission.tokens.providerToken;
    assert.ok(pToken);
    assert.strictEqual(provNode.state, 'HALF-OPEN');
    assert.strictEqual(provNode.probeActive, true);

    // 3. Model 回傳 404 Model Not Found (faultScope = 'MODEL')
    const err404 = errorMapper.createError('p26', {
      status: 404,
      message: "Model model-nonexistent not found"
    });
    assert.strictEqual(err404.faultScope, 'MODEL', "404 for model must have MODEL faultScope");

    // 4. 記錄失敗
    heartbeatRegistry.record(
      { provider: 'p26', modelId: 'model-nonexistent' },
      50,
      false,
      { error: err404, tokens: admission.tokens }
    );

    // 5. 斷言：
    // - Model 節點標記為故障 (404 為 permanent OPEN)
    const modelNode = heartbeatRegistry.getNode('p26:model-nonexistent');
    assert.strictEqual(modelNode.state, 'OPEN');
    assert.strictEqual(modelNode.permanent, true);

    // - Provider 節點絕不可被判定為失敗 (不得轉回 OPEN，失敗次數不得增加)
    assert.strictEqual(provNode.state, 'HALF-OPEN', "Provider must remain in HALF-OPEN (not tripped to OPEN)");
    assert.strictEqual(provNode.consecutiveFailures, 3, "Provider consecutiveFailures must not increase");

    // - Provider 探針必須中性釋放 (probeActive = false)，不得留下永久懸掛
    assert.strictEqual(provNode.probeActive, false, "Provider probeActive must be neutrally released to false");
    assert.strictEqual(provNode.probeToken, null, "Provider probeToken must be cleared");

    // - 驗證下一個正常 Model 請求可以立即准入探針，無須等待逾時！
    const nextAdmission = heartbeatRegistry.canPass('p26', 'model-good');
    assert.strictEqual(nextAdmission.allowed, true, "Next canary attempt must be immediately allowed without hanging");
    assert.strictEqual(nextAdmission.isCanary, true);
    assert.ok(nextAdmission.tokens.providerToken);
    assert.notStrictEqual(nextAdmission.tokens.providerToken, pToken, "New probe token must be granted");

    console.log("  ✅ PASS: Model 404 精確隔離於 Model 層級，Provider 探針安全中性釋放且無懸掛狀態。");
  }

  // ----------------------------------------------------
  // Test 27: Provider HALF-OPEN + Provider 502，Provider 正確重新 OPEN
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 27: Provider HALF-OPEN + Provider 502，Provider 正確重新 OPEN 並倍增冷卻期...");
    heartbeatRegistry.reset();

    // 1. Provider 進入 OPEN (初始冷卻 30000ms)
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record({ provider: 'p27' }, 100, false, { error: errorMapper.createError('p27', { status: 502, message: "prov fail" }) });
    }
    const provNode = heartbeatRegistry.getNode('p27');
    assert.strictEqual(provNode.state, 'OPEN');
    const genBefore = provNode.generation;

    // 2. 冷卻結束，簽發探針
    advanceTime(30000);
    const admission = heartbeatRegistry.canPass('p27', 'model-A');
    assert.strictEqual(admission.allowed, true);
    assert.strictEqual(admission.isCanary, true);
    assert.strictEqual(provNode.state, 'HALF-OPEN');
    assert.strictEqual(provNode.probeActive, true);

    // 3. Provider 回傳 502 Bad Gateway (faultScope = 'PROVIDER')
    const err502 = errorMapper.createError('p27', {
      status: 502,
      message: "Bad gateway upstream"
    });
    assert.strictEqual(err502.faultScope, 'PROVIDER');

    // 4. 記錄失敗
    heartbeatRegistry.record(
      { provider: 'p27', modelId: 'model-A' },
      100,
      false,
      { error: err502, tokens: admission.tokens }
    );

    // 5. 斷言 Provider 正確重新進入 OPEN，並執行指數退避
    assert.strictEqual(provNode.state, 'OPEN', "Provider must trip back to OPEN on probe failure");
    assert.strictEqual(provNode.probeActive, false, "probeActive must be reset");
    assert.strictEqual(provNode.probeToken, null);
    assert.strictEqual(provNode.currentCooldownMs, 60000, "Cooldown must double to 60000ms on consecutive canary failure");
    assert.strictEqual(provNode.generation, genBefore + 1, "Generation must have incremented");

    // 6. 立即檢查准入：必須拒絕
    const rejectCheck = heartbeatRegistry.canPass('p27', 'model-A');
    assert.strictEqual(rejectCheck.allowed, false);
    assert.strictEqual(rejectCheck.reason, 'CIRCUIT_OPEN');

    console.log("  ✅ PASS: Provider 502 探針失敗後正確重回 OPEN，冷卻時間指數退避且立即拒絕流量。");
  }

  // ----------------------------------------------------
  // Test 28: 舊 Provider Token 不得解除新一代 Provider Probe
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 28: 舊 Provider Token 不得解除新一代 Provider Probe (Generation Anti-Ghosting)...");
    heartbeatRegistry.reset();

    // 1. Provider 進入 OPEN
    for (let i = 1; i <= 3; i++) {
      heartbeatRegistry.record({ provider: 'p28' }, 100, false, { error: errorMapper.createError('p28', { status: 502, message: "prov fail" }) });
    }
    const provNode = heartbeatRegistry.getNode('p28');
    assert.strictEqual(provNode.state, 'OPEN');

    // 2. 冷卻結束，簽發 Gen 1 探針
    advanceTime(30000);
    const admissionGen1 = heartbeatRegistry.canPass('p28', 'model-A');
    assert.strictEqual(admissionGen1.allowed, true);
    const staleGen1Token = admissionGen1.tokens.providerToken;
    assert.strictEqual(provNode.generation, 1);
    assert.strictEqual(provNode.probeActive, true);

    // 3. 模擬探針失敗，觸發 Provider 重新 OPEN，進展至 Gen 2
    heartbeatRegistry.record(
      { provider: 'p28', modelId: 'model-A' },
      100,
      false,
      { error: errorMapper.createError('p28', { status: 502, message: "gen1 fail" }), tokens: admissionGen1.tokens }
    );
    assert.strictEqual(provNode.state, 'OPEN');

    // 4. 第二輪冷卻期結束 (60000ms)，簽發 Gen 2 探針
    advanceTime(60000);
    const admissionGen2 = heartbeatRegistry.canPass('p28', 'model-A');
    assert.strictEqual(admissionGen2.allowed, true);
    const activeGen2Token = admissionGen2.tokens.providerToken;
    assert.strictEqual(provNode.generation, 2);
    assert.strictEqual(provNode.probeActive, true);
    assert.strictEqual(provNode.probeToken, activeGen2Token);

    // 5. 企圖使用遲到的舊 Gen 1 Token 回報成功：必須被堅決拒絕
    heartbeatRegistry.record(
      { provider: 'p28', modelId: 'model-A' },
      50,
      true,
      { tokens: { providerToken: staleGen1Token } }
    );

    // 斷言：Gen 2 的 HALF-OPEN 狀態與探針完全不受影響
    assert.strictEqual(provNode.state, 'HALF-OPEN', "Provider must remain in HALF-OPEN after stale token rejected");
    assert.strictEqual(provNode.probeActive, true, "Gen 2 probe must still be active");
    assert.strictEqual(provNode.probeToken, activeGen2Token, "Gen 2 probe token must remain intact");
    assert.strictEqual(provNode.generation, 2);

    // 6. 使用合法的 Gen 2 Token 回報成功：正確修復
    heartbeatRegistry.record(
      { provider: 'p28', modelId: 'model-A' },
      50,
      true,
      { tokens: admissionGen2.tokens }
    );
    assert.strictEqual(provNode.state, 'CLOSED', "Provider heals to CLOSED when valid Gen 2 token arrives");
    assert.strictEqual(provNode.probeActive, false);
    assert.strictEqual(provNode.probeToken, null);

    console.log("  ✅ PASS: 跨世代幽靈 Token 被堅決拒絕，只有本世代有效 Provider Token 方可結算。");
  }

  console.log("\n==================================================");
  console.log("📊 [P0-B Step 4.2-B-2 Results]: 28/28 passed (100%)");
  console.log("==================================================\n");
}

runTests().catch(err => {
  console.error("❌ Test Suite Failed:", err);
  process.exit(1);
});
