本指南協助開發者深入理解如何與 Agent OS 交互，並善用其防禦與調度機制。

---

## 1. 快速啟動：互動式 CLI (推薦)

如果您不想編寫任何代碼，只想快速派發任務，請在終端機執行：
```bash
node cli.js
```
系統會一步步引導您輸入：
- 🎯 **任務目標**
- ⛓️ **限制條件**
- ⚡ **模型等級**

這是最直覺的操作方式，適合快速測試任務或進行簡單的生產工具調用。

---

## 2. 核心任務分發：`dispatchTask`

系統的主入口位於 `main.js` 中的 `dispatchTask` 函式。

### 參數說明：
- `taskPayload`: 任務描述物件（含目標、約束與標籤）。
- `outputSchema`: 期望輸出的 JSON Schema（確保結構化輸出）。
- `tier`: 模型等級 (`ultra`, `high`, `medium`, `base`)。

### 快速範例：
```javascript
const { dispatchTask } = require('./main');

const task = {
  objective: "撰寫一個用於資料庫連線的 Python 腳本",
  constraints: ["使用 SQLAlchemy", "包含連線池配置"],
  tags: ["coding"] 
};

const schema = {
  type: "object",
  properties: {
    code: { type: "string" },
    explanation: { type: "string" }
  },
  required: ["code", "explanation"]
};

// 系統會自動選取適合 coding 的高階模型，並在出錯時自動降級
dispatchTask(task, schema, "high");
```

---

## 2. 安全護欄 (Guardrail)
在任務執行前，系統會自動啟動安檢：

- **防禦注入**：自動攔截「忽略先前指令」等惡意提示詞，防止模型被劫持。
- **數據脫敏**：自動識別並遮蔽 API Keys、電子郵件等敏感資訊，確保不會傳送給第三方模型。

---

## 3. 在 Antigravity 開發流程中調用 (實戰教學)

當您在開發其他專案（如 AC 管理系統）時，可以按照以下步驟調用本專案來協助開發並節省 Token：

1.  **開啟終端機**：進入 `model-hub-agent` 目錄。
2.  **派發重型任務**：
    -   執行 `node cli.js`。
    -   將您的複雜需求（例如：編寫複雜算法、分析超長日誌）貼入。
    -   **節省關鍵**：對於一般任務，選擇 `base` 或 `medium` 等級；只有在絕對需要高品質時才選擇 `high`。
3.  **獲取優化結果**：系統會回傳經過 `SilentFix` 修正且經過驗證的程式碼或分析結果。
4.  **貼回您的專案**：這比直接在 Antigravity 視窗中詢問能更精準地控制格式與成本。

---

## 3.5. 文件預處理與 Token 壓縮 (MarkItDown 整合)

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

## 3.6. 主動式金鑰健康診斷 (Health Check)

當您懷疑 API 金鑰失效（例如 Google AI Studio 回報 429 或 NVIDIA 報錯）時，本系統提供一鍵健檢功能。

### 使用方式：
1.  **在終端機手動執行**：
    ```bash
    npm run diagnose
    ```
2.  **在 Antigravity 聊天介面中**：
    直接對我說 **「幫我檢查金鑰」** 或 **「金鑰健檢」**，我便會直接在背景執行並將健康狀態儀表板以表格形式回報給您，您無需手動輸入指令！

---

## 4. 如何查看 Token 節省量？

每次執行任務後，系統會自動在終端機輸出 **「Token 成本分析報告」**：

- **Total Tokens Saved**: 透過壓縮機制省下的 Token 總數。
- **Overall Savings Ratio**: 節省比例（通常在 30% - 60% 之間）。
- **供應商儀表板 (Provider Dashboard)**：詳細列出各家供應商（NVIDIA, Google, DeepSeek）的當前使用量與額度佔用率。
- **配額預警 (Quota Alert)**：當某家供應商的用量超過您設定的 90% 時，系統會自動發出紅色警報。

您可以直接在 `observability/token_monitor.js` 中調整您的配額限制 (`limit`)。

---

## 5. 效能與延遲分析 (會變慢嗎？)

**結論：邏輯開銷極低，穩定性大幅提升。**

- **本地運算**：護欄檢查與壓縮邏輯在本地執行，耗時通常小於 200ms。
- **模型響應**：因為傳送的上下文變短了，模型生成速度 (TTFT) 反而會變快。
- **驗證開銷**：若觸發「雙重驗證」，會多出一次模型請求時間，但換來的是 99% 的產出正確率，省去了您反覆修正的時間。

詳細分析請參閱：[PERFORMANCE_ANALYSIS.md](PERFORMANCE_ANALYSIS.md)

---

## 6. 使用哲學：什麼時候該啟動 Agent OS？

並非所有任務都需要 Agent OS，但以下場景是啟動的最佳時機：

1.  **專案進入「深水區」**：對話歷史極長，感覺 AI 開始「失憶」或抓不到重點時。
2.  **高風險操作**：涉及代碼安全、加密、複雜數據處理等不容出錯的環節。
3.  **多模型協作**：需要讓不同模型交叉校驗 (Audit) 以獲得最高品質結果時。

---

## 7. 全域狀態管理 (GlobalState)
所有任務結果都會存入具備**版本控制**的 `GlobalState`：
- 您可以透過 `stateManager.getSnapshot()` 獲取當前最新的系統狀態。
- 每次更新都會留下紀錄，確保多 Agent 協作時的數據一致性。

---

## 6. 如何添加新模型？
只需在 `registry/model_registry.js` 中添加新的配置，並定義其 `performance_tier`。`Router` 與 `CascadingExecutor` 會自動感知並將其納入調度與備援體系。

---
*Antigravity Agent OS - 打造最強韌的 AI 大腦*
