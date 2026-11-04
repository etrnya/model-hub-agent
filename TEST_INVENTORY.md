# Model Hub Agent 測試資產盤點表 (TEST_INVENTORY.md)

> **盤點日期**：2026-11-02  
> **盤點目標**：全面清查 `tests/` 目錄下 27 個測試與輔助腳本，明確界定其執行邊界、外部依賴、斷言強度與錯誤捕獲機制，為 P0-B 測試系統重構奠定事實基準。  
> **核心原則**：預設 `npm test` 必須 100% 離線、確定性、零 Token 消耗、任一失敗必非零 Exit Code。

---

## 📊 1. 測試資產分類統計總覽

| 分類標籤 (Category) | 定義說明 | 檔案數量 | 佔比 | 處理策略 |
| :--- | :--- | :---: | :---: | :--- |
| **UNIT** | 純邏輯、資料轉換、安全過濾，完全離線且無容器依賴 | **4** | 14.8% | 重構斷言後，全面納入預設 `npm test` |
| **INTEGRATION** | 跨模組整合、內部狀態流轉，使用 Mock 或本地程序 | **5** | 18.5% | 補齊 Mock 與嚴格斷言後，納入預設 `npm test` |
| **EXTERNAL** | 依賴真實雲端 API（Gemini/Vertex/NVIDIA/DeepSeek）或 Qdrant 容器 | **11** | 40.7% | 隔離至 `npm run test:external`，禁止進入預設測試 |
| **UTILITY** | 輔助工具、金鑰健檢、Schema 產生器、效能基準測試 | **7** | 26.0% | 維持專用 CLI 命令（如 `npm run diagnose`），不入測試套件 |
| **總計** | `tests/*.js` 全量檔案 | **27** | 100% | 建立三層執行分流 |

---

## 📋 2. 全量 27 個檔案逐檔詳細盤點清冊

### 第一組：單元測試 (UNIT) - 4 檔

#### 1. `test_fail_closed.js`
* **目標與涵蓋功能**：驗證 P0-A Verification Fail-Closed 安全特性（T1～T8：FAIL 阻斷、Exception 阻斷、Memory Audit 異常拒絕、未驗證結果禁入 Memory、Main 契約檢查）。
* **呼叫真實外部 API**：❌ 否
* **需要網路或 API Key**：❌ 否（完全使用注入 Mock ClientFactory）
* **使用 Mock / Stub**：✅ 是（完整 Mock ClientFactory）
* **使用 Node.js assert**：✅ 是（`const assert = require('assert')`）
* **錯誤時非零 Exit Code**：✅ 是（失敗時執行 `process.exit(1)`）
* **非同步錯誤吞掉風險**：❌ 無（每個測試案例獨立 `try/catch` 捕捉，最終統計並強制判定）
* **適合納入預設 `npm test`**：✅ **完全適合（目前已作為 P0-A 預設入口）**

#### 2. `test_compression.js`
* **目標與涵蓋功能**：測試 `ContextCompressor` 核心欄位保留策略（Key-Insight Anchoring 保留 `objective`、裁剪 `change_log`、過濾除錯雜訊）。
* **呼叫真實外部 API**：❌ 否
* **需要網路或 API Key**：❌ 否
* **使用 Mock / Stub**：❌ 否（直接以靜態物件呼叫純邏輯適配器）
* **使用 Node.js assert**：❌ **否（目前僅使用 `console.log` 人眼觀察輸出）**
* **錯誤時非零 Exit Code**：❌ **否（無任何錯誤拋出或 exit code 設定，永遠 exit 0）**
* **非同步錯誤吞掉風險**：⚠️ **高（直接執行未捕捉的 async function，若異常直接 unhandledRejection）**
* **適合納入預設 `npm test`**：⚠️ **需重構（補上 `assert.strictEqual` 與 exit code 後即可納入）**

#### 3. `test_guardrail.js`
* **目標與涵蓋功能**：測試 `GuardrailManager` 提示詞注入攔截（`Ignore all previous...`）與 DLP 敏感數據脫敏（遮蔽 API Key、Email、信用卡）。
* **呼叫真實外部 API**：❌ 否
* **需要網路或 API Key**：❌ 否
* **使用 Mock / Stub**：❌ 否（純正則表達式與字串模式匹配）
* **使用 Node.js assert**：❌ **否（目前僅 `console.log` 印出 Safe 與 Reason）**
* **錯誤時非零 Exit Code**：❌ **否（永遠 exit 0）**
* **非同步錯誤吞掉風險**：⚠️ **中（async 呼叫未包覆頂層 catch 退出保護）**
* **適合納入預設 `npm test`**：⚠️ **需重構（極具價值，改寫為原生 assert 後列為第一優先單元測試）**

