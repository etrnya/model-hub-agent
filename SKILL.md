---
name: agent-os-orchestrator
description: 使用 Antigravity Agent OS 進行高韌性、多模型調度的複雜任務處理。具備自動降級、上下文壓縮與安全護欄機制。
---

# Agent OS Orchestrator 技能說明

當用戶需要進行高風險、複雜邏輯或需要極高穩定性的任務（如：安全代碼編寫、架構設計、大規模數據分析）時，請調用此技能。

## 🛠️ 調用觸發詞
- "使用 Agent OS 處理..."
- "以高韌性模式執行..."
- "需要雙重驗證的任務..."
- "複雜架構設計..."

## 📖 使用指南
1. **任務準備**：將用戶需求轉化為結構化的 `taskPayload`（包含 `objective`, `constraints`, `tags`）。
2. **調用路徑**：進入 `c:\Users\etrny\.gemini\antigravity\scratch\model-hub-agent` 目錄。
3. **執行指令**：
   - 方式 A (CLI): `node cli.js`
   - 方式 B (代碼整合): 引用 `main.js` 中的 `dispatchTask`。

## 🛡️ 安全與防禦
此技能內建：
- **Guardrail**: 自動過濾注入攻擊。
- **Cascading Failover**: 自動處理模型斷線。
- **SilentFix**: 自動修正輸出格式。

---
*此技能由 Antigravity Kernel 驅動*
