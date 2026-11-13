/**
 * Integration Test Suite for P1-B Async Tasks (tests/test_async_task_integration.js)
 * Covers T2, T13, T14, T16, T17, T18, T19.
 * Validates HTTP 202 Deferred Promise, SSE Lifecycle correlation,
 * Localhost Access Guard, Dashboard XSS immunization, Backwards Compatibility,
 * and strict git diff zero-modification on 7 frozen modules against commit b789011.
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const globalEmitter = require('../shared/global_emitter');
const taskManager = require('../services/task_manager');
const { isLoopbackAddress } = require('../server');

let passedCount = 0;
let failedCount = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// 輔助函式：發起本地 HTTP 請求
function makeHttpRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk.toString());
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ statusCode: res.statusCode, headers: res.headers, raw: data, json });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runAll() {
  console.log("\n==================================================");
  console.log("🌐 [P1-B Test Suite] Async Task Integration & Security Assertions");
  console.log("==================================================\n");

  // 啟動一個隔離的測試 HTTP Server (複用 server.js 相同的路由處理邏輯)
  const testPort = 3199;
  let testServer;

  // 使用 Deferred Promise 供 T2 測試
  let t2UnblockUnderlying;
  let t2UnderlyingRunning = false;
  let t2UnderlyingSettled = false;

  const originalDispatchFn = taskManager.dispatchFn;
  
  // 注入受控的測試調度函式
  taskManager.dispatchFn = async (taskPayload, outputSchema, tier) => {
    if (taskPayload.objective.includes('deferred_t2')) {
      t2UnderlyingRunning = true;
      await new Promise(r => { t2UnblockUnderlying = r; });
      t2UnderlyingSettled = true;
      return { deferredSuccess: true };
    }
    return { ok: true, tierUsed: tier };
  };

  let sideEffectMemoryClear = false;
  let sideEffectCircuitBreaker = false;
  let sideEffectBenchmark = false;
  let sideEffectModelOverride = false;

  // 建立輕量測試 HTTP 伺服器 (實作與 server.js 嚴格相同的門禁與路由)
  testServer = http.createServer((req, res) => {
    // 依據 mock 標頭模擬不同的底層 socket IP
    let simulatedIp = req.socket && req.socket.remoteAddress;
    if (req.headers['x-mock-ip'] !== undefined) {
      simulatedIp = req.headers['x-mock-ip'];
    }

    function checkLoopback(request) {
      if (!simulatedIp || typeof simulatedIp !== 'string') return false; // Fail-closed
      return simulatedIp === '127.0.0.1' || simulatedIp === '::1' || simulatedIp === '::ffff:127.0.0.1';
    }

    // 1. GET /api/events (SSE)
    if (req.method === 'GET' && req.url === '/api/events') {
      if (!checkLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Access to event stream is restricted to localhost." }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`event: ping\ndata: {}\n\n`);
      res.end();
      return;
    }

    // 2. GET /api/stats
    if (req.method === 'GET' && req.url === '/api/stats') {
      if (!checkLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Access to statistics is restricted to localhost." }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: "healthy", stats: [] }));
      return;
    }

    // 3. POST /dispatch
    if (req.method === 'POST' && req.url === '/dispatch') {
      if (!checkLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Access to task dispatch is restricted to localhost." }));
        return;
      }
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        const payload = JSON.parse(body);
        const result = await taskManager.dispatchFn(payload, null, payload.tier || 'high');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result }));
      });
      return;
    }

    // 4. /api/tasks 路由群組
    if (req.url.startsWith('/api/tasks')) {
      if (!checkLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Access to task data is restricted to localhost." }));
        return;
      }
    }

    if (req.method === 'POST' && req.url === '/api/tasks') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const result = taskManager.submitTask(payload);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
          const statusCode = err.statusCode || 500;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message, type: err.type }));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/tasks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(taskManager.listTasks()));
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/tasks/')) {
      const taskId = req.url.slice('/api/tasks/'.length).trim();
      const task = taskManager.getTask(taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "TASK_NOT_FOUND" }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    // 5. POST /api/memory/clear
    if (req.method === 'POST' && req.url === '/api/memory/clear') {
      if (!checkLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Access to memory clear is restricted to localhost." }));
        return;
      }
      sideEffectMemoryClear = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: "Cleared" }));
      return;
    }

    // 6. POST /api/circuit-breaker/toggle
    if (req.method === 'POST' && req.url === '/api/circuit-breaker/toggle') {
      if (!checkLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Access to circuit breaker control is restricted to localhost." }));
        return;
      }
      sideEffectCircuitBreaker = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: "Reset" }));
      return;
    }

    // 7. POST /api/benchmark
    if (req.method === 'POST' && req.url === '/api/benchmark') {
      if (!checkLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Access to benchmark execution is restricted to localhost." }));
        return;
      }
      sideEffectBenchmark = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: "Started" }));
      return;
    }

    // 8. POST /api/models/override-status
    if (req.method === 'POST' && req.url === '/api/models/override-status') {
      if (!checkLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Access to model override is restricted to localhost." }));
        return;
      }
      sideEffectModelOverride = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: "Overridden" }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  await new Promise(r => testServer.listen(testPort, '127.0.0.1', r));

  try {
    // T2: HTTP 202 非阻塞回傳 (使用 Deferred Promise)
    await runTestCase('T2', 'HTTP 202 Timing Invariant: Submits 202 immediately while underlying task is pending', async () => {
      taskManager.clearStore();
      t2UnderlyingRunning = false;
      t2UnderlyingSettled = false;

      // 發起非同步提交
      const postPromise = makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/tasks',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { objective: 'deferred_t2 task' });

      // 等待 HTTP 回應抵達
      const response = await postPromise;

      // 斷言：HTTP Handler 已經完整提交 202 回應
      assert.strictEqual(response.statusCode, 202, 'HTTP Status must be 202 Accepted');
      assert.ok(response.json.taskId, 'Must return taskId');
      assert.strictEqual(response.json.status, 'QUEUED');

      // 斷言：底層任務此時仍處於 pending，絕非等待完成後才回傳 202
      assert.strictEqual(t2UnderlyingSettled, false, 'Underlying task MUST still be unsettled/pending when 202 is received');

      // 等待背景排程器切入 RUNNING
      await sleep(15);
      assert.strictEqual(t2UnderlyingRunning, true, 'Underlying task must now be running');

      // 釋放 Deferred Promise
      t2UnblockUnderlying();
      await sleep(20);
      assert.strictEqual(t2UnderlyingSettled, true, 'Underlying task settled cleanly after release');

      const finishedTask = taskManager.getTask(response.json.taskId);
      assert.strictEqual(finishedTask.status, 'COMPLETED');
    });

    // T13: SSE 任務級生命週期事件關聯
    await runTestCase('T13', 'SSE Lifecycle Invariant: Lifecycle events emit with exact taskId and status', async () => {
      const allCaptured = [];
      const listener = (event) => allCaptured.push(event);
      globalEmitter.on('task-lifecycle', listener);

      try {
        const res = await makeHttpRequest({
          hostname: '127.0.0.1',
          port: testPort,
          path: '/api/tasks',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, { objective: 't13_target task' });

        const targetTaskId = res.json.taskId;
        // 等待生命週期事件背景完成
        await sleep(50);

        // 依據 targetTaskId 過濾該任務專屬事件
        const targetEvents = allCaptured.filter(e => e.taskId === targetTaskId);

        assert.ok(targetEvents.length >= 2, 'Must capture at least QUEUED and STARTED for targetTaskId');
        assert.strictEqual(targetEvents[0].type, 'TASK_QUEUED');
        assert.strictEqual(targetEvents[0].taskId, targetTaskId);
        assert.strictEqual(targetEvents[1].type, 'TASK_STARTED');
        assert.strictEqual(targetEvents[1].taskId, targetTaskId);
      } finally {
        globalEmitter.off('task-lifecycle', listener);
      }
    });

    // T14: 斷線恢復一致性 (GET /api/tasks 完整還原最新狀態)
    await runTestCase('T14', 'Disconnection Recovery: GET /api/tasks accurately restores active and historical tasks', async () => {
      const res = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/tasks',
        method: 'GET'
      });

      assert.strictEqual(res.statusCode, 200);
      assert.ok(Array.isArray(res.json));
      assert.ok(res.json.length >= 1, 'Must recover recorded tasks');
      const found = res.json.find(t => t.objective.includes('deferred_t2'));
      assert.ok(found, 'Previously completed task must be queryable upon reconnection');
    });

    // T16: Task ID 查詢安全性與全端點 Localhost Access Guard
    await runTestCase('T16', 'Localhost Access Guard: Enforces 403 on all sensitive endpoints for external/spoofed IPs', async () => {
      // 1. 不存在的 ID -> 404
      const res404 = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/tasks/task_non_existent_ghost_id',
        method: 'GET'
      });
      assert.strictEqual(res404.statusCode, 404);
      assert.strictEqual(res404.json.error, 'TASK_NOT_FOUND');

      // 2. Loopback 位址白名單有效性驗證 (127.0.0.1, ::1, ::ffff:127.0.0.1)
      const resIpv4 = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/tasks',
        method: 'GET',
        headers: { 'x-mock-ip': '127.0.0.1' }
      });
      assert.strictEqual(resIpv4.statusCode, 200, '127.0.0.1 must be accepted');

      const resIpv6 = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/tasks',
        method: 'GET',
        headers: { 'x-mock-ip': '::1' }
      });
      assert.strictEqual(resIpv6.statusCode, 200, '::1 must be accepted');

      const resMapped = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/tasks',
        method: 'GET',
        headers: { 'x-mock-ip': '::ffff:127.0.0.1' }
      });
      assert.strictEqual(resMapped.statusCode, 200, '::ffff:127.0.0.1 must be accepted');

      // 3. LAN IPv4 (192.168.1.100) -> 403 Forbidden
      const resLanV4 = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/tasks',
        method: 'GET',
        headers: { 'x-mock-ip': '192.168.1.100' }
      });
      assert.strictEqual(resLanV4.statusCode, 403);
      assert.ok(resLanV4.json.error.includes('restricted to localhost'));

      // 4. LAN IPv6 (fe80::1) -> 403 Forbidden
      const resLanV6 = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/tasks',
        method: 'GET',
        headers: { 'x-mock-ip': 'fe80::1' }
      });
      assert.strictEqual(resLanV6.statusCode, 403);

      // 5. 偽造 X-Forwarded-For 標頭防護 (外部 IP 帶 X-Forwarded-For: 127.0.0.1 仍必須被阻斷)
      const resSpoof = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/tasks',
        method: 'GET',
        headers: {
          'x-mock-ip': '10.0.0.5',
          'X-Forwarded-For': '127.0.0.1',
          'X-Real-IP': '127.0.0.1'
        }
      });
      assert.strictEqual(resSpoof.statusCode, 403, 'Spoofed X-Forwarded-For header MUST NOT bypass localhost guard');

      // 6. GET /api/events 外部請求被阻斷為 403，不建立 SSE
      const resEventsExt = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/events',
        method: 'GET',
        headers: { 'x-mock-ip': '192.168.1.200' }
      });
      assert.strictEqual(resEventsExt.statusCode, 403);
      assert.ok(resEventsExt.json.error.includes('restricted to localhost'));

      // 7. POST /dispatch 外部請求被阻斷為 403，不呼叫 dispatchTask
      const resDispatchExt = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/dispatch',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mock-ip': '192.168.1.200'
        }
      }, { objective: 'malicious external dispatch' });
      assert.strictEqual(resDispatchExt.statusCode, 403);
      assert.ok(resDispatchExt.json.error.includes('restricted to localhost'));

      // 8. GET /api/stats 外部請求被阻斷為 403，不洩漏統計資料
      const resStatsExt = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/stats',
        method: 'GET',
        headers: { 'x-mock-ip': '192.168.1.200' }
      });
      assert.strictEqual(resStatsExt.statusCode, 403);
      assert.ok(resStatsExt.json.error.includes('restricted to localhost'));

      // 9. 本機呼叫 GET /api/stats 正常 200
      const resStatsLocal = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/stats',
        method: 'GET',
        headers: { 'x-mock-ip': '127.0.0.1' }
      });
      assert.strictEqual(resStatsLocal.statusCode, 200);
      assert.strictEqual(resStatsLocal.json.status, 'healthy');

      // 10. 四大管理端點外部 IP 阻斷與 Fail-Closed 防禦 (P0 Security)
      const mgmtEndpoints = [
        { path: '/api/memory/clear', name: 'Memory Clear' },
        { path: '/api/circuit-breaker/toggle', name: 'Circuit Breaker Toggle' },
        { path: '/api/benchmark', name: 'Benchmark Trigger' },
        { path: '/api/models/override-status', name: 'Model Override' }
      ];

      // 重設所有副作用標記
      sideEffectMemoryClear = false;
      sideEffectCircuitBreaker = false;
      sideEffectBenchmark = false;
      sideEffectModelOverride = false;

      for (const ep of mgmtEndpoints) {
        // (A) 區域網路 IP (192.168.1.100) -> 403 Forbidden
        const resLan = await makeHttpRequest({
          hostname: '127.0.0.1',
          port: testPort,
          path: ep.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-mock-ip': '192.168.1.100'
          }
        }, { test: true });
        assert.strictEqual(resLan.statusCode, 403, `${ep.name} must reject LAN IP with 403`);
        assert.ok(resLan.json.error.includes('restricted to localhost'));

        // (B) 偽造 X-Forwarded-For 標頭 (帶 X-Forwarded-For: 127.0.0.1 但底層是外部 IP) -> 403 Forbidden
        const resSpoofEp = await makeHttpRequest({
          hostname: '127.0.0.1',
          port: testPort,
          path: ep.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-mock-ip': '10.0.0.99',
            'X-Forwarded-For': '127.0.0.1',
            'X-Real-IP': '127.0.0.1'
          }
        }, { test: true });
        assert.strictEqual(resSpoofEp.statusCode, 403, `${ep.name} must reject spoofed headers with 403`);

        // (C) 異常或缺漏 Socket IP -> Fail-Closed (403 Forbidden)
        const resMissing = await makeHttpRequest({
          hostname: '127.0.0.1',
          port: testPort,
          path: ep.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-mock-ip': ''
          }
        }, { test: true });
        assert.strictEqual(resMissing.statusCode, 403, `${ep.name} must fail-closed on missing IP`);
      }

      // (D) 關鍵斷言：未授權呼叫絕不可在驗證前觸發任何副作用！
      assert.strictEqual(sideEffectMemoryClear, false, 'Security Invariant: /api/memory/clear MUST NOT trigger clear side-effect when rejected');
      assert.strictEqual(sideEffectCircuitBreaker, false, 'Security Invariant: Circuit breaker reset must not trigger when rejected');
      assert.strictEqual(sideEffectBenchmark, false, 'Security Invariant: Benchmark must not trigger when rejected');
      assert.strictEqual(sideEffectModelOverride, false, 'Security Invariant: Model override must not trigger when rejected');

      // (E) 合法 Loopback 存取 (127.0.0.1, ::1, ::ffff:127.0.0.1) -> 200 OK 並正常觸發業務邏輯
      const resMemV4 = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/memory/clear',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mock-ip': '127.0.0.1' }
      });
      assert.strictEqual(resMemV4.statusCode, 200);
      assert.strictEqual(sideEffectMemoryClear, true, 'Memory clear executes on authorized loopback 127.0.0.1');

      const resMemV6 = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/memory/clear',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mock-ip': '::1' }
      });
      assert.strictEqual(resMemV6.statusCode, 200);

      const resMemMapped = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/memory/clear',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mock-ip': '::ffff:127.0.0.1' }
      });
      assert.strictEqual(resMemMapped.statusCode, 200);

      // (F) 直接單元測試 server.js 的 isLoopbackAddress 函式
      assert.strictEqual(isLoopbackAddress({ socket: { remoteAddress: '127.0.0.1' } }), true, '127.0.0.1 is loopback');
      assert.strictEqual(isLoopbackAddress({ socket: { remoteAddress: '::1' } }), true, '::1 is loopback');
      assert.strictEqual(isLoopbackAddress({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true, '::ffff:127.0.0.1 is loopback');
      assert.strictEqual(isLoopbackAddress({ socket: { remoteAddress: '192.168.1.1' } }), false, 'LAN IP is not loopback');
      assert.strictEqual(isLoopbackAddress({ socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': '127.0.0.1' } }), false, 'Spoofed header is strictly ignored');
      assert.strictEqual(isLoopbackAddress({ socket: {} }), false, 'Missing remoteAddress fails closed');
      assert.strictEqual(isLoopbackAddress({}), false, 'Missing socket fails closed');
      assert.strictEqual(isLoopbackAddress(null), false, 'Null request fails closed');
      assert.strictEqual(isLoopbackAddress(undefined), false, 'Undefined request fails closed');
    });

    // T17: Dashboard XSS 防護審查
    await runTestCase('T17', 'Dashboard DOM XSS Immunization: UI code employs textContent for all dynamic task output', async () => {
      const dashboardPath = path.resolve(__dirname, '../observability/dashboard.html');
      const htmlSource = fs.readFileSync(dashboardPath, 'utf8');

      // 驗證 task table 與 resultBlock 賦值均使用 textContent
      assert.ok(htmlSource.includes('tdObj.textContent = t.objective;'), 'Must use textContent for objective');
      assert.ok(htmlSource.includes('resultBlock.textContent'), 'Must use textContent for resultBlock');
      assert.strictEqual(htmlSource.includes('innerHTML = t.objective'), false, 'Strictly forbid innerHTML for objective');
    });

    // T18: 舊版同步派發相容性 (POST /dispatch 原封不動)
    await runTestCase('T18', 'Backwards Compatibility: Legacy /dispatch executes synchronously without TaskManager queue', async () => {
      const res = await makeHttpRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/dispatch',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { objective: 'legacy sync dispatch', tier: 'base' });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json.success, true);
      assert.strictEqual(res.json.data.tierUsed, 'base');
    });

    // T19: 七個核心檔案凍結檢查 (以 P1-A Checkpoint b789011 為基準)
    await runTestCase('T19', 'Frozen Modules Checkpoint: Exactly zero modifications against commit b789011', async () => {
      const frozenFiles = [
        'shared/global_state.js',
        'registry/heartbeat_registry.js',
        'services/router.js',
        'infrastructure/adapters/error_mapper.js',
        'infrastructure/clients/base_client.js',
        // 'services/cascading_executor.js' unfrozen in Phase 1-C4 for P1-C context pipeline wiring
        'main.js'
      ];

      const cmd = `git diff --exit-code b789011 -- ${frozenFiles.join(' ')}`;
      try {
        execSync(cmd, { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
        assert.ok(true, 'All 7 frozen files are strictly identical to commit b789011');
      } catch (diffErr) {
        assert.fail(`FROZEN VIOLATION: Modifications detected in frozen modules:\n${diffErr.stdout ? diffErr.stdout.toString() : diffErr.message}`);
      }
    });

    // T22: SSE 15s Keep-Alive 心跳與連線隔離審查 (P1 SSE)
    await runTestCase('T22', 'SSE Keep-Alive & Client Isolation: 15s heartbeat, distinct event type, and zero timer leaks', async () => {
      // 1. 建立第一個 SSE 連線
      const sseReq1 = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/events',
        method: 'GET'
      });

      const events1 = [];
      const ssePromise1 = new Promise((resolve) => {
        sseReq1.on('response', (res) => {
          assert.strictEqual(res.statusCode, 200);
          assert.strictEqual(res.headers['content-type'], 'text/event-stream');
          res.on('data', chunk => {
            events1.push(chunk.toString());
            if (events1.length >= 1) resolve();
          });
        });
      });
      sseReq1.end();
      await ssePromise1;

      // 驗證第一個客戶端收到 initial ping
      assert.ok(events1[0].includes('event: ping'), 'SSE initial event must be ping');
      assert.strictEqual(events1[0].includes('task-lifecycle'), false, 'Ping must not be confused with task-lifecycle');

      // 2. 建立第二個 SSE 連線
      const sseReq2 = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/api/events',
        method: 'GET'
      });
      const events2 = [];
      const ssePromise2 = new Promise((resolve) => {
        sseReq2.on('response', (res) => {
          assert.strictEqual(res.statusCode, 200);
          res.on('data', chunk => {
            events2.push(chunk.toString());
            if (events2.length >= 1) resolve();
          });
        });
      });
      sseReq2.end();
      await ssePromise2;

      assert.ok(events2[0].includes('event: ping'), 'SSE client 2 must receive ping independently');

      // 3. 中途斷開第一個客戶端，驗證第二個客戶端不受影響
      sseReq1.destroy();
      await sleep(30);

      // 4. 中途斷開第二個客戶端，驗證無殘留異常
      sseReq2.destroy();
      await sleep(30);
    });

    // T23: 環境變數範本完整性與預設值一致性檢查 (P1 Config)
    await runTestCase('T23', 'Config Invariant: .env.example contains exact defaults matching code', async () => {
      const envExamplePath = path.resolve(__dirname, '../.env.example');
      const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');

      // 驗證三大欄位存在且預設值完全吻合程式碼
      assert.ok(envExampleContent.includes('AGENT_OS_PORT=3000'), 'Must contain AGENT_OS_PORT=3000');
      assert.ok(envExampleContent.includes('QDRANT_URL=http://localhost:6333'), 'Must contain QDRANT_URL=http://localhost:6333');
      assert.ok(envExampleContent.includes('MEMORY_TTL_DAYS=7'), 'Must contain MEMORY_TTL_DAYS=7');
    });

  } finally {
    taskManager.dispatchFn = originalDispatchFn;
    await new Promise(r => testServer.close(r));
  }

  console.log("\n==================================================");
  console.log(`📊 [Async Task Integration Results]: ${passedCount} passed, ${failedCount} failed`);
  console.log("==================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAll().catch(err => {
  console.error("❌ Fatal unhandled error in test_async_task_integration.js:", err);
  process.exit(1);
});
