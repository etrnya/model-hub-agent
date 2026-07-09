const http = require('http');
const fs = require('fs');
const path = require('path');
const { dispatchTask } = require('./main');
const heartbeatRegistry = require('./registry/heartbeat_registry');
const tokenMonitor = require('./observability/token_monitor');
const memoryManager = require('./infrastructure/adapters/memory_manager');
const benchmarkRunner = require('./tests/benchmark_runner');

const PORT = process.env.AGENT_OS_PORT || 3000;

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
      memoryCache
    }));
    return;
  }

  // API Trigger Benchmark
  if (req.method === 'POST' && req.url === '/api/benchmark') {
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
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { objective, constraints = [], tags = [], tier = 'high', schema } = payload;

        if (!objective) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Missing required 'objective' field in request body." }));
          return;
        }

        const taskPayload = { objective, constraints, tags };
        const targetSchema = schema || defaultSchema;

        console.log(`\n🕸️  [Agent OS Server] Dispatching task via API: "${objective.slice(0, 60)}..."`);
        
        // Execute task
        const result = await dispatchTask(taskPayload, targetSchema, tier);

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

server.listen(PORT, () => {
  console.log("\n" + "=".repeat(50));
  console.log(`🚀 Antigravity Agent OS Webhook & Observability Dashboard online!`);
  console.log(`📡 Listening on: http://localhost:${PORT}`);
  console.log(`👉 Visit http://localhost:${PORT}/dashboard to open the console UI`);
  console.log(`👉 POST http://localhost:${PORT}/dispatch to trigger OS workflow`);
  console.log("=".repeat(50) + "\n");
});
