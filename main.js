require('dotenv').config();
const router = require('./services/router');
const NvidiaNimClient = require('./infrastructure/clients/nvidia_nim_client');
const GeminiClient = require('./infrastructure/clients/gemini_client');
const DeepSeekClient = require('./infrastructure/clients/deepseek_client');
const VertexAIClient = require('./infrastructure/clients/vertex_ai_client');

const clientMap = {
  'nvidia-nim': NvidiaNimClient,
  'google': GeminiClient,
  'deepseek': DeepSeekClient,
  'vertex-ai': VertexAIClient
};

/**
 * Antigravity Agent OS - 總司令指令 (main.js)
 * 
 * 這是您專案的入口點。
 * 透過這裡執行任務，可以自動享受分層調度 (Router)、上下文壓縮 (Compressor) 
 * 以及語法修復 (SilentFix) 所帶來的 Token 節省效益。
 */
const GlobalState = require('./shared/global_state');
const heartbeatRegistry = require('./registry/heartbeat_registry');

/**
 * Antigravity Agent OS - 總司令指令 (main.js)
 */
async function dispatchTask(taskPayload, outputSchema, tier = "base") {
  // 1. 安全護欄檢查 (Guardrail Layer)
  const guardrail = require('./services/guardrail_manager');
  const securityScan = await guardrail.scan(taskPayload);
  
  if (!securityScan.safe) {
    console.error(`\n🛑 [Agent OS] 任務遭拒絕: ${securityScan.reason}`);
    return;
  }

  const activePayload = securityScan.sanitizedPayload;
  if (securityScan.reason === "Sanitized") {
    console.log("🛡️  [Guardrail] 已自動遮蔽敏感資訊，確保數據安全。");
  }

  // 2. 初始化全域狀態 (具備版本控制)
  const stateManager = new GlobalState(activePayload);
  const currentSnapshot = stateManager.getSnapshot();

  // 2. 執行任務 (具備級聯降級機制)
  const cascadingExecutor = require('./services/cascading_executor');
  
  try {
    console.log("⚙️  [Agent OS] 正在處理您的請求 (OCC Version: " + currentSnapshot.version + ")...");
    
    const executionResult = await cascadingExecutor.execute(currentSnapshot, outputSchema, {
      preferredTier: tier
    });

    const primaryResult = executionResult.data;
    const capability = executionResult.modelUsed;
    
    // 5. 雙重驗證閘門 (Dual-Verification)
    const verificationGate = require('./services/verification_gate');
    const context = {
      ...currentSnapshot,
      primaryModelId: capability.model_id,
      tier: tier,
      tags: taskPayload.tags || []
    };

    const clientFactory = (cap) => {
      const Cls = clientMap[cap.provider];
      return new Cls({ modelCapability: cap });
    };

    const verification = await verificationGate.verify(primaryResult, context, clientFactory);

    if (!verification.success) {
       console.log("🔄 [Agent OS] 驗證失敗，正在嘗試自我修正 (未實作，目前僅記錄)...");
       // TODO: Implement self-correction loop here
    }

    const finalData = verification.data || primaryResult;

    // 6. 更新狀態
    const updateSuccess = stateManager.update(finalData, currentSnapshot.version);
    
    if (updateSuccess) {
      console.log("\n" + "=".repeat(30));
      console.log("✨ [任務完成結果 - 已存入 GlobalState]:");
      console.log(JSON.stringify(stateManager.getSnapshot(), null, 2));
      console.log("=".repeat(30));
    }
    
    // 7. 顯示系統健康度與 Token 報告
    const tokenMonitor = require('./observability/token_monitor');
    tokenMonitor.display();

    console.log("\n📊 [系統觀測指標]:");
    console.table(heartbeatRegistry.getAllStats());

  } catch (error) {
    console.error("\n❌ [系統回報錯誤]:", error.message);
  }
}

// ==========================================
// 💡 執行範例 (僅在直接執行 main.js 時啟動)
// ==========================================
if (require.main === module) {
  const taskData = {
    objective: "請幫我寫一個 Node.js 函式，用於加密用戶密碼。必須使用 bcrypt，且 salt rounds 為 12。",
    constraints: ["使用 CommonJS 語法", "函式必須是非同步的 (async)", "包含錯誤處理邏輯"],
    tags: ["coding", "security"]
  };

  const schema = {
    type: "object",
    properties: {
      javascript_code: { type: "string" },
      security_explanation: { type: "string" }
    },
    required: ["javascript_code", "security_explanation"]
  };

  dispatchTask(taskData, schema, "high");
}

module.exports = { dispatchTask };
