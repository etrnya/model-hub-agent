const { dispatchTask } = require('./main');

async function run() {
  const taskPayload = {
    objective: "為 Booklist（智慧購書決策查重與個人書籍資產管理系統）建立核心工程代碼架構計畫與安全不變性驗證清單",
    constraints: [
      "遵循 GLOSSARY.md 與 PRD v1.0.2 規格",
      "前後端職責分離：前端 RWD PWA (HTML/CSS/JS) + 後端 GAS Web App",
      "實作五級查重決策階梯 (DO_NOT_BUY, CONSIDER, SAFE_TO_BUY, UNKNOWN)",
      "實作前端 Canvas 壓縮 (<500KB) 與 BarcodeDetector 零 Token 快路徑",
      "實作後端排他鎖 (ScriptLock) 與冪等性防重 (request_id)",
      "不外洩任何 API 金鑰，遵循 Credential Hygiene Invariant"
    ],
    tags: ["booklist", "architecture", "security", "decision_ladder"]
  };

  const outputSchema = {
    type: "object",
    properties: {
      architecture_plan: { type: "string" },
      core_modules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            module_name: { type: "string" },
            responsibility: { type: "string" },
            file_path: { type: "string" }
          },
          required: ["module_name", "responsibility", "file_path"]
        }
      },
      safety_invariants_checklist: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["architecture_plan", "core_modules", "safety_invariants_checklist"]
  };

  console.log("🚀 [Agent OS] 啟動 Booklist 專案核心架構規劃任務...");
  const result = await dispatchTask(taskPayload, outputSchema, "high");
  console.log("✅ [Agent OS] 規劃完成！");
  return result;
}

run().catch(err => {
  console.error("Agent OS Error:", err);
  process.exit(1);
});
