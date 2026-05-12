require('dotenv').config();
const NvidiaNimClient = require('./infrastructure/clients/nvidia_nim_client');
const modelRegistry = require('./registry/model_registry');

async function runTest() {
  console.log("🚀 開始測試 NvidiaNimClient...");

  // 1. 從註冊表中取得 NVIDIA 模型的設定
  // 假設我們在 registry 中設定的 model_id 是 "llama-3-70b-instruct" 或是 NVIDIA 的特定 ID
  // 為了確保測試能動，我們直接建構一個測試用的 Capability
  const testCapability = {
    model_id: "meta/llama-3.1-8b-instruct", // 使用較輕量的 8B 模型進行快速測試
    provider: "nvidia-nim",
    context_window: 128000,
    supported_modalities: ["text"],
    performance_tier: "high",
    limits: { rpm: 50, tpm: 100000 }
  };

  // 2. 初始化 Client
  const client = new NvidiaNimClient({
    modelCapability: testCapability,
    promptMapping: { tool_call_template: "You MUST output ONLY a valid raw JSON object. Do not wrap it in markdown block. Do not add any conversational text." },
    retry: { maxRetries: 2, initialDelay: 500 }
  });

  // 3. 準備測試用的 GlobalState (模擬 Agent OS 的任務狀態)
  const dummyState = {
    task_id: "test-001",
    objective: "請以 JSON 格式回應一句簡短的打招呼語，並包含您的模型名稱。請嚴格遵守 JSON 格式。",
    constraints: ["Must be valid JSON", "No markdown blocks"],
    change_log: []
  };

  // 4. 定義我們期望的 JSON Schema
  const expectedSchema = {
    type: "object",
    properties: {
      greeting: { type: "string" },
      model_name: { type: "string" }
    },
    required: ["greeting", "model_name"]
  };

  console.log("📤 發送請求中，等待 NVIDIA 超級電腦回應...\n");

  try {
    const result = await client.execute(dummyState, expectedSchema);
    console.log("✅ 測試成功！NVIDIA NIM 回傳並驗證通過的結構化資料：");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("❌ 測試失敗：", error.message);
  }
}

runTest();
