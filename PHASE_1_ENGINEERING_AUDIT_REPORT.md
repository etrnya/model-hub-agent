# 🛡️ Phase 1 Consolidation & Engineering Audit Report
**專案**：`model-hub-agent` (Antigravity Agent OS 核心)  
**審查分支**：`feature/phase-1-codegraph`  
**審查基線**：P0-B (`b5a2daf`) ➔ P1-A (`b789011`) ➔ P1-B (`06a7b91`, `ae2612d`) vs `main` (`ed1e7bb`)  
**變更規模**：70 份檔案變更，+14,776 行 / -649 行  
**審查日期**：2026-11-04  
**審查架構師**：Antigravity Agent OS 審查委員會 (etrnya)

---

## 🎯 執行摘要與工程裁決 (Executive Summary & Verdict)

### 門禁裁決結果：⚠️ CONDITIONAL PASS (有條件通過)

> ⚠️ **核心裁決陳述**  
> 儘管全域 14 套離線測試套件達成 **100% 通過 (14/14 Suites PASS, 29.05s)**，但白箱原始碼審查發現 **1 處重大資安破口** 與 **2 處生產級連線維運風險**。  
> **嚴禁立即無條件合併至 `main`**。必須在當前分支先行修補這 3 項前置阻斷項目、重新執行自動化回歸斷言後，方可進入人類核准程序並合併至 `main`。

---

## 🔍 Gate 1｜獨立程式碼審查 (Independent Code Review)

### 1.1 發現之重大資安破口 (High Severity)
* **漏洞位置**：`server.js` 第 275~359 行
* **漏洞描述**：
  在 P1-B Final Patch (`ae2612d`) 中，已為 `/api/events`、`/api/stats`、`/api/tasks` 與 `/dispatch` 實裝了 `isLoopbackAddress(req)` 本機存取保護。然而，以下 4 個高敏感管理端點**完全遺漏了 Localhost 檢查**：
  1. `POST /api/memory/clear`：**極高危險**。區域網路內任何未授權設備可直接發送 HTTP 請求，強制執行 `DELETE /collections/global_shared_memory`，**清空全部 Qdrant 語意向量資產**。
  2. `POST /api/circuit-breaker/toggle`：外部設備可重置 `totalSessionCost`，強行解除熔斷保護造成 Token 盜刷。
  3. `POST /api/benchmark`：外部設備可觸發耗時且高負載的多模型背景評測。
  4. `POST /api/models/override-status`：外部設備可惡意竄改模型健康狀態。
* **處方**：必須將此 4 個端點統一納入 `isLoopbackAddress(req)` 門禁防線，非本機請求一律拒絕 (403 Forbidden)。

### 1.2 SSE 連線與資源生命週期審查 (Medium Severity)
* **審查檔案**：`server.js` (L122-L144)
* **風險 1：缺乏定期 Keep-Alive 心跳計時器**
  - 現行實作僅在客戶端連線時發送一次 `event: ping`。若長達數分鐘沒有新任務事件，瀏覽器、本機防火牆或代理層將因超過 Idle Timeout (通常 60~120s) 而靜默中斷連線。
  - **處方**：於伺服器層引入 15 秒間隔之 SSE Keep-Alive 心跳廣播 (`setInterval(() => broadcastEvent('ping', { time: Date.now() }), 15000)`)，並在伺服器關閉時清除計時器。
* **風險 2：缺乏 Event ID 歷史補償 (Last-Event-ID)**
  - 當 SSE 因網路瞬斷重連時，不支援回放遺漏的生命週期事件；客戶端必須退化為透過 `GET /api/tasks/:id` 進行全量狀態輪詢。此項目前有測試 T14 保障其輪詢補償性，列為架構已記錄限制。

### 1.3 TaskManager 任務一致性與容量審查
* **審查檔案**：`services/task_manager.js`
* **架構確認**：
  - **淘汰政策嚴謹**：`submitTask` 僅在 `MAX_STORE_CAPACITY (50)` 且存在終態任務時淘汰最舊的 `COMPLETED`/`FAILED`，絕不淘汰 `QUEUED` 或 `RUNNING`。
  - **名額守護完整**：`activeCount` 的扣減嚴格綁定在 `_executeTask` 的 `finally` 區塊，底層 Promise 真正 settle 前絕不提前釋放，防止併發滲漏。
  - **記憶體邊界（已知架構約束）**：TaskManager 為純記憶體 Map 實作。若主進程異常崩潰，所有佇列中的任務將遺失，不具備 WAL (Write-Ahead Log) 崩潰復原能力。

### 1.4 GlobalState OCC 作用域與競爭審查
* **審查檔案**：`shared/global_state.js`、`main.js` (L44-L46)
* **關鍵架構洞察**：
  - `main.js` 每次收到 `dispatchTask` 時，皆執行 `const stateManager = new GlobalState(activePayload);`。
  - 這意味著目前的 OCC 機制是 **「任務內部多步驟演進保護 (Task-Scoped OCC)」**，而非跨 HTTP 請求的多人共享分散式狀態庫。因此，兩個非同步任務並行執行時，各自擁有獨立的 `GlobalState` 實例，**不存在跨任務版本踩踏風險，但也尚未支援跨任務共享狀態寫入**。

