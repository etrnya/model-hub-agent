# Antigravity Agent OS - 操作全攻略 (Developer Usage Guide)

本指南旨在幫助開發者深度理解如何與 Agent OS 交互，並利用其強大的防禦與調度機制。

---

## 1. 核心交互模式：`dispatchTask`

系統的主入口位於 `main.js` 中的 `dispatchTask` 函式。它接受三個參數：
- `taskPayload`: 任務描述物件。
- `outputSchema`: 期望輸出的 JSON 格式。
- `tier`: (選填) 模型等級 (`ultra`, `high`, `medium`, `base`)。

### 範例：啟動一個高風險代碼生成任務
```javascript
const { dispatchTask } = require('./main');

const task = {
  objective: "設計一個處理用戶登錄的 API",
  constraints: ["使用 JWT 進行驗證", "密碼必須經過 Hashing"],
  tags: ["coding", "security"] // tags 將決定是否觸發驗證閘門
};

const schema = {
  type: "object",
  properties: {
    endpoint: { type: "string" },
    security_score: { type: "number" }
  },
  required: ["endpoint", "security_score"]
};

dispatchTask(task, schema, "high");
```

---

## 2. 安全護欄 (Guardrail) 的運作
當您調用 `dispatchTask` 時，系統會自動先進行 `Guardrail` 掃描。

- **注入攔截**：如果您的 `objective` 中包含 "Ignore all previous instructions"，系統會直接攔截並終止任務，不浪費任何 Token。
- **數據脫敏**：如果您不小心傳入了 API Key，系統會自動將其替換為 `[REDACTED_API_KEY]` 之後才傳送給模型，確保隱私。

---

## 3. 級聯重試與故障轉場 (Cascading Failover)
這是本系統最核心的「韌性」來源。

當系統偵測到以下情況時，會自動切換至下一個候補模型：
1. **API 連線超時或 500 報錯**。
2. **模型輸出的 JSON 格式嚴重錯誤**（且 `SilentFix` 無法修補）。
3. **模型遭到了廠商的流量限制 (429)**。

您會在終端機看到類似這樣的日誌：
```text
🚀 [Attempt 1] Trying deepseek-chat (deepseek)...
⚠️  [CascadingExecutor] Failed with deepseek-chat: Rate Limit Exceeded
🔄 [CascadingExecutor] Cascading to next available model...
🚀 [Attempt 2] Trying llama-3-70b (nvidia-nim)...
✅ [CascadingExecutor] Success with llama-3-70b!
```

---

## 4. 靜默修正 (SilentFix 2.0)
本系統能自動修復模型常見的格式瑕疵。

- **自動剝離標籤**：自動移除 ```json ... ```。
- **補全括號**：針對被截斷的響應嘗試進行補全。
- **轉義字元修復**：修正 JSON 字串中常見的非法換行。

---

## 5. 全域狀態管理 (GlobalState)
系統不僅回傳結果，還會將結果同步至具備**版本控制**的 `GlobalState`。

- 每次更新都會增加 `version` 號。
- 這讓多個 Agent 可以基於相同的「歷史事實」進行協作，避免資訊不對等。

---

## 6. 文件預處理與 Token 壓縮 (MarkItDown 整合)

當您有 HTML、PDF、Word (DOCX) 或 Excel (XLSX) 等大型文檔需要輸入給 LLM 時，建議使用內建的 [markitdown_adapter.js](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/infrastructure/adapters/markitdown_adapter.js) 進行預處理。

### 操作方式：
適配器會自動調用本地的 Python `markitdown` 虛擬環境，將原生笨重的檔案轉化為純文字 Markdown：
```javascript
const MarkItDownAdapter = require('./infrastructure/adapters/markitdown_adapter');

async function processFile() {
  const filePath = "c:\\path\\to\\your\\document.pdf";
  const result = await MarkItDownAdapter.convertToMarkdown(filePath);
  
  console.log("轉檔後的 Markdown 內容:", result.markdown);
  console.log("Token 節省估計:", result.savingsPercent + "%");
}
```
*   **優勢**：
    -   大幅降低網頁與文件原生格式（XML/CSS/HTML）造成的 Token 浪費（約省下 50% - 90%）。
    -   圖片與圖表僅在轉換時呼叫一次 Vision 模組進行 OCR，後續多輪對話只讀取純文字，**免除重複傳送圖片導致的 Vision Token 扣款**。

---

## 7. 主動式金鑰健康診斷 (Health Check)

當您懷疑 API 金鑰失效（例如 Google AI Studio 回報 429 或 NVIDIA 報錯）時，本系統提供一鍵健檢功能。

### 使用方式：
1.  **在終端機手動執行**：
    ```bash
    npm run diagnose
    ```
2.  **在 Antigravity 聊天介面中**：
    直接對我說 **「幫我檢查金鑰」** 或 **「金鑰健檢」**，我便會直接在背景執行並將健康狀態儀表板以表格形式回報給您，您無需手動輸入指令！

---

## 7.5. Semantic Vector Memory Cache (Qdrant Integration)

The project integrates local Qdrant Vector DB with Vertex AI `text-embedding-004` to persist successful task executions:

-   **Exact Match (>= 99.9%)**: Returns cached outputs immediately, achieving **0-token cost and sub-second latency**.
-   **Fuzzy Match (90% - 99.9%)**: Invokes `VerificationGate.auditMemory` to double-check relevance. Returns cache if passed; falls back to LLM execution if failed.
-   **TTL Config**: Set `MEMORY_TTL_DAYS` in `.env` to automatically invalidate stale cache items.

---

## 7.6. Webhook API Server (Microservice Integration)

Agent OS can be run as a microservice HTTP server:

1.  **Start Server**:
    Simply say **"Start Agent OS Server"** in chat, or run:
    ```bash
    npm run server
    ```
    It listens on `http://localhost:3000`.
2.  **API Schema (POST `/dispatch`)**:
    ```json
    {
      "objective": "Design an async JWT verification helper in Node.js",
      "constraints": ["Use CommonJS", "Include error handling"],
      "tags": ["coding", "security"],
      "tier": "high"
    }
    ```
    The server routes the request through CodeGraph, Headroom, Qdrant, and validation gates, returning standard JSON.

---

## 8. 如何添加新模型？
編輯 `registry/model_registry.js`，加入新的 `ModelCapabilitySchema` 即可。系統會自動根據您定義的 `performance_tier` 將其納入調度與備援清單。

---
*Powered by Antigravity Kernel*
