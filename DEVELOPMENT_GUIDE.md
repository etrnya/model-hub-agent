# model-hub-agent 開發指南 (Development Guide)

本指南為 `model-hub-agent`（Agent OS 核心）之專案專屬工程手冊，與 [.agents/AGENTS.md](.agents/AGENTS.md) 及 [GLOSSARY.md](GLOSSARY.md) 共同構成雙層開發規範。

---

## 1. 核心架構與 P1-C1 ～ P1-C4 管線

### 1.1 多模型級聯與容災主幹
* **入口**：`main.js` 透過樂觀鎖 `GlobalState` (`shared/global_state.js`) 呼叫 `services/cascading_executor.js`。
* **路由與斷路器**：`services/router.js` + `registry/heartbeat_registry.js` 依任務模態與層級挑選候選模型，並支援並行競速與故障降級。
* **驗證與防護**：`services/guardrail_manager.js`（輸入/輸出 DLP 掃描與 Prompt Injection 攔截）與 `services/verification_gate.js`（非對稱雙重驗證與 Fail-Closed 閘門）。

### 1.2 P1-C1 ～ P1-C4 上下文編譯與隔離管線
`services/cascading_executor.js` 透過 `compileCodeGraphContext()` 將結構化程式碼檢索任務串接至以下管線：

1. **AST 與影響分析 (P1-C1 / P1-C2)**：
   * `infrastructure/adapters/codegraph_adapter.js` + `infrastructure/adapters/codegraph_schemas.js`
   * `services/call_graph_engine.js`（Caller/Callee 與 Blast Radius 影響分析）
2. **角色感知規劃與預算守衛 (P1-C3.1)**：
   * `services/context_planner.js`（`RoleAwareContextPlanner.plan()`，依角色與任務類型產生 `RetrievalPlan`）
   * `services/token_budget_guard.js`（強制 3,000 Token 硬上限與三模式估算契約）
3. **證據驗收與上下文編譯 (P1-C3.2)**：
   * `services/evidence_admission.js`（`EvidenceAdmissionEngine`：單次 `fs.readFile` 讀取快照、UAX #31 `\p{ID_Continue}` 識別碼邊界、防洗白數值門禁）
   * `services/context_compiler.js`（`ContextCompiler`：5 層確定性排序、XML CDATA 隔離封裝、2,000ms DLP Watchdog、裁剪後二次計量同源不變性）
4. **隔離邊界與 90 格降級矩陣 (P1-C3.3)**：
   * `services/isolation_boundary.js`（純 JS 隔離層：13 欄位 TLV 租戶隔離、`AdmissionReceipt`、`SourceProvenanceToken`、`decidePublication()` 90 格權威政策矩陣與 Fail-Closed 阻斷）
   * 註：未編譯之 C++ Native 沙盒與 `ProcessLifecycleManager` 目前暫緩於 `forensics/` 備份，未納入主線。
5. **任務感知動態檢索與二階段自癒閉環 (P1-C4)**：
   * `services/role_manager.js` 與 `services/task_manager.js`：驗證並透傳 `roleId`、`taskId`、`action`、`targetFiles`、`targetSymbols`、`tenantId`、`taskType` 與 `maxExecutionTokens` 至 `taskPayload`。
   * `services/cascading_executor.js`：
     * **Phase 1 (PRE_DISPATCH)**：`compileCodeGraphContext()` 自動識別角色與任務策略，透過 `CallGraphEngine` 執行雙向拓撲遍歷 (`buildCallGraph`) 與衝擊範圍評估 (`assessBlastRadius`)，並經 `EvidenceAdmissionEngine` 與 `ContextCompiler` 封裝注入。
     * **Phase 2 (SELF_CORRECTION)**：當 `VerificationGate` 判定內容驗證失敗 (`VERIFICATION_CONTENT_FAIL`) 時，自動將 CodeGraph 遍歷深度動態擴展至 `depth=3` 重新編譯上下文並寫入 `_correction_feedback.expanded_context_depth`，支援多跳呼叫邊界自癒。
6. **觀測遙測與 API 冪等防重強化 (Phase 2 Observability & Idempotency)**：
   * `x-idempotency-key` 冪等防重：`TaskManager.submitTask()` 與 `POST /api/tasks` 支援 `x-idempotency-key` 標頭，對相同 Payload 自動去重並回傳既有 `taskId`（`deduplicated: true`），對不同 Payload 重複使用同一 Key 則嚴格攔截並回傳 `409 IDEMPOTENCY_KEY_CONFLICT`。
   * CodeGraph 編譯遙測指標：`cascadingExecutor.getCodeGraphTelemetry()` 與 `getTaskTelemetry(taskId)` 自動記錄每次編譯之 `policyName`、`traversalDepth`、`measuredTokens`、`snapshotId`、`blastRadiusLevel` 與自癒擴展次數，並同步掛載至 `GET /api/tasks/:id` (`contextMeta`)、`GET /api/stats` (`codeGraphTelemetry`) 與 Web 控制台 (`observability/dashboard.html`)。

