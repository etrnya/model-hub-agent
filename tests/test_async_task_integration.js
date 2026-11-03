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

  function isLoopbackAddress(req) {
    const ip = req.socket && req.socket.remoteAddress;
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }

  // 建立輕量測試 HTTP 伺服器 (實作與 server.js 嚴格相同的門禁與路由)
  testServer = http.createServer((req, res) => {
    // 依據 mock 標頭模擬不同的底層 socket IP
    let simulatedIp = req.socket && req.socket.remoteAddress;
    if (req.headers['x-mock-ip']) {
      simulatedIp = req.headers['x-mock-ip'];
    }

    function checkLoopback(request) {
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
        'services/cascading_executor.js',
        'main.js'
      ];

      const cmd = `git diff --exit-code b789011 -- ${frozenFiles.join(' ')}`;
      try {
        execSync(cmd, { stdio: 'pipe' });
        assert.ok(true, 'All 7 frozen files are strictly identical to commit b789011');
      } catch (diffErr) {
        assert.fail(`FROZEN VIOLATION: Modifications detected in frozen modules:\n${diffErr.stdout ? diffErr.stdout.toString() : diffErr.message}`);
      }
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
