# P0-B Step 2.1: 變更履歷與修改依據 (STEP_2_1_CHANGELOG.md)

本文件詳細記錄在 P0-B Step 2.1 驗收補強中所進行之具體檔案變更與設計決策理由。

---

## 一、修改檔案清單

1. [`tests/run_tests.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/tests/run_tests.js)
   * **變更內容**：
     * 將 `OFFLINE_SUITES` 擴增為 6 個（正式納入 `test_circuit_breaker.js`）。
     * 實作雙向 Manifest 檢查（正向盤點未登記檔案，反向檢查不存在的登記檔案）。
     * 為子行程增加 30 秒 Timeout Watchdog，超時依序發送 `SIGTERM` / `SIGKILL`。
     * 完善 `close` 事件中的 `signal` 終止判定與 `error` 啟動失敗處理。
     * 支援 `--check-only`、`--strict-manifest`、`--external`、`--all` 參數。
   * **修改理由**：杜絕單向檢查盲區、保護離線 CI 避免無窮等待、支援批次執行外部整合測試。

2. [`tests/test_self_correction_flow.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/tests/test_self_correction_flow.js)
   * **變更內容**：
     * 在 SC1 與 SC2 context 中顯式提供 `code_context: "// Offline deterministic unit test context - bypasses CLI extraction"`。
     * 在 objective 中加入動態時間戳記以隔離磁碟上的 `SemanticCache`。
   * **修改理由**：
     * 消除因 `CodeGraphAdapter` 在迴圈中啟動 73 次外部 `codegraph` CLI 造成的 20+ 秒嚴重延遲。
     * 消除前次執行殘留快取導致 SC1 繞過 LLM 自癒狀態機的重大缺陷。
     * 執行耗時從 28.996s 降至 0.184s（效能提升 99.3%），所有斷言完全保留。

3. [`tests/test_circuit_breaker.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/tests/test_circuit_breaker.js)
   * **變更內容**：
     * 在 `mockContext` 中顯式傳入 `code_context`，切斷意外的 CodeGraph 膨脹依賴。
     * 將 `MAX_TASK_BUDGET_TOKENS` 從 1000 調為 100，使其以確定性方式超越預算。
     * 在 `mockContext.objective` 加入時間戳記，避免命中先前執行的 `SemanticCache`。
   * **修改理由**：修復「過去僅靠 CodeGraph 22KB 膨脹才碰巧觸發熔斷」與「快取命中時繞過熔斷」之兩大假陽性漏洞，使其成為純離線、快速（1.5s）的確定性單元測試。

4. [`package.json`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/package.json)
   * **變更內容**：
     * 新增 `"test:check"`: `"node tests/run_tests.js --check-only"`。
     * 更新 `"test:external"`: `"node tests/run_tests.js --external"`。
   * **修改理由**：提供標準化腳本供人類與 CI 進行清單防漏檢查與外部批次整合測試。

---

## 二、執行數據前後對比

| 評估維度 | Step 2 (前) | Step 2.1 (後) | 改善幅度 |
| :--- | :---: | :---: | :---: |
| **離線測試套件數** | 5 Suites | **6 Suites** | +1 (納入 Circuit Breaker) |
| **Self-Correction 耗時** | 28,996 ms | **184 ms** | **-99.3%** |
| **總套件執行耗時** | 29.27 s | **2.01 s** | **速度提升 14.5 倍** |
| **Manifest 防漏機制** | 單向 (僅查磁碟多餘) | **雙向 (正向查多餘 + 反向查失效)** | 具備雙向防呆 |
| **子行程保護** | 僅檢查 exitCode | **error + signal + 30s Timeout** | 具備防卡死守護 |
| **External 入口** | 僅指向單一檔案 | **支援 `--external` 批次執行** | 涵蓋所有外部測試 |
| **整體 Exit Code** | `0` | **`0`** | 綠燈通過 |
