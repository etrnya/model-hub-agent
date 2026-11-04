# P0-B Step 2.1: 測試執行器與清單完整性 深度鑑識報告 (STEP_2_1_AUDIT.md)

本報告針對 P0-B Step 2 架構審查提出的五大核心疑問（離線清單落差、外部測試入口、Self-Correction 耗時來源、雙向 Manifest 防漏、子行程錯誤處理），提供客觀、具體且經過實體驗證的工程鑑識結果。

---

## 一、A 項鑑識：離線測試清單差異鑑識（原規劃 3 個測試去向）

在原始盤點規劃中曾提及 8 個離線測試，但在 Step 2 中 `OFFLINE_SUITES` 僅納入 5 個。我們對消失的三個檔案（`test_circuit_breaker.js`、`test_advanced_features.js`、`test_ecc_features.js`）進行了逐行依賴與實體執行鑑識：

### 1. `tests/test_circuit_breaker.js`
* **外部依賴性**：**完全無外部 API 或 Docker 依賴**。內部已實作 `mockClientMap`，將所有 LLM 供應商以 Mock 物件覆蓋。
* **先前未納入原因**：在 Step 1 聚焦於 4 個核心檔案，Step 2 執行時將其暫留在 `EXTERNAL_SUITES`。
* **鑑識發現之潛在隱患（重大成果）**：
  1. **仰賴 CodeGraph 膨脹 Token**：原本設定 `MAX_TASK_BUDGET_TOKENS = "1000"`，在過去沒有 `code_context` 時，CodeGraph 提取大量符號產生 22KB 上下文（約 5,500 Tokens）碰巧觸發熔斷；當在乾淨環境執行時，Mock 任務僅約 197 Tokens，熔斷器根本無法觸發。
  2. **缺乏 SemanticCache 隔離**：第一次執行成功後，快取被寫入磁碟；第二次執行相同 objective 時，SemanticCache 判定 100% 命中並直接 Bypass（Token = 0），導致熔斷器未被觸發而斷言失敗。
* **處置與決策**：
  * 將測試目標動態加上時間戳記隔離快取，並將門檻設定為確定性的 `100 Tokens`。
  * 實測耗時 1.5 秒，已**正式晉升並收錄於 `OFFLINE_SUITES`**（離線套件由 5 套擴增為 6 套）。

### 2. `tests/test_advanced_features.js`
* **外部依賴性**：**混合型整合測試 (Hybrid Integration)**。
  * 涵蓋 4 個子模組：全域 Instincts 共享去重、多模型並行競速 (Parallel Racing)、指令沙盒虛擬化執行 (SandboxExecutor)、心跳與 SSE 覆寫。
  * 其中 Instincts 模組呼叫 `saveInstinct`，在內部會嘗試呼叫 Vertex/Gemini Embedding API；沙盒執行會在本機 temp 目錄建立行程並執行指令。
* **處置建議**：保持歸類於 `EXTERNAL_SUITES`（或未來將 HeartbeatRegistry 獨立拆出為純單元測試）。

### 3. `tests/test_ecc_features.js`
* **外部依賴性與代碼缺陷**：
  * **發現嚴重非同步缺陷**：第 122 行呼叫 `instinctManager.saveInstinct(...)` 時**遺漏了 `await`**，且依賴真實 Embedding API。在離線環境執行時直接拋出 `AssertionError: Instincts file should be created`。
  * **重複覆蓋**：其 Test 1 (AgentShield) 與 Test 2 (Cost Budget) 已經在 `test_guardrail.js` 與 `test_circuit_breaker.js` 中具備更高品質的單元測試。
* **處置建議**：維持在 `EXTERNAL_SUITES` 作為待修復的整合測試，單元測試已有完整覆蓋。

---

## 二、B 項鑑識：外部測試入口完整性盤點

針對磁碟上的 14 個 `EXTERNAL_SUITES` 檔案，依其性質正式定義三級分類：

| 檔案名稱 | 正式分類 | 依賴外部資源 | 執行建議 |
| :--- | :---: | :--- | :--- |
| `test_integration.js` | **EXTERNAL_TEST (正式整合)** | 多模型 API、Fallback 級聯 | `npm run test:external` 預設執行 |
| `test_all_models.js` | **EXTERNAL_TEST (正式整合)** | 驗證所有 LLM Provider 存活 | 批次外部測試涵蓋 |
| `test_fuzzy_memory.js` | **EXTERNAL_TEST (正式整合)** | Qdrant Docker + Vertex 向量 | 需 Docker 與 API Key |
| `test_advanced_features.js` | **EXTERNAL_TEST (正式整合)** | 競速調度與指令沙盒 | 批次外部測試涵蓋 |
| `test_ecc_features.js` | **EXTERNAL_TEST (待修復整合)** | 待補齊 `await` 與 Embedding | 人工排查修正 |
| `test_markitdown_agent.js` | **EXTERNAL_TEST (正式整合)** | MarkItDown 工具整合 | 批次外部測試涵蓋 |
| `test_markitdown.js` | **EXTERNAL_TEST (工具整合)** | Python MarkItDown CLI | 獨立執行 |
| `test_model_selection.js` | **EXTERNAL_TEST (正式整合)** | Router 模型規則驗證 | 可後續重構為 Unit |
| `test_gemini_models.js` | **PROVIDER_DIAGNOSTIC (診斷)** | Gemini SDK ListModels | 獨立連通性排查 |
| `test_nvidia.js` | **PROVIDER_DIAGNOSTIC (診斷)** | NVIDIA NIM 端點 | 獨立連通性排查 |
| `test_vertex_ai.js` | **PROVIDER_DIAGNOSTIC (診斷)** | Google Cloud Vertex SDK | 獨立憑證驗證 |
| `test_gcp_project.js` | **PROVIDER_DIAGNOSTIC (診斷)** | GCP API 權限檢查 | 部署前檢查 |
| `test_regions.js` | **PROVIDER_DIAGNOSTIC (診斷)** | 跨區延遲評估 | 效能診斷 |
| `test_raw_response.js` | **PROVIDER_DIAGNOSTIC (診斷)** | 原始回應格式測試 | 人工觀測 |

