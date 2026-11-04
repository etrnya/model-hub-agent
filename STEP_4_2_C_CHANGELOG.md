# P0-B Step 4.2-C: 變更履歷與最終結案紀錄 (STEP_4_2_C_CHANGELOG.md)

本文件詳細記錄在 P0-B Step 4.2-C 級聯路由整合、容錯終止門禁與 Stop-Waiting 探針生命週期閉環中所進行之具體檔案變更、架構決策與驗證數據。

---

## 一、修改檔案清單與變更摘要

1. [`services/router.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/services/router.js)
   * **變更內容**：
     * 抽取共用私有方法 `_isEligibleCandidate(m, heartbeatRegistry)`。
     * 同時將 `quotaGuard.canProceed()` 與 `heartbeatRegistry.isCandidateEligible()` 納入候選准入審查。
     * 統一 `route()` 與 `getCandidates()` 之判定邏輯，消弭全熔斷穿透與候選過濾不一致漏洞。

2. [`infrastructure/adapters/error_mapper.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/infrastructure/adapters/error_mapper.js)
   * **變更內容**：
     * 實作 `HubCascadingError extends HubError`，確保既有 `error instanceof HubError` 契約 100% 向下相容。
     * 新增 `statusCode`、`attempts`、`cascadingSummary` 結構化追蹤欄位。
     * 新增錯誤型別：`OPERATION_CANCELLED`、`ALL_CANDIDATES_CIRCUIT_OPEN`、`TASK_TIMEOUT_EXCEEDED`、`CASCADING_FAILED`。
     * 內部取消（`RACING_LOST`, `TASK_DEADLINE`, `CALLER_CANCELLED`）嚴格歸類為 `faultScope: 'NONE'`，不影響 Provider/Model 健康度。

3. [`infrastructure/clients/base_client.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/infrastructure/clients/base_client.js)
   * **變更內容**：
     * `execute()` 接收 `signal` 與 `timeoutMs`，底層 API 與重試 sleep 均支援取消與逾時中斷。
     * 在 API 回傳後與狀態/配額寫入前設置**雙重副作用攔截防線**。
     * 追蹤底層 Promise 沉澱狀態 (`callSettled`)：
       - 若已 settle：立即執行單次中性釋放。
       - 若仍 pending（Stop-Waiting Fallback）：保持 Probe 鎖定，延遲至底層操作真正 settle 後才 Neutral Release，杜絕第二請求搶占探針。
     * 捕捉內部取消時，標記 `recordedInClient = true` 並中斷原地重試。

4. [`services/cascading_executor.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/services/cascading_executor.js)
   * **變更內容**：
     * 引入單調時鐘 `taskDeadlineMonotonic = performance.now() + taskTimeoutMs`。
     * 串行與並行 Client 調用動態壓縮至剩餘預算：`Math.min(timeout_ms, remainingMs)`。
     * Parallel Racing 設置 Task Deadline Timer，逾時廣播 `TASK_DEADLINE`；勝出者誕生時廣播 `RACING_LOST`。
     * Memory、Cache、TokenMonitor 等寫入嚴格限制於勝出者提交流程。
     * 實作 Fail-Closed 結構化終止門禁：404 (`NO_CAPABILITY`)、429 (`ALL_QUOTA_EXCEEDED`)、503 (`ALL_CANDIDATES_CIRCUIT_OPEN` 含 `minRetryAfterMs`)、504 (`TASK_TIMEOUT_EXCEEDED`)，混合失敗嚴格仲裁為 502 (`CASCADING_FAILED`)。

5. [`tests/test_router_cascading_integration.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/tests/test_router_cascading_integration.js)
   * **變更內容**：
     * 全新建立 C-1 至 C-11 確定性離線測試套件，涵蓋全模型 OPEN、503 retryAfter 指引、配額一致性、Task Deadline、Client 預算動態壓縮、Parallel Racing 雙層探針中性釋放、落敗者晚到副作用隔離、多層失敗摘要保留、單次結算防雙重 Probe、單調時鐘抗時鐘倒撥、以及 Stop-Waiting 延遲釋放。

6. [`tests/run_tests.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/tests/run_tests.js)
   * **變更內容**：
     * 將 `test_router_cascading_integration.js` 登記至 `OFFLINE_SUITES`，擴展至 10 個離線套件，通過雙向清單完整性檢查。

---

## 二、凍結不變量審查

- [`registry/heartbeat_registry.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/registry/heartbeat_registry.js)：**嚴格未修改 (FROZEN)**。
- [`shared/global_state.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/shared/global_state.js)：**嚴格未修改 (FROZEN)**。
- 無新增 Manager，無擴張既有 Circuit Breaker 狀態機。

---

## 三、驗收數據匯總

| 測試指標 | 測試結果 | 狀態 |
| :--- | :---: | :---: |
| **C-1 ~ C-11 級聯整合測試** | 11 / 11 (100%) | 通過 |
| **Step 4.2-B-2 健康狀態機回歸** | 28 / 28 (100%) | 通過 |
| **全域離線測試套件 (`npm test`)** | 10 / 10 Suites (100%) | 通過 |
| **雙向清單完整性 (`npm run test:check`)** | 32 / 32 JS 檔案全分類 | 通過 |
| **總執行耗時** | 26.98 秒 | 綠燈通過 (Exit: 0) |

---

## 四、未來演進備忘 (Non-Blocking Backlog)

1. **並行 RPM 原子預留**：目前配額檢查採發起前檢查；高併發並行任務若同時通過配額可能觸發 429，保留為未來分散式配額預留能力。
2. **Stop-Waiting 底層 IO 中止**：第三方 SDK 不支援 AbortSignal 時僅能 Stop-Waiting，無法強制中斷底層 TCP Socket，仰賴應用層晚到隔離保護。
3. **`callPromise.finally` 觀測性防護**：若未來修改 `callPromise.finally()`，應避免 `.catch(() => {})` 靜默吞掉回呼本身的意外例外。
