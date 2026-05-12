require('dotenv').config();
const fs = require('fs');
const path = require('path');
const router = require('./services/router');
const NvidiaNimClient = require('./infrastructure/clients/nvidia_nim_client');
const GeminiClient = require('./infrastructure/clients/gemini_client');
const DeepSeekClient = require('./infrastructure/clients/deepseek_client');

/**
 * AMS 系統骨架生成器 (RPD 3.0 -> Supabase SQL)
 */
async function generateSchema() {
  const rpdPath = path.join(__dirname, '../ac-management-system/RPD.md');
  const rpdContent = fs.readFileSync(rpdPath, 'utf8');

  // 路由到高階模型 (架構設計需要最高智商)
  const capability = router.route({
    modalities: ["text"],
    preferredTier: "high" 
  });
  
  // 處理餘額/ID 問題的 fallback
  let targetCapability = capability;
  if (capability.provider === 'deepseek' || capability.provider === 'google') {
      targetCapability = {
          model_id: "meta/llama-3.1-70b-instruct",
          provider: "nvidia-nim",
          context_window: 128000,
          limits: { rpm: 50, tpm: 100000 }
      };
  }

  console.log(`📡 [Router] 選用高階架構師模型: ${targetCapability.model_id}`);

  const clientMap = {
    'nvidia-nim': NvidiaNimClient,
    'google': GeminiClient,
    'deepseek': DeepSeekClient
  };

  const client = new clientMap[targetCapability.provider]({ modelCapability: targetCapability });

  const task = {
    payload: {
      objective: "請根據 RPD 3.0 的架構要求，產出一份完整的 Supabase PostgreSQL SQL 腳本。",
      instructions: [
        "1. 包含 5 大領域所有表格 (Identity, Asset, Facility, Maintenance, Event)。",
        "2. 必須包含 Row Level Security (RLS) 策略，所有表皆透過 organization_id 隔離。",
        "3. 實作一個通用的 audit_log 觸發器函數，並套用到所有核心表格。",
        "4. 針對 assets 表的 specs (JSONB) 欄位建立 GIN 索引。",
        "5. 包含 UUID 作為主鍵，並設定正確的外鍵級聯 (Cascade)。",
        "6. 預留 organization_members 表來處理複雜權限。"
      ],
      context: rpdContent
    },
    outputSchema: {
      type: "object",
      properties: {
        sql_script: { type: "string", description: "完整的 SQL 建表腳本" },
        architect_notes: { type: "string", description: "架構師的實作備註" }
      },
      required: ["sql_script"]
    }
  };

  try {
    console.log("⚙️  Agent OS 正在構建資料庫基因...");
    const result = await client.execute(task.payload, task.outputSchema);
    
    const outputPath = path.join(__dirname, '../ac-management-system/schema_v3.sql');
    fs.writeFileSync(outputPath, result.sql_script);
    
    console.log("\n✅ [生成完成]！");
    console.log(`📄 檔案路徑: ${outputPath}`);
    console.log("\n📝 [架構師備註]:");
    console.log(result.architect_notes || "無備註。");
  } catch (error) {
    console.error("❌ 生成失敗:", error.message);
  }
}

generateSchema();
