require('dotenv').config();
const fs = require('fs');
const path = require('path');
const router = require('./services/router');
const NvidiaNimClient = require('./infrastructure/clients/nvidia_nim_client');
const GeminiClient = require('./infrastructure/clients/gemini_client');
const DeepSeekClient = require('./infrastructure/clients/deepseek_client');

/**
 * 專為分析 ac-management-system RPD 所寫的腳本
 */
async function analyzeRPD() {
  // 1. 讀取 AC 系統的 RPD 檔案
  const rpdPath = path.join(__dirname, '../ac-management-system/RPD.md');
  const rpdContent = fs.readFileSync(rpdPath, 'utf8');

  // 2. 路由 (這裡我們手動過濾掉 deepseek 因為餘額不足)
  const capability = router.route({
    modalities: ["text"],
    preferredTier: "high" 
  });
  
  // 強制切換為 NVIDIA 如果路由選了 deepseek (因為 Gemini ID 還有問題，NVIDIA 最穩)
  let targetCapability = capability;
  if (capability.provider === 'deepseek') {
     const modelRegistry = require('./registry/model_registry');
     targetCapability = modelRegistry.models.find(m => m.provider === 'nvidia-nim') || capability;
  }

  console.log(`📡 [Router] 選用高階模型進行深度分析: ${targetCapability.model_id}`);

  const clientMap = {
    'nvidia-nim': NvidiaNimClient,
    'google': GeminiClient,
    'deepseek': DeepSeekClient
  };

  const client = new clientMap[targetCapability.provider]({ modelCapability: targetCapability });

  // 3. 定義分析任務
  const task = {
    payload: {
      objective: "請針對這份 AC 管理系統的 RPD 進行深度技術審核。請列出 5 個潛在的技術挑戰或需求盲點，並針對每個點提出一個具體的釐清建議。",
      context: rpdContent
    },
    outputSchema: {
      type: "object",
      properties: {
        analysis_results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              point: { type: "string", description: "盲點或挑戰描述" },
              suggestion: { type: "string", description: "釐清建議" }
            },
            required: ["point", "suggestion"]
          }
        }
      },
      required: ["analysis_results"]
    }
  };

  try {
    console.log("⚙️  正在分析 RPD...");
    const result = await client.execute(task.payload, task.outputSchema);
    
    console.log("\n🔍 [RPD 深度分析報告]:");
    result.analysis_results.forEach((item, index) => {
      console.log(`${index + 1}. 【${item.point}】`);
      console.log(`   💡 建議：${item.suggestion}\n`);
    });
  } catch (error) {
    console.error("❌ 分析失敗:", error.message);
  }
}

analyzeRPD();