---

## 🧪 Gate 2｜整合與極限邊界分析 (Integration & Boundary Matrix)

| 極限情境 (Edge Scenario) | 現行行為 (Observed Behavior) | 風險等級 | 評估與防禦現況 |
| :--- | :--- | :---: | :--- |
| **1. 雙任務同時修改 GlobalState** | 因 `main.js` 採 Per-Task 獨立狀態實例，兩者記憶體完全隔離。 | 🟢 低 | 符合當前 Phase 1 任務隔離設計；未來若擴充跨任務共享庫需引入分散式鎖。 |
| **2. 伺服器進程異常終止 (SIGINT/Crash)** | 記憶體內 `QUEUED` 與 `RUNNING` 任務直接消失，客戶端收到連線中斷。 | 🟡 中 | 本機 Agent OS 目前無 WAL 持久化機制；需在文檔明確標註為 In-Memory Bounded 系統。 |
| **3. SSE 大量連線與突發中途斷線** | `req.on('close')` 會移除 client；廣播拋錯時有 `try/catch` 移除非法連線。 | 🟢 低 | 基本資源回收健全，補上 15s Keep-Alive 計時器即可達標。 |
| **4. Queue 滿載 (2 RUNNING + 10 QUEUED)** | 第 13 筆任務提交時，原子拋出 429 `TASK_QUEUE_FULL`。 | 🟢 通過 | 單元測試 T11 與 T21 已嚴格斷言，抗排擠防禦正常。 |
| **5. Router Timeout 與 Task Deadline 同步發生** | `CascadingExecutor` 雙單調時鐘在勝出者誕生時廣播 `RACING_LOST` 隔離副作用。 | 🟢 通過 | P0-B Step 4.2-C (C-1~C-11) 測試已完整覆蓋確定性離線斷言。 |
| **6. 重複提交 (Duplicate Submissions)** | 缺乏 `Idempotency-Key`，重複 POST 會生成不同 `taskId` 獨立執行。 | 🟡 中 | 建議於 Phase 2 或後續迭代中引入可選的 `x-idempotency-key` 查重標頭。 |

---

## 📦 Gate 3｜部署、回滾與相容性審查 (Deployment & Compatibility)

### 3.1 環境變數與配置檔衛生
* **檢查 `model-hub-agent/.env.example`**：
  - 現有範本僅有 `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OLLAMA_BASE_URL`。
  - **缺漏項目**：
    - `AGENT_OS_PORT` (預設 3000)
    - `QDRANT_URL` (預設 http://localhost:6333)
    - `MEMORY_TTL_DAYS` (預設 7)
    - `GCP_SERVICE_ACCOUNT_KEY` 或相關憑證說明
  - **處方**：更新 `.env.example`，將所有服務預設值與可選配置完整標註。

### 3.2 API 向下相容性 (Backward Compatibility)
* `POST /dispatch` 舊版同步調用維持 100% 行為不變，不強制進入 TaskManager 佇列（測試 T18 通過）。
* 新增之 `GET /api/roles`、`POST /api/tasks`、`GET /api/tasks` 為純增量 API，對舊版客戶端零破壞。

### 3.3 巨大差異與回滾能力 (Git Diff vs `main`)
* `main` 目前停留在 `ed1e7bb` (2026 年 6 月發布版)。本分支包含 70 個檔案、1.4 萬行代碼演進。
* **回滾方案**：若合併後發生生產阻斷，因 `main` 為長期穩定錨點，可隨時透過 Git Tag 一鍵切回。在合併前必須於 `feature/phase-1-codegraph` 打上 `checkpoint/pre-merge-phase-1` 標籤作為不可逆歷史快照。

---

## 🚦 Gate 4｜前置修復行動清單與合併門禁 (Action Plan & Merge Gate)

### 必須完成的 3 項前置阻斷修復 (Must-Fix Patches)：
1. [ ] **【安全】補齊 4 大管理端點 Localhost 門禁**：
   在 `server.js` 為 `/api/memory/clear`、`/api/circuit-breaker/toggle`、`/api/benchmark`、`/api/models/override-status` 補上 `if (!isLoopbackAddress(req)) return 403;`。
2. [ ] **【穩定性】增加 SSE 15s 定期 Keep-Alive 心跳**：
   在 `server.js` 實裝週期性 ping 計時器，防止客戶端連線靜默逾時。
3. [ ] **【設定衛生】補全 `.env.example`**：
   補齊 `AGENT_OS_PORT`、`QDRANT_URL` 等環境變數說明。

---

## 📋 最終裁決與下一步裁示請求

本報告判定：**在完成上述 3 項前置阻斷修復並通過全套回歸測試前，暫緩執行 `git merge main`**。

待上述修補完成後，將彙報更新後的綠燈驗證數據，並**等待用戶的手動確認與授權**，才會執行以下動作：
1. 建立 Checkpoint Git Tag (`v1.4.0-phase-1-ready`)。
2. 切換至 `main` 執行 Fast-Forward 或 Merge。
3. 開立全新的 `feature/p1-c-codegraph-retrieval` 專屬分支開展 CodeGraph 深度整合。