---

## 2. 測試規範 (`npm test`)

* **執行指令**：`npm test`（執行 `node tests/run_tests.js`）
* **雙向完整性清單門禁 (Bidirectional Manifest Check)**：
  * `tests/run_tests.js` 會掃描磁碟上的所有 `tests/*.js`（目前 42 個檔案），並強制核對是否已全數分類至 `OFFLINE_SUITES`（20 套）、`EXTERNAL_SUITES`（14 套）或 `UTILITY_SCRIPTS`（8 套）。
  * **任何新增或移除測試檔，必須同步更新 `tests/run_tests.js`**，否則測試跑者將立即中止。
* **離線測試基線**：提交任何變更前，必須確保全部 **20 / 20** 離線測試套件通過（`Exit Code: 0`）。
* **測試假憑證衛生**：測試案例中若需測試 DLP 遮罩（如 Stripe Key 樣式），**嚴禁寫入連續字面量**，須改用執行期字串拼接（例如 `'sk_live_' + '1234...'`），以免觸發 GitHub Push Protection (`GH013`)。

---

## 3. 凍結模組邊界 (Frozen Modules Checkpoint)

`tests/test_role_integration.js`（R12，比對 `b5a2daf`）與 `tests/test_async_task_integration.js`（T19，比對 `b789011`）強制保護以下 **6 個核心檔案** 不得任意修改：
* `shared/global_state.js`
* `registry/heartbeat_registry.js`
* `services/router.js`
* `infrastructure/adapters/error_mapper.js`
* `infrastructure/clients/base_client.js`
* `main.js`

*(註：`services/cascading_executor.js` 已於 Phase 1-C4 正式解凍以接線 P1-C 管線；上述其餘 6 個檔案仍維持凍結保護。)*

---

## 4. 基礎設施與安全注意事項

1. **Qdrant 向量維度鎖定**：使用 `text-embedding-004` 時必須嚴格鎖定 **768 維** 並於寫入/查詢端校驗維度，避免 Invalid Argument 連線失敗。
2. **429 級聯容災**：當 AI Studio 發生 `429 Resource Exhausted` 時，級聯執行器須於 **200ms 內** 切換至 GCP Vertex AI 後備用戶端。
3. **CIG 壓縮豁免**：`refactor` 與 `debug` 任務必須繞過 Context 壓縮以防代碼幻覺；僅在 `query` / `explain` 類任務啟用壓縮。
4. **憑證零外洩**：`.env`、`*key*.json`、`gemini-api-ai-assistant-*.json` 與 `forensics/` 均已列於 `.gitignore`，嚴禁強制加入版控或貼入對話。

---

## 5. 歷史版本標籤與凍結基線紀錄

* `v1.3.0-phase-3`（`ed1e7bb`, 2026-06-29）：早期經典版。
* `v1.4.0-phase-1-consolidated`（`e88276f`, 2026-11-04）：P0-B / P1-A / P1-B 整合版。
* `v1.5.0`（`32158e0`, 2026-11-19）：Evidence-First Agent Infrastructure 定位升級、Apache 2.0 授權與文件版本對齊。
* **Phase 1 修復凍結基線 (`92a52e0`, 2026-11-19 — FROZEN)**：
  * **正式凍結聲明**：Phase 1 本輪修復完成。預設跨程序鎖定採 Strict Fail-Closed（`CROSS_PROCESS_ATOMIC_LOCKFILE_STRICT`），避免自動清除其他程序鎖檔所引發的競態風險。Best-Effort Recovery（`CROSS_PROCESS_ATOMIC_LOCKFILE_BEST_EFFORT_RECOVERY`）保留為明確選擇的相容性能力，但不提供 Strict 等級或 OS 核心鎖（`flock`/`LockFileEx`）等價之安全保證。FD 證據驗證（6 欄位 + 64 字元 `emittedContentSha256` 強制核驗）與 Idempotency Canonicalization（完整 `Reflect.ownKeys` + `getOwnPropertyDescriptors` 嚴格 JSON 契約）之既有缺失已完成修正。全倉盤點確認 **0 個產品路徑** 啟用 `allowBestEffortCrashRecovery: true`（僅 `tests/test_remediation_fault_injection.js` 測試使用）。**21 / 21 離線測試套件全數通過（Exit Code: 0）**。此基線進入 **FROZEN**，後續變更須另行提出需求與審查。
  * **Strict 鎖定維運操作要求**：
    1. Strict 模式發生鎖定逾時時，呼叫端應留下可追蹤的錯誤紀錄。
    2. 人工清理殘留鎖檔前，必須先確認原持有程序（PID）確實已停止。
    3. 清理流程必須避免在仍有程序執行時刪除鎖檔。
    4. 嚴禁將 Best-Effort Recovery 描述為與 OS 核心鎖等價之安全保證。

