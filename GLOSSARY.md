# Antigravity Model Hub 專案字典 (Glossary)

## 核心術語 (Core Terms)

| 中文名稱 | 英文名稱 | 代碼變數名 | 定義 |
| :--- | :--- | :--- | :--- |
| **靜默修正** | Silent Fix | `SilentFix` | 當模型輸出格式錯誤時，由適配層自動進行語法修正或預設值填充，避免中斷。 |
| **能力心跳** | Heartbeat Registry | `HeartbeatRegistry` | 定期偵測各端點的可用性、延遲與功能支援，實現動態路由權重調整。 |
| **變更日誌** | Change Log | `ChangeLog` | 紀錄全域狀態快照的每一次修改（誰、何時、改了什麼），防止邏輯衝突。 |
| **級聯回退** | Cascading Fallback | `CascadingFallback` | 當主模型限流或超時時，自動降級至本地或次要模型，並啟動異步重試。 |
| **參數驗證器** | Schema Validator | `SchemaValidator` | 在工具調用前後強制執行 JSON Schema 檢查，確保資料交換的嚴謹性。 |
| **漂移監控儀** | Drift Monitor | `DriftMonitor` | 比較不同模型處理同一任務的相似度，用以評估提示詞模板的有效性。 |
| **去識別化範本** | De-identified Template | `DeidentifiedTemplate` | 隱私過濾後留下的結構範本，讓模型在不知曉敏感資訊下仍能理解上下文。 |
| **核心錨點壓縮** | Key-Insight Anchoring | `ContextCompressor` | 在壓縮上下文長度時，保護並固定 Objective 與 Constraints 等核心欄位。 |
| **非對稱驗證** | Asymmetric Verification | `VerificationGate` | 使用不同層級或供應商的模型交叉審查草稿，平衡成本與輸出邏輯精準度。 |
| **文件預處理適配器** | MarkItDown Adapter | `MarkItDownAdapter` | 在將 HTML/PDF/Office 文件傳入 LLM 前，預先將其清理並轉為結構化 Markdown。 |
| **金鑰健康診斷** | API Diagnostics | `runDiagnostics` | 主動且低成本地測試各平台 API 密鑰與帳單可用性，並呈現在健康儀表板。 |

## 技術組件 (Technical Components)

*   **NVIDIA NIM**: NVIDIA 推出的推理微服務，提供多種開源模型 API。
*   **DeepSeek API**: 具備高性價比的推理模型接口。
*   **MCP Server**: Model Context Protocol 伺服器，用於標準化模型工具接入。
*   **Vertex AI (Agent Platform)**: Google Cloud Enterprise 企業級 AI 服務，直接與 Cloud Billing 接軌，解決 Studio 預付款 429 錯誤。
*   **MarkItDown**: 微軟開源的 Python 萬能文件格式轉 Markdown 工具，支持 PDF、HTML、DOCX、XLSX 等。
*   **gcp-key.json**: Google Cloud 服務帳戶的 JSON 金鑰憑證檔案，用於 Vertex AI OAuth2 的 Bearer 認證。

