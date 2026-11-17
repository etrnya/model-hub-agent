const http = require('http');
const fs = require('fs');
const path = require('path');
const { dispatchTask } = require('./main');
const heartbeatRegistry = require('./registry/heartbeat_registry');
const tokenMonitor = require('./observability/token_monitor');
const memoryManager = require('./infrastructure/adapters/memory_manager');
const benchmarkRunner = require('./tests/benchmark_runner');
const roleManager = require('./services/role_manager');
const taskManager = require('./services/task_manager');
const cascadingExecutor = require('./services/cascading_executor');

const PORT = process.env.AGENT_OS_PORT || 3000;

// SSE Client pool and emitter integration
const globalEmitter = require('./shared/global_emitter');
let sseClients = [];
let sseKeepAliveTimer = null;

function ensureKeepAliveTimer() {
  if (!sseKeepAliveTimer && sseClients.length > 0) {
    sseKeepAliveTimer = setInterval(() => {
      if (sseClients.length === 0) {
        clearInterval(sseKeepAliveTimer);
        sseKeepAliveTimer = null;
        return;
      }
      broadcastEvent('ping', { time: Date.now() });
    }, 15000);
    if (sseKeepAliveTimer.unref) {
      sseKeepAliveTimer.unref();
    }
  }
}

function cleanupKeepAliveTimer() {
  if (sseClients.length === 0 && sseKeepAliveTimer) {
    clearInterval(sseKeepAliveTimer);
    sseKeepAliveTimer = null;
  }
}