#### 4. `test_silent_fix.js`
* **目標與涵蓋功能**：測試 `SchemaValidator.silentFix()` 的五種 JSON 自癒情境（多餘文字剝離、換行轉義、括號截斷補齊、註解剝離、尾隨逗號移除）。
* **呼叫真實外部 API**：❌ 否
* **需要網路或 API Key**：❌ 否
* **使用 Mock / Stub**：❌ 否（純字串演算法）
* **使用 Node.js assert**：❌ **否（使用 `try { JSON.parse() } catch` 後僅印出 Failed 文字）**
* **錯誤時非零 Exit Code**：❌ **否（catch 吞掉錯誤，解析失敗依然回報 exit 0）**
* **非同步錯誤吞掉風險**：❌ 無（同步陣列迴圈）
* **適合納入預設 `npm test`**：⚠️ **需重構（將 `JSON.parse` 驗證改為 `assert.deepStrictEqual` 後納入）**

---

### 第二組：整合測試 (INTEGRATION) - 5 檔

#### 5. `test_circuit_breaker.js`
* **目標與涵蓋功能**：驗證 `BudgetGuard` 與 `CircuitBreaker` 熔斷機制（當任務累計 Token 超過預算上限時，立即強制終止執行並拋出異常）。
* **呼叫真實外部 API**：❌ 否
* **需要網路或 API Key**：❌ 否（內部手動 mock `cascadingExecutor.clientMap`）
* **使用 Mock / Stub**：✅ 是（完整替換所有 Provider 為 `mockClient`）
* **使用 Node.js assert**：✅ 是（使用 `assert` 驗證熔斷訊息與狀態）
* **錯誤時非零 Exit Code**：✅ 是（未捕獲預期錯誤時拋錯）
* **非同步錯誤吞掉風險**：❌ 無
* **適合納入預設 `npm test`**：✅ **完全適合（純離線整合測試）**

#### 6. `test_advanced_features.js`
* **目標與涵蓋功能**：驗證 ADR 升級特性：(1) Instincts 餘弦去重 (2) Parallel Racing 競速調度 (3) 沙盒安全執行 (4) SSE 事件與覆寫。
* **呼叫真實外部 API**：❌ 否
* **需要網路或 API Key**：❌ 否（全 Mock Client）
* **使用 Mock / Stub**：✅ 是（Mock 各模型 Client）
* **使用 Node.js assert**：✅ 是（使用嚴格 `assert` 斷言）
* **錯誤時非零 Exit Code**：✅ 是（頂層 `.catch(process.exit(1))`）
* **非同步錯誤吞掉風險**：❌ 無
* **適合納入預設 `npm test`**：✅ **完全適合**

#### 7. `test_ecc_features.js`
* **目標與涵蓋功能**：驗證 ECC 升級特性：(1) AgentShield 惡意危險指令阻斷 (2) 費用熔斷 (3) 自我修正 Instinct 提取與保存。
* **呼叫真實外部 API**：❌ 否
* **需要網路或 API Key**：❌ 否（全 Mock Client）
* **使用 Mock / Stub**：✅ 是（Mock Clients）
* **使用 Node.js assert**：✅ 是（使用 `assert` 斷言）
* **錯誤時非零 Exit Code**：✅ 是（失敗時拋出）
* **非同步錯誤吞掉風險**：❌ 無
* **適合納入預設 `npm test`**：✅ **完全適合**

#### 8. `test_self_correction_flow.js`
* **目標與涵蓋功能**：測試 `CascadingExecutor` 自我修正迴圈（模擬初次輸出違規、攜帶 `_correction_feedback` 重新修正、重審合格）。
* **呼叫真實外部 API**：❌ 否
* **需要網路或 API Key**：❌ 否（具備完整 `MockClient` 與 `MockValidatorClient`）
* **使用 Mock / Stub**：✅ 是
* **使用 Node.js assert**：❌ **否（僅以 `if (magic_word === "antigravity") console.log` 觀察）**
* **錯誤時非零 Exit Code**：❌ **否（catch 區塊僅 `console.error`，未設定 exit code）**
* **非同步錯誤吞掉風險**：⚠️ **高（測試即使失敗，進程仍以 exit 0 結束）**
* **適合納入預設 `npm test`**：⚠️ **需重構（結構極佳，只要補上 `assert` 與 `process.exitCode = 1` 即可成為核心整合測試）**

#### 9. `test_markitdown.js`
* **目標與涵蓋功能**：測試微軟 `markitdown` 文件轉檔引擎適配器，驗證 HTML 轉 Markdown 格式與 Token 節省率計算。
* **呼叫真實外部 API**：❌ 否
* **需要網路或 API Key**：❌ 否
* **使用 Mock / Stub**：❌ 否（呼叫本機 python 命令）
* **使用 Node.js assert**：❌ 否（以 console 報告呈現）
* **錯誤時非零 Exit Code**：✅ 是（有頂層 catch 與拋錯）
* **非同步錯誤吞掉風險**：⚠️ **環境依賴風險（若本機未裝 markitdown python 套件，執行會崩潰）**
* **適合納入預設 `npm test`**：❌ **不適合（依賴外部 Python 環境與本機路徑檔案，應歸為整合環境測試）**

---

### 第三組：外部服務依賴測試 (EXTERNAL) - 11 檔

> ⚠️ **以下所有檔案嚴禁納入預設 `npm test`，必須全部歸案至 `test:external`**：

