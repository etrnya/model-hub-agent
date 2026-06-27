/**
 * diagnose_keys.js
 * Proactive API key health diagnostic script for Agent OS.
 * Validates Nvidia NIM, DeepSeek, Google AI Studio, and GCP Vertex AI keys.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function testGoogleAIStudio() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { status: "🔴 Missing", reason: "GEMINI_API_KEY not defined in .env" };

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] })
    });

    if (response.ok) {
      return { status: "🟢 Healthy", latency: "OK" };
    } else {
      const data = await response.json().catch(() => ({}));
      const msg = data.error?.message || "Unknown API error";
      if (response.status === 429 && msg.includes("prepayment")) {
        return { status: "🔴 Depleted (429)", reason: "AI Studio Prepayment Credit is 0." };
      }
      return { status: "🔴 Failed", reason: `Status ${response.status}: ${msg}` };
    }
  } catch (e) {
    return { status: "🔴 Error", reason: e.message };
  }
}

async function testGCPVertexAI() {
  const keyPath = process.env.GCP_KEY_PATH || path.join(__dirname, '../gcp-key.json');
  if (!fs.existsSync(keyPath)) {
    return { status: "🔴 Missing", reason: `Key file not found at ${keyPath}` };
  }

  try {
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const projectId = keyData.project_id;
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
      keyFile: keyPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse.token;

    // Use us-central1 and gemini-2.5-flash for test
    const region = "us-central1";
    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/gemini-2.5-flash:generateContent`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] })
    });

    if (response.ok) {
      return { status: "🟢 Healthy (Postpaid)", latency: "OK" };
    } else {
      const data = await response.json().catch(() => ({}));
      return { status: "🔴 Failed", reason: `Status ${response.status}: ${data.error?.message || "Unknown error"}` };
    }
  } catch (e) {
    return { status: "🔴 Error", reason: e.message };
  }
}

async function testNvidiaNIM() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return { status: "🔴 Missing", reason: "NVIDIA_API_KEY not defined in .env" };

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "meta/llama-3.1-8b-instruct",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5
      })
    });

    if (response.ok) {
      return { status: "🟢 Healthy", latency: "OK" };
    } else {
      const data = await response.json().catch(() => ({}));
      return { status: "🔴 Failed", reason: `Status ${response.status}: ${data.error?.message || data.message || "Unknown error"}` };
    }
  } catch (e) {
    return { status: "🔴 Error", reason: e.message };
  }
}

async function testDeepSeek() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return { status: "🔴 Missing", reason: "DEEPSEEK_API_KEY not defined in .env" };

  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5
      })
    });

    if (response.ok) {
      return { status: "🟢 Healthy", latency: "OK" };
    } else {
      const data = await response.json().catch(() => ({}));
      return { status: "🔴 Failed", reason: `Status ${response.status}: ${data.error?.message || data.message || "Unknown error"}` };
    }
  } catch (e) {
    return { status: "🔴 Error", reason: e.message };
  }
}

async function runDiagnostics() {
  console.log("====================================================");
  console.log("🔍 Running API Key Diagnostic Health Check...");
  console.log("====================================================\n");

  const results = {};

  console.log("📡 Testing Google AI Studio API Key...");
  results["Google AI Studio (GEMINI_API_KEY)"] = await testGoogleAIStudio();

  console.log("📡 Testing GCP Vertex AI post-paid (GCP_KEY_PATH)...");
  results["GCP Vertex AI (gcp-key.json)"] = await testGCPVertexAI();

  console.log("📡 Testing NVIDIA NIM API Key...");
  results["NVIDIA NIM (NVIDIA_API_KEY)"] = await testNvidiaNIM();

  console.log("📡 Testing DeepSeek API Key...");
  results["DeepSeek (DEEPSEEK_API_KEY)"] = await testDeepSeek();

  console.log("\n====================================================");
  console.log("📊 API KEY HEALTH DASHBOARD");
  console.log("====================================================");
  console.table(results);
  console.log("====================================================\n");
}

runDiagnostics();
