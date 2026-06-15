require('dotenv').config();
const DeepSeekClient = require('../infrastructure/clients/deepseek_client');
const GeminiClient = require('../infrastructure/clients/gemini_client');
const NvidiaNimClient = require('../infrastructure/clients/nvidia_nim_client');
const verificationGate = require('../services/verification_gate');

// 1. Client Factory: Returns the correct client instance based on the router's choice
function clientFactory(modelCapability) {
  const config = { 
    modelCapability, 
    retry: { maxRetries: 2, initialDelay: 500 } 
  };
  
  switch (modelCapability.provider) {
    case 'deepseek':
      config.promptMapping = { tool_call_template: "Return valid JSON ONLY." };
      return new DeepSeekClient(config);
    case 'google':
      return new GeminiClient(config);
    case 'nvidia-nim':
      config.promptMapping = { tool_call_template: "Return valid JSON ONLY." };
      return new NvidiaNimClient(config);
    default:
      throw new Error("Unknown provider: " + modelCapability.provider);
  }
}

async function runIntegrationTest() {
  console.log("🚀 [Agent OS] 開始執行跨模型整合測試 (DeepSeek 草擬 -> Gemini 審核)\n");

  // ==========================================
  // 階段 1: NVIDIA 負責草擬 (Drafting Phase)
  // ==========================================
  console.log("📝 [Phase 1] 指派任務給 NVIDIA Llama 8B...");
  
  const primaryCapability = {
    model_id: "meta/llama-3.1-8b-instruct",
    provider: "nvidia-nim",
    context_window: 128000,
    supported_modalities: ["text"],
    performance_tier: "high",
    limits: { rpm: 50, tpm: 100000 }
  };

  const drafter = clientFactory(primaryCapability);

  const draftContext = {
    task_id: "report-gen-001",
    objective: "請草擬一份 2024 年第一季度的虛構產品營收報告大綱。請包含三個主要產品線。確保所有的銷售額總和為 100 萬美元。",
    constraints: ["總銷售額必須精確等於 1,000,000", "必須是 JSON 格式"],
    change_log: []
  };

  const draftSchema = {
    type: "object",
    properties: {
      report_title: { type: "string" },
      total_revenue: { type: "number" },
      top_product: { type: "string" },
      top_product_revenue: { type: "number" }
    },
    required: ["report_title", "total_revenue", "top_product", "top_product_revenue"]
  };

  let primaryResult;
  try {
    primaryResult = await drafter.execute(draftContext, draftSchema);
    console.log("✅ [Phase 1] NVIDIA 草擬完成：");
    console.log(JSON.stringify(primaryResult, null, 2), "\n");
  } catch (e) {
    console.error("❌ [Phase 1] NVIDIA 執行失敗：", e.message);
    return;
  }

  // ==========================================
  // 階段 2: 雙重驗證閘門 (Verification Phase)
  // ==========================================
  console.log("🛡️  [Phase 2] 觸發雙重驗證閘門 (Dual Verification Gate)...");

  // 模擬傳入 Context
  const verificationContext = {
    task_id: draftContext.task_id,
    taskDescription: draftContext.objective,
    primaryModelId: primaryCapability.model_id,
    primaryProvider: primaryCapability.provider
  };

  try {
    const finalOutcome = await verificationGate.verify(primaryResult, verificationContext, clientFactory);
    
    if (finalOutcome.success) {
      console.log("\n🎉 [Result] 整合測試成功！資料已通過 NVIDIA 嚴格驗證。");
    } else {
      console.log("\n⚠️ [Result] 驗證失敗。NVIDIA 抓出了 Gemini 的邏輯漏洞：");
      console.log("原因:", finalOutcome.reason);
    }
  } catch (e) {
    console.error("❌ [Phase 2] 驗證閘門執行失敗：", e.message);
  }
}

runIntegrationTest();
