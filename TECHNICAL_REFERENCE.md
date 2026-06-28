# Antigravity Agent OS 技術參考手冊

本文件旨在詳細解釋 Antigravity Agent OS (AI Kernel) 的核心組件功能，供開發者與維護者參考。

## 1. 核心適配層 (Infrastructure Adapters)

### [SchemaValidator](./infrastructure/adapters/schema_validator.js)
*   **功能**：確保模型輸出符合定義好的 JSON Schema。
*   **靜默修正 (Silent Fix)**：內建正則表達式修復常見錯誤：
    *   移除 Markdown 代碼塊標籤 (```json ... ```)。
    *   修復末尾多餘的逗號。
    *   自動補齊因截斷而缺失的結尾花括號 `}`。
*   **價值**：節省因格式錯誤而重新調用模型的 Token 成本。

### [ContextCompressor](./infrastructure/adapters/context_compressor.js)
*   **功能**：自動偵測上下文長度。
*   **核心錨點 (Key-Insight Anchoring)**：在壓縮過程中強制保留 `objective` 與 `constraints` 等核心欄位，僅針對 `change_log` 進行摘要剪裁。
*   **價值**：防止模型切換時失去關鍵任務背景。

### [UnifiedErrorMapper](./infrastructure/adapters/error_mapper.js)
*   **功能**：標準化各供應商（Google, DeepSeek, NVIDIA）的原始錯誤碼。
*   **價值**：確保 `CascadingFallback` 能精確識別 `RATE_LIMIT` 或 `POLICY_VIOLATION` 並執行正確的回退路徑。

### [QuotaGuard](./infrastructure/adapters/quota_guard.js)
*   **功能**：即時監測各供應商（NVIDIA, Google, DeepSeek）的 RPM (Request-Per-Minute)。
*   **行為**：若配額即將枯竭，會在 API 調用前攔截並報錯，觸發系統的回退機制。
*   **價值**：防止多個模型因頻率限制同時進入冷卻時間。

### [MarkItDownAdapter](./infrastructure/adapters/markitdown_adapter.js)
*   **功能**：將 HTML、PDF、DOCX、XLSX 等原生檔案預先轉換為簡潔的 Markdown。
*   **行為**：結合本地 Python 虛擬環境中的 `markitdown` 工具，抓取文字並對圖片進行單次 OCR 解析。
*   **價值**：實現 50% - 90% 的 Token 節約，且避免圖片在多輪對話中重複上傳被雙重計費。

---

## 1.5. API 客戶端 (API Clients)

本系統封裝了多個 API Client，統一繼承自 `BaseClient` 並提供一致的 `_callModelApi` 接口：
*   **[VertexAIClient](./infrastructure/clients/vertex_ai_client.js)**：專門負責 GCP Vertex AI 平台整合，透過服務帳戶 JSON 私鑰生成臨時 OAuth2 Token 來呼叫 Gemini 模型，解決 Studio 429 Prepay Bug。
*   **[GeminiClient](./infrastructure/clients/gemini_client.js)**：支援標準 Google AI Studio Key 呼叫 Gemini 2.5/3.5 模型。
*   **[NvidiaNimClient](./infrastructure/clients/nvidia_nim_client.js)**：呼叫 NVIDIA NIM 託管的 Llama-3.1 等開源模型 API。
*   **[DeepSeekClient](./infrastructure/clients/deepseek_client.js)**：呼叫 DeepSeek 官方 API。

---

## 2. 服務層 (Services)

### [ModelRegistry](./registry/model_registry.js)
*   **功能**：存放所有可用模型的能力定義（上下文長度、模態、效能等級）。
*   **價值**：系統尋找合適工具的「通訊錄」。

### [CapabilityAwareRouter](./services/router.js)
*   **功能**：任務調度大腦。
*   **路由邏輯**：
    1.  篩選支援特定模態（如 Vision, Tool Use）的模型。
    2.  檢查實時配額 (QuotaGuard)。
    3.  根據效能等級（Ultra/High/Medium）匹配最合適的模型。
*   **價值**：實現真正的「智力分流」，昂貴模型處理重邏輯，快速模型處理基礎任務。

### [DualVerificationGate](./services/verification_gate.js)
*   **功能**：交叉驗證閘門。
*   **邏輯**：針對高風險任務，由主模型生成結果後，自動挑選「另一個不同家族」的模型進行非對稱審核。
*   **價值**：提升數據準確性與安全性，防止單一模型幻覺導致錯誤決策。

---

## 3. 共享定義 (Shared Foundation)

*   **[ToolSchema](./shared/tool_schema.json)**：定義工具的標準規格。
*   **[PromptMapping](./shared/prompt_mapping_data.json)**：存放不同模型對工具調用的「偏好範例」(Few-shot)，減少模型理解偏差。
*   **[HandoffProtocol](./shared/handoff_protocol.json)**：定義模型交接時的資訊封裝格式。

---

> [!NOTE]
> 整個系統遵循 DDD (Domain-Driven Design) 架構開發，各模組高度解耦，易於擴展新的模型供應商。