| 檔案名稱 | 測試目標 | 依賴外部服務 | 是否有 Assert | 為何不可納入預設 test |
| :--- | :--- | :--- | :---: | :--- |
| `test_integration.js` | 跨模型草擬與審核 (DeepSeek -> Gemini) | **Google AI Studio, DeepSeek** | ❌ 否 | 需消耗真實 Token，無 Key 時必崩潰 |
| `test_fuzzy_memory.js` | 語意向量記憶模糊檢索與 TTL 審計 | **Vertex AI Embedding, 本機 Qdrant Docker** | ❌ 否 | 需 Docker Qdrant 運行中與 GCP Key |
| `test_markitdown_agent.js` | 端到端文件轉檔 + Vertex AI 結構化提取 | **GCP Vertex AI Gemini, MarkItDown** | ❌ 否 | 需 GCP 服務帳號金鑰與對外網路 |
| `test_model_selection.js` | 測試多款 Gemini 模型 HTTP 連線狀態 | **Google GenerativeLanguage API** | ❌ 否 | 直接 `fetch` 外部 Google 網址 |
| `test_gemini_models.js` | 測試 Google AI Studio 多模型支援度 | **Google AI Studio** | ❌ 否 | 需真實 `GEMINI_API_KEY` |
| `test_vertex_ai.js` | 測試 GCP Vertex AI 認證與文字生成 | **GCP Vertex AI (OAuth2)** | ❌ 否 | 需真實 `gcp-key.json` |
| `test_nvidia.js` | 測試 NVIDIA NIM Llama 端點呼叫 | **NVIDIA API Gateway** | ❌ 否 | 需真實 `NVIDIA_API_KEY` |
| `test_all_models.js` | 輪詢所有註冊模型端點之連線 | **Google, Vertex, NVIDIA, DeepSeek** | ❌ 否 | 跨 4 家雲端廠商真實驗證 |
| `test_gcp_project.js` | 驗證 GCP Project ID 讀取與設定 | **GCP 憑證環境變數** | ❌ 否 | 需本機 GCP 帳號環境 |
| `test_raw_response.js` | 檢查外部 API 之 Raw 回傳封包結構 | **Google AI Studio** | ❌ 否 | 需真實 API 呼叫 |
| `test_regions.js` | 測試 Vertex AI 多區域端點延遲比較 | **GCP Vertex AI (us-central1 等)** | ❌ 否 | 需連線多個海外 GCP 節點 |

---

### 第四組：工具與診斷腳本 (UTILITY) - 7 檔

> 🛠️ **以下檔案為開發輔助或運維診斷腳本，不屬於常態測試套件**：

| 檔案名稱 | 核心用途 | 執行頻率 | 建議處置 |
| :--- | :--- | :---: | :--- |
| `diagnose_keys.js` | 主動式金鑰健康度檢查與儀表板顯示 | 部署/開工時手動執行 | 保留獨立命令 `npm run diagnose` |
| `benchmark_runner.js` | 多模型品質、延遲與語意漂移基準評估 | 定期基準測試時執行 | 保留獨立命令 `npm run benchmark` |
| `check_enabled_apis.js` | 檢查 GCP 專案中已啟用的 API 服務清單 | GCP 設定排查時執行 | 歸入 `scripts/utils/` |
| `enable_vertex_api.js` | 透過 Service Usage API 自動啟用 Vertex 服務 | 初期環境建置時執行 | 歸入 `scripts/utils/` |
| `list_vertex_models.js` | 列出 GCP Vertex 當前專案可用模型清單 | 規格確認時手動執行 | 歸入 `scripts/utils/` |
| `generate_ams_schema.js` | 呼叫 LLM 自動產生目標資料的 JSON Schema | 開發新任務時手動執行 | 歸入 `scripts/utils/` |
| `analyze_ac_rpd.js` | 呼叫 LLM 剖析 RPD 需求文件的輔助腳本 | 需求確認時單次執行 | 歸入 `scripts/utils/` |

---

## 🔍 3. 關鍵發現與安全性評估結論

1. **「假通過 (Silent False Positive)」現象普遍**：
   在全量 27 個檔案中，高達 **22 個檔案未使用 Node.js `assert`**，而是依賴 `console.log`。其中有多個檔案使用 `try { ... } catch (e) { console.error(e); }` 卻未設置非零 exit code，導致執行失敗時終端機依然判定為 Exit 0！
2. **離線純淨度極高的種子資產已存在**：
   目前已有 `test_fail_closed.js`、`test_circuit_breaker.js`、`test_advanced_features.js`、`test_ecc_features.js` 4 個檔案具備嚴格的 Mock 與斷言機制，加上即將重構的 `test_compression.js`、`test_guardrail.js`、`test_silent_fix.js`、`test_self_correction_flow.js`，我們將擁有 **8 個完全純淨、高覆蓋率的預設離線測試套件**。
3. **無任何非確定性測試混入預設套件**：
   舊版 `package.json` 將 `test_integration.js` 綁在 `npm test` 是導致測試不穩與依賴網路的元兇。透過本次盤點，界線已徹底劃清。
