# Agent OS 開發紀實與 Token 成本最佳化指南

本文件記錄了 Antigravity Agent OS 的核心架構演進歷程，並提供操作本系統以達到「最低 Token 消耗、最高輸出品質」的實戰策略。

---

## 第一部分：開發流程與架構演進紀實

在本次開發過程中，我們共同將一個單純的「模型切換器」，升級為具備「工業級韌性」的 Agent OS 大腦。我們的開發歷程經歷了以下五個關鍵階段：

### 1. 基礎設施的覺醒 (Infrastructure Awakening)（2026-05-12 至 2026-06-15）
一開始，我們意識到單純地向 API 發送請求是極度脆弱的。因此我們打造了：
*   **Schema Validator (語法驗證與靜默修正)**：賦予系統「自我修復」的能力。當模型偶爾發神經，在 JSON 外面加上了 Markdown 標籤 (````json ... ````) 時，系統不再盲目報錯重試，而是直接在背景靜默剝離標籤，拯救了無數原本會浪費的 Token。
*   **Context Compressor (上下文壓縮器)**：我們導入了「核心錨點 (Key-Insight Anchoring)」，確保在裁減冗長對話紀錄時，任務的 `objective` (目標) 與 `constraints` (限制) 絕對不會被刪除，防止模型「失憶」。

### 2. 智慧調度與多模型雙重驗證 (Intelligent Routing & Dual-Verification)（2026-06-15 至 2026-06-26）
*   **Capability-Aware Router (能力感知路由)**：系統會根據「任務需要的模態」、「上下文大小」與「預期效能」，自動從註冊表中挑選最適合的模型 (NVIDIA, Gemini, DeepSeek)。
*   **Verification Gate (雙重驗證閘門)**：實作了「非對稱審核」機制：當 A 模型完成草擬後，系統會自動將結果指派給 B 模型（例如 Llama-3.1-70B 審計 Gemini 輸出）進行邏輯檢查，確保高風險任務的絕對可靠。
*   **Unified Error Mapper (統一錯誤對應)**：不同 API 廠商的錯誤碼（如 429 資源耗盡、400 格式錯誤）被標準化，觸發「級聯回退 (Cascading Fallback)」。

### 3. 後付款 Vertex AI 整合 (Postpaid Billing Integration)（2026-06-26 至 2026-06-27）
*   **起因**：Google AI Studio 發生嚴重的預付款同步 Bug，導致綁定後付款的 API Key 頻頻回報 `429 Prepayment credits are depleted` 錯誤。
*   **解法**：全面升級支持 GCP 服務帳戶 JSON 金鑰憑證認證，將 Gemini 調用切換至 GCP 企業級 **Vertex AI API**，完美消耗 GCP 帳戶內的免費抵扣額度，恢復業務連線。

### 4. 禁止瀏覽器 ODM 濫用 (Browser Subagent Restriction)（2026-06-27）
*   **起因**：實際調試中發現，AI 代理調用 `browser_subagent` 時會產生龐大的網頁渲染與頁面結構讀取，產生極為恐怖的 Token 噴發。
*   **解法**：新增專案規則（Project Rules），除極端必要外全面**禁止** AI 使用瀏覽器 ODM。改為優先以輕量級 `read_url_content` 或 Notion MCP 獲取網頁資訊。

### 5. 文件預處理轉 Markdown (MarkItDown Integration)（2026-06-27 至 2026-06-28）
*   **起因**：LLM 直接吸入 HTML、PDF、Excel 等原生格式文件時，會攝入大量雜訊標籤，且多輪對話中重複上傳圖片會反覆扣除高額的 Vision 視覺 Token。
*   **解法**：引入 Microsoft `markitdown` 引擎適配器 [markitdown_adapter.js](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/infrastructure/adapters/markitdown_adapter.js)，在送入 LLM 前先轉換為結構精簡的 Markdown，實現高達 **50% 至 90%** 的 Token 節省率。

---

## 第二部分：如何使用本系統「大幅降低 Token 消耗」？

Agent OS 的設計初衷之一就是 **「極致的成本控制」**。以下是 5 個利用本系統為您省下大量 API 費用的實戰指南：

### 策略一：善用「能力感知路由 (Router)」，殺雞不用牛刀
不要把所有任務都丟給最貴的模型！
*   **日常瑣事與程式碼生成**：在發布任務時，將 `preferredTier` 設為 `standard` 或 `base`。Router 會自動派發給 **DeepSeek** 或 **Llama-3.1-8B**，這些模型的費用極低（甚至免費），且處理標準任務的能力極強。
*   **超長文本摘要**：交給 **Gemini 1.5 Flash**。它的 Token 單價極低，且擁有百萬級的處理窗口。
*   **最終審核與複雜架構設計**：只有在這種關鍵時刻，才將 `preferredTier` 設為 `ultra` 或 `high`，呼叫 **NVIDIA Llama-3.1-405B** 或 **Gemini 1.5 Pro**。

### 策略二：利用「靜默修正 (Silent Fix)」避免無意義的重試
*   **傳統架構的痛點**：模型少寫了一個 `}`，系統報錯，然後把整大段 Prompt 重新發送一次，白白浪費兩倍的 Token。
*   **Agent OS 的解法**：我們的 `SchemaValidator` 已經實作了正則表達式修復功能。它會在背景偷偷幫模型補齊標點符號。**您的系統會自動吸收微小的錯誤，從根本上阻斷了無意義的 Retry Token 消耗。**

### 策略三：強制「上下文壓縮 (Context Compression)」
*   任務狀態 (`GlobalState`) 隨著執行時間變長，裡面的 `change_log` (變更日誌) 會變得非常肥大。
*   **操作建議**：在設定任務時，確實定義好 `objective` 和 `constraints`。因為當 Token 快要溢出時，`ContextCompressor` 會毫不猶豫地把舊的 `change_log` 壓縮或刪除。只要您的「核心錨點」寫得夠精確，就算歷史紀錄被清空，模型依然能精準執行任務，同時替您省下大量背景 Token 費用。

### 策略四：文件預處理轉 Markdown (MarkItDown)，去除格式標籤與視覺重複計費
*   **傳統架構的痛點**：LLM 讀取 raw HTML、PDF 等格式會帶入極大垃圾標籤，且多輪對話中，圖片重複傳送會重複計算高昂的 Vision Token。
*   **Agent OS 的解法**：在送入 LLM 之前，使用 [markitdown_adapter.js](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/infrastructure/adapters/markitdown_adapter.js) 預先將文件轉換為極簡 Markdown；圖片於初次轉換時執行 OCR 轉換為文字，後續輪次只使用文字，從根本上省下 **50% - 90%** 的 Token 成本。

### 策略五：為未來準備的「本地零成本算力 (Local Ollama)」
雖然您目前硬體尚未準備好，但我們已在註冊表中保留了本地基礎設施的接口。
*   **未來展望**：一旦您未來有了效能較好的設備，您可以將日常繁瑣的「數據清理」、「格式轉換」等不需要高智商的枯燥任務，透過設定 `DataSensitivityRouter` 強制導向本地的 Ollama 模型。
*   **結果**：無限量的 Token 使用，**成本為 $0**，且絕對保護隱私。

---

> **總結**：
> 優秀的 Agent OS 不只是要會呼叫 API，更要懂得「精打細算」。透過動態調度與防禦機制，您的每一次 API 請求都將用在刀口上。
