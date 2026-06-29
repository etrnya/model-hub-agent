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
| **代碼圖譜適配器** | CodeGraph Adapter | `CodeGraphAdapter` | 介接本地端 AST 分析圖資料庫，實現外科手術式精準的程式符號與呼叫鏈查詢。 |
| **上下文完整性閘門** | Context Integrity Gate | `ContextIntegrityGate` | 防止上下文雙重壓縮、追蹤 Provenance 來源並保護代碼寫入時的語意忠實度。 |
| **向量記憶管理器** | Vector Memory Manager | `MemoryManager` | 介接 Qdrant 向量資料庫與 Vertex AI Embedding 的語意記憶快取層，實現重覆任務 100% LLM 繞過。 |

## 技術組件 (Technical Components)

*   **NVIDIA NIM**: NVIDIA 推出的推理微服務，提供多種開源模型 API。
*   **DeepSeek API**: 具備高性價比的推理模型接口。
*   **MCP Server**: Model Context Protocol 伺服器，用於標準化模型工具接入。
*   **Vertex AI (Agent Platform)**: Google Cloud Enterprise 企業級 AI 服務，直接與 Cloud Billing 接軌，解決 Studio 預付款 429 錯誤。
*   **MarkItDown**: 微軟開源的 Python 萬能文件格式轉 Markdown 工具，支持 PDF、HTML、DOCX、XLSX 等。
*   **gcp-key.json**: Google Cloud 服務帳戶的 JSON 金鑰憑證檔案，用於 Vertex AI OAuth2 的 Bearer 認證。
*   **CodeGraph**: 基於 Tree-sitter 與 SQLite 的本地程式符號分析與依賴圖查詢引擎。
*   **Headroom Context Shaper**: 本地運行的上下文壓縮優化網關，提供 SmartCrusher 與 CCR 可逆式壓縮功能。
*   **Qdrant**: 本地運行的輕量級向量資料庫，用於 Phase 3 的任務語意向量儲存與相似度檢索。
*   **text-embedding-004**: Google Vertex AI 企業級文本嵌入模型，將自然語言任務目標轉化為 768 維的高維特徵向量。

## 評估指標 (OS Metrics)

*   **Context Fidelity Score (CFS)**: 評估上下文壓縮後是否仍保持 100% 原始位元忠實度（Bit-exact）。
*   **Reasoning Drift Index (RDI)**: 評估同一個任務在不同 Context 優化策略下，模型推理輸出結構的相似度與偏移度。
*   **Retrieval Efficiency (RE)**: 評估 CodeGraph Surgery 相比於暴力載入整個專案原始碼，所精簡下來的空間效率。
*   **Compression Safety Ratio (CSR)**: 成功通過目標 Schema 驗證的任務佔比，反映壓縮過程是否引起致命數據遺失。
