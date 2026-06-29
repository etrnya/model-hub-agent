const http = require('http');
const { dispatchTask } = require('./main');

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

  // Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: "healthy",
      name: "Antigravity Agent OS Server",
      version: "1.3.0",
      qdrant: process.env.QDRANT_URL || 'http://localhost:6333',
      headroom: process.env.HEADROOM_PROXY_URL || 'http://localhost:8787'
    }));
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
  console.log(`🚀 Antigravity Agent OS Webhook Server online!`);
  console.log(`📡 Listening on: http://localhost:${PORT}`);
  console.log(`👉 POST http://localhost:${PORT}/dispatch to trigger OS workflow`);
  console.log("=".repeat(50) + "\n");
});
