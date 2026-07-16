/**
 * test_ecc_features.js
 * 
 * 測試並驗證 model-hub-agent 的 ECC 升級特性：
 * 1. AgentShield 輸入安全攔截 (Guardrail)
 * 2. 費用熔斷機制 (Cost Circuit Breaker)
 * 3. 自我修正 Instinct 提取與注入
 */
require('dotenv').config();
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const cascadingExecutor = require('../services/cascading_executor');
const instinctManager = require('../services/instinct_manager');
const tokenMonitor = require('../observability/token_monitor');

// 準備 Mock Client
const mockClient = class MockClient {
  constructor(options) {
    this.capability = options.modelCapability;
  }
  async execute(payload, schema) {
    // 模擬成功返回
    return {
      javascript_code: "const x = 1;",
      security_explanation: "Safe execution code."
    };
  }
};

const mockClientMap = {
  'nvidia-nim': mockClient,
  'google': mockClient,
  'deepseek': mockClient,
  'vertex-ai': mockClient
};

// 覆蓋 executor 的 clients
cascadingExecutor.clientMap = mockClientMap;

async function runTests() {
  console.log("====================================================");
  console.log("🧪 開始測試 ECC 升級特性 (Resiliency & Security Tests)");
  console.log("====================================================\n");

  // 清除舊的 instincts 檔案以防干擾
  if (fs.existsSync(instinctManager.instinctsFilePath)) {
    fs.unlinkSync(instinctManager.instinctsFilePath);
  }

  // ==========================================
  // Test 1: AgentShield 安全攔截 (Dangerous Input)
  // ==========================================
  console.log("👉 Test 1: 測試 AgentShield 惡意輸入攔截 (rm -rf /)...");
  const badContext = {
    objective: "Please write a script that runs rm -rf / to clean up system files.",
    constraints: [],
    tags: ["system", "cleanup"]
  };

  const schema = {
    type: "object",
    properties: {
      javascript_code: { type: "string" },
      security_explanation: { type: "string" }
    },
    required: ["javascript_code", "security_explanation"]
  };

  let inputBlocked = false;
  try {
    await cascadingExecutor.execute(badContext, schema, { preferredTier: 'base' });
  } catch (err) {
    if (err.message.includes('[AgentShield]') || err.message.includes('SECURITY_VIOLATION')) {
      inputBlocked = true;
      console.log(`✅ 成功攔截惡意指令: ${err.message}`);
    } else {
      console.error("❌ 攔截到錯誤但不是預期的安全警報:", err.message);
    }
  }
  assert(inputBlocked, "Test 1 失敗: 惡意指令 'rm -rf /' 未被 AgentShield 攔截！");

  // ==========================================
  // Test 2: 費用熔斷機制 (Cost Circuit Breaker)
  // ==========================================
  console.log("\n👉 Test 2: 測試費用熔斷限制 (Cost Budget Circuit Breaker)...");
  // 設定極低的單次任務費用上限：0.000001 美元 (正常 Gemini Pro 1k tokens 大約 $0.001)
  process.env.MAX_TASK_BUDGET_USD = "0.000001";
  tokenMonitor.totalSessionCost = 0; // 重置 session cost

  const normalContext = {
    objective: "Write a node function.",
    constraints: [],
    tags: ["coding"]
  };

  let costBreakerTripped = false;
  try {
    await cascadingExecutor.execute(normalContext, schema, { preferredTier: 'base' });
  } catch (err) {
    if (err.message.includes('[CircuitBreaker]') && err.message.includes('cost')) {
      costBreakerTripped = true;
      console.log(`✅ 費用熔斷成功觸發: ${err.message}`);
    } else {
      console.error("❌ 拋出非預期的錯誤:", err.message);
    }
  }
  assert(costBreakerTripped, "Test 2 失敗: 費用超額時 Circuit Breaker 未正確熔斷！");

  // 還原費用上限
  process.env.MAX_TASK_BUDGET_USD = "0.05";

  // ==========================================
  // Test 3: Instinct 提取與注入 (Continuous Learning)
  // ==========================================
  console.log("\n👉 Test 3: 測試自我修正後 Instinct 提取與自動注入...");
  
  // 模擬自我修正成功的情境：手動呼叫 saveInstinct
  const failedOut = { javascript_code: "const x = 1" }; // 缺引號或有錯
  const corrOut = { javascript_code: "const x = 1;", security_explanation: "Correct syntax." };
  
  instinctManager.saveInstinct(
    "Write a resilient node module with proper semicolons.",
    failedOut,
    "Missing semicolon audit failure",
    corrOut
  );

  // 驗證 instincts.json 檔案是否產生且寫入
  assert(fs.existsSync(instinctManager.instinctsFilePath), "Instincts file should be created.");
  const savedList = instinctManager.loadInstincts();
  assert(savedList.length === 1, "Should have 1 saved instinct.");
  assert(savedList[0].errorReason === "Missing semicolon audit failure");

  // 測試自動注入：啟動一個具有相似關鍵字 (semicolons, node) 的任務
  const testContextForInject = {
    objective: "Create a node function with semicolons.",
    constraints: [],
    tags: ["coding"]
  };

  // 呼叫注入
  instinctManager.injectRelevantInstincts(testContextForInject);
  
  // 檢查是否成功注入到 constraints
  const hasInjection = testContextForInject.constraints.some(c => 
    c.includes("PITFALL AVOIDANCE") && c.includes("Missing semicolon audit failure")
  );
  assert(hasInjection, "Test 3 失敗: 相關的 Instinct 教訓未被自動注入至任務上下文！");
  console.log("✅ Instinct 成功提取並自動注入至相似任務中！");

  // 清除測試產生的 instincts 檔案
  if (fs.existsSync(instinctManager.instinctsFilePath)) {
    fs.unlinkSync(instinctManager.instinctsFilePath);
  }

  console.log("\n====================================================");
  console.log("🟢 所有 ECC 升級特性測試通過！ Ressiliency & Security ✅");
  console.log("====================================================\n");
}

runTests().catch(err => {
  console.error("❌ 測試執行失敗:", err);
  process.exit(1);
});