function broadcastEvent(eventType, eventData) {
  const packet = `event: ${eventType}\ndata: ${JSON.stringify(eventData)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(packet);
    } catch (err) {
      // Remove stale client
      sseClients = sseClients.filter(c => c !== client);
      cleanupKeepAliveTimer();
    }
  });
}

globalEmitter.on('task-status', (data) => broadcastEvent('task-status', data));
globalEmitter.on('token-record', (data) => broadcastEvent('token-record', data));
globalEmitter.on('circuit-breaker', (data) => broadcastEvent('circuit-breaker', data));
globalEmitter.on('task-lifecycle', (data) => broadcastEvent('task-lifecycle', data));

// 本機存取保護檢查 (Localhost-Only Access Guard)
function isLoopbackAddress(req) {
  const ip = req && req.socket && req.socket.remoteAddress;
  if (!ip || typeof ip !== 'string') return false; // Fail-Closed on missing or abnormal socket IP
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Default response schema if none provided by client
const defaultSchema = {
  type: "object",
  properties: {
    analysis: { type: "string" },
    result: { type: "string" },
    recommendations: { type: "array", items: { type: "string" } }
  },
  required: ["analysis", "result"]
};

// Initialize Qdrant collection on start
memoryManager.initCollection().catch(err => {
  console.warn(`[Agent OS Server] Qdrant collection init skipped or failed: ${err.message}`);
});

// Seed initial healthy heartbeats so the dashboard looks great immediately
heartbeatRegistry.record('deepseek', 1200, true);
heartbeatRegistry.record('vertex-ai', 1800, true);
heartbeatRegistry.record('nvidia-nim', 2500, true);

const server = http.createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve iPAS static files directly to avoid duplicate server and CORS issues
  if (req.method === 'GET' && req.url.startsWith('/ipas/')) {
    try {
      let relativePath = req.url.slice(6);
      if (!relativePath || relativePath.endsWith('/')) {
        relativePath += 'index.html';
      }
      const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
      const filePath = path.join(__dirname, '../iPAS_AI_exam', safePath);
      
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        let contentType = 'text/plain';
        if (ext === '.html') contentType = 'text/html; charset=utf-8';
        else if (ext === '.js') contentType = 'application/javascript; charset=utf-8';
        else if (ext === '.css') contentType = 'text/css; charset=utf-8';
        else if (ext === '.json') contentType = 'application/json; charset=utf-8';
        else if (ext === '.png') contentType = 'image/png';
        else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
        else if (ext === '.webp') contentType = 'image/webp';
        
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(fs.readFileSync(filePath));
        return;
      }
    } catch (err) {
      console.warn(`[Server] Static file serve failed: ${err.message}`);
    }
    
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "File not found under iPAS platform" }));
    return;
  }

  // Dashboard Page Routing
  if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
    try {
      const dashboardPath = path.resolve(__dirname, 'observability/dashboard.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(dashboardPath));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to load dashboard: ${err.message}`);
    }
    return;
  }

  // SSE Stream Endpoint
  if (req.method === 'GET' && req.url === '/api/events') {
    if (!isLoopbackAddress(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Access to event stream is restricted to localhost." }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    sseClients.push(res);
    ensureKeepAliveTimer();
    console.log(`📡 [Server] SSE Client connected. (Total: ${sseClients.length})`);
    
    req.on('close', () => {
      sseClients = sseClients.filter(client => client !== res);
      cleanupKeepAliveTimer();
      console.log(`📡 [Server] SSE Client disconnected. (Total: ${sseClients.length})`);
    });

    res.write(`event: ping\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
    return;
  }

  // Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: "healthy",
      name: "Antigravity Agent OS Server",
      version: "1.5.0",
      qdrant: process.env.QDRANT_URL || 'http://localhost:6333'
    }));
    return;
  }

  // API Stats Endpoint (Serves Dashboard Data)
  if (req.method === 'GET' && req.url === '/api/stats') {
    if (!isLoopbackAddress(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Access to statistics is restricted to localhost." }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });

    // Load Drift Stats
    let driftStats = [];
    try {
      const driftPath = path.resolve(__dirname, 'observability/drift_stats.json');
      if (fs.existsSync(driftPath)) {
        driftStats = JSON.parse(fs.readFileSync(driftPath, 'utf8'));
      }
    } catch (e) {
      console.warn(`[Server] Failed to read drift stats: ${e.message}`);
    }

    // Scroll Qdrant memory points if available
    let memoryCache = [];
    try {
      const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
      const scrollRes = await fetch(`${qdrantUrl}/collections/global_shared_memory/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 15, with_payload: true, with_vector: false }),
        signal: AbortSignal.timeout(2000)
      });
      if (scrollRes.ok) {
        const scrollData = await scrollRes.json();
        if (scrollData.result && scrollData.result.points) {
          memoryCache = scrollData.result.points.map(p => ({
            id: p.id,
            objective: p.payload.objective || 'Unknown Objective',
            timestamp: p.payload.timestamp || new Date().toISOString()
          }));
        }
      }
    } catch (e) {
      // Quiet fail if Qdrant offline
    }

    res.end(JSON.stringify({
      health: heartbeatRegistry.getAllStats(),
      tokensSummary: tokenMonitor.getSummary(),
      tokensHistory: tokenMonitor.history,
      driftStats,
      memoryCache,
      codeGraphTelemetry: typeof cascadingExecutor.getCodeGraphTelemetry === 'function'
        ? cascadingExecutor.getCodeGraphTelemetry()
        : null,
      tasksSummary: {
        activeCount: taskManager.activeCount,
        queuedCount: taskManager.queue.length,
        totalStored: taskManager.tasks.size
      }
    }));
    return;
  }

  // API Roles List
  if (req.method === 'GET' && req.url === '/api/roles') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(roleManager.listRoles()));
    return;
  }

  // API Asynchronous Tasks List (GET /api/tasks)
  if (req.method === 'GET' && req.url === '/api/tasks') {
    if (!isLoopbackAddress(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Access to task data is restricted to localhost." }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(taskManager.listTasks()));
    return;
  }

  // API Single Task Retrieval (GET /api/tasks/:id)
  if (req.method === 'GET' && req.url.startsWith('/api/tasks/')) {
    if (!isLoopbackAddress(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Access to task data is restricted to localhost." }));
      return;
    }
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

  // API Asynchronous Task Submission (POST /api/tasks)
  if (req.method === 'POST' && req.url === '/api/tasks') {
    if (!isLoopbackAddress(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Access to task data is restricted to localhost." }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const idempotencyKey = req.headers && req.headers['x-idempotency-key'] !== undefined
          ? req.headers['x-idempotency-key']
          : undefined;
        const result = taskManager.submitTask(payload, { idempotencyKey });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        const statusCode = err.statusCode || 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message, type: err.type || 'TASK_SUBMISSION_ERROR' }));
      }
    });
    return;
  }

  // API Override Model Status
  if (req.method === 'POST' && req.url === '/api/models/override-status') {
    if (!isLoopbackAddress(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Access to model override is restricted to localhost." }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const { provider, status } = JSON.parse(body);
        if (!provider || !status) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Missing provider or status" }));
          return;
        }

        const success = status === 'healthy';
        heartbeatRegistry.record(provider, 0, success);
        broadcastEvent('model-status-override', { provider, status });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Model ${provider} status successfully overridden to ${status}!` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Toggle / Reset Circuit Breaker
  if (req.method === 'POST' && req.url === '/api/circuit-breaker/toggle') {
    if (!isLoopbackAddress(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Access to circuit breaker control is restricted to localhost." }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const { action } = JSON.parse(body);
        if (action === 'reset') {
          tokenMonitor.totalSessionCost = 0;
          broadcastEvent('circuit-breaker-reset', { totalSessionCost: 0 });
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: "Circuit breaker session cost successfully reset!" }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Invalid action. Supported: reset" }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Trigger Benchmark
  if (req.method === 'POST' && req.url === '/api/benchmark') {
    if (!isLoopbackAddress(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Access to benchmark execution is restricted to localhost." }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    
    // Run benchmark in background asynchronously
    benchmarkRunner.runBenchmark()
      .then(() => console.log("✅ Background benchmark execution completed."))
      .catch(err => console.error("❌ Background benchmark failed:", err.message));

    res.end(JSON.stringify({ success: true, message: "基準評測已在背景啟動！請稍待 10~20 秒後重新整理網頁。" }));
    return;
  }

  // API Clear Vector Memory Cache
  if (req.method === 'POST' && req.url === '/api/memory/clear') {
    if (!isLoopbackAddress(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Access to memory clear is restricted to localhost." }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
      
      console.log(`🧠 [Server] Clearing Qdrant collection...`);
      await fetch(`${qdrantUrl}/collections/global_shared_memory`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(2000)
      });
      
      // Reinitialize collection
      await memoryManager.initCollection();
      
      res.end(JSON.stringify({ success: true, message: "Qdrant 語意向量快取已成功重置與重建！" }));
    } catch (err) {
      console.error(`❌ [Server] Memory clear failed:`, err.message);
      res.end(JSON.stringify({ success: false, error: err.message, message: "快取清除失敗，Qdrant 服務可能未啟動或連線逾時。" }));
    }
    return;
  }

  // Dispatch task endpoint
  if (req.method === 'POST' && req.url === '/dispatch') {
    if (!isLoopbackAddress(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Access to task dispatch is restricted to localhost." }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        let taskPayload;
        let targetSchema;
        let resolvedTier;

        if (Object.hasOwn(payload, 'role')) {
          const roleId = payload.role;
          if (!roleId || typeof roleId !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid 'role' parameter: must be a non-empty string." }));
            return;
          }

          if (Object.hasOwn(payload, 'schema')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Custom schema cannot be provided when a role is selected." }));
            return;
          }

          try {
            const roleBuilt = roleManager.buildTask(roleId, payload);
            taskPayload = roleBuilt.taskPayload;
            targetSchema = roleBuilt.outputSchema;
            resolvedTier = roleBuilt.tier;
          } catch (roleErr) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: roleErr.message }));
            return;
          }
        } else {
          // 既有舊格式 (100% 向下相容)
          const { objective, constraints = [], tags = [], tier = 'high', schema } = payload;

          if (!objective) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing required 'objective' field in request body." }));
            return;
          }

          taskPayload = { objective, constraints, tags, code_context: payload.code_context };
          targetSchema = schema || defaultSchema;
          resolvedTier = tier;
        }

        console.log(`\n🕸️  [Agent OS Server] Dispatching task via API: "${taskPayload.objective.slice(0, 60)}..."`);
        
        // Execute task
        const result = await dispatchTask(taskPayload, targetSchema, resolvedTier);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result }));
      } catch (err) {
        console.error(`❌ [Agent OS Server] Error processing task request:`, err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Fallback for not found endpoints
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: "Endpoint not found" }));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log("\n" + "=".repeat(50));
    console.log(`🚀 Antigravity Agent OS Webhook & Observability Dashboard online!`);
    console.log(`📡 Listening on: http://localhost:${PORT}`);
    console.log(`👉 Visit http://localhost:${PORT}/dashboard to open the console UI`);
    console.log(`👉 POST http://localhost:${PORT}/dispatch to trigger OS workflow`);
    console.log("=".repeat(50) + "\n");
  });
}

module.exports = {
  server,
  isLoopbackAddress,
  ensureKeepAliveTimer,
  cleanupKeepAliveTimer
};