### 處置：
在 `package.json` 中配置：
* `"test:external"`: `node tests/run_tests.js --external`（支援透過 Runner 批次執行所有外部套件，並具備 Process 隔離與 Timeout 保護）。
* 同時保留個別檔案獨立呼叫能力。

---

## 三、C 項鑑識：Self-Correction 耗時 28.996 秒之根本原因與秒級優化

### 1. 根本原因定位
在 `cascading_executor.js` 第 145 行：
```javascript
if (!context.code_context) {
  const codeCtx = await codegraph.extractAndBuildRelations(context.objective, context.constraints);
  ...
}
```
* **問題機制**：在 `test_self_correction_flow.js` 中，傳入的 context 未指定 `code_context`。
* **滾雪球效應**：`CodeGraphAdapter` 自任務目標以及歷史注入的 Instincts 中提取了多達 **73 個符號關鍵字**。在迴圈中，它對每一個關鍵字執行：
  ```bash
  codegraph query "${symbol}" --limit 3 --json
  ```
* **耗時鑑識**：在 Windows 平台上，透過子行程連續啟動 73 次外部 `codegraph` CLI，**光是行程建立與查詢開銷就累積耗費 20 餘秒**！SC1 執行一次、SC2 執行一次，總耗時達到 28.996 秒！

### 2. 秒級優化解法（不修改業務代碼）
* 在 `test_self_correction_flow.js` 的 SC1 與 SC2 context 中，顯式傳入：
  ```javascript
  code_context: "// Offline deterministic unit test context - bypasses CLI extraction"
  ```
* 並且在 objective 中加入時間戳記防止被 `SemanticCache` 攔截。
* **成果**：
  * 執行時間從 **28.996 秒** 驟降至 **0.18 秒 (184ms)**！
  * **耗時縮減 99.3%**，且 SC1 與 SC2 的所有狀態轉換斷言 100% 保持原本標準！

---

## 四、D 項鑑識：Manifest 雙向完整性防漏驗收

執行器升級為 **雙向防漏機制 (Bidirectional Integrity)**：

```
                    ┌─────────────────────────┐
                    │  tests/*.js (Disk Files)│
                    └───────────┬─────────────┘
                                │
               ┌────────────────┴────────────────┐
     [正向檢查: 磁碟 -> 清單]          [反向檢查: 清單 -> 磁碟]
   磁碟有但清單未登記?                     清單登記但磁碟不存在?
            │                                     │
    ⚠️ 阻擋未登記新增測試                  ❌ 阻擋 Dangling References
```

### 實體驗收證明：
1. **正向故障注入**：新增 `tests/test_leak_forward.js`，執行 `npm run test:check`，輸出：
   ```text
   ⚠️  [WARNING] 發現未列入清單的測試檔案 (Uncataloged Test on Disk):
      - tests/test_leak_forward.js
   ❌ [CHECK-ONLY] 完整性檢查未通過，程序終止 (Exit: 1)。
   ```
2. **反向故障注入**：在清單中加入不存在的 `tests/test_ghost_phantom.js`，輸出：
   ```text
   ❌ [ERROR] Manifest 登記之檔案在磁碟上不存在 (Dangling Reference):
      - tests/test_ghost_phantom.js
   ❌ [CHECK-ONLY] 完整性檢查未通過，程序終止 (Exit: 1)。
   ```
3. **乾淨狀態**：回傳 `Exit Code: 0`。

---

## 五、E 項鑑識：子行程健全性與錯誤處理

在 `tests/run_tests.js` 中落實完整的子行程保護：
1. **Startup Error 處理**：監聽 `child.on('error', ...)`，若行程因路徑、權限或系統錯誤無法啟動，安全捕捉並標記 `exitCode: 1`。
2. **Signal 終止判定**：監聽 `child.on('close', (code, signal))`，若行程因外部訊號終止（`signal !== null`），強制判定 `passed: false`。
3. **超時看門狗 (Timeout Watchdog)**：
   * 預設每套測試限時 30 秒。
   * 超時自動發送 `SIGTERM`，若 2 秒後仍未終止則補發 `SIGKILL`，並標記 `TIMEOUT` 判定失敗。
4. **Exit Code 嚴格聚合**：所有子行程皆回傳 0 整體才算通過，任一非 0 即回傳 1。
