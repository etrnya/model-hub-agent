# P0-B Step 4.1 — Router Health 架構鑑識審計報告 (Architecture Forensic Audit)

**報告日期**: 2026-11-02  
**鑑識標的**: `model-hub-agent` 模型調度、健康監控、熔斷與故障恢復機制  
**執行原則**: 唯讀鑑識（Read-Only）、零程式碼修改、零架構擴張、程式碼具體證據導向  

---

## 摘要與核心發現 (Executive Summary)

本鑑識針對 `model-hub-agent` 現存之模型路由（Router）、熔斷（Circuit Breaker）、級聯執行（Cascading Executor）、心跳註冊表（Heartbeat Registry）與錯誤映射（Error Mapper）進行端到端全方位代碼審計。

鑑識證實系統目前存在 **五大核心架構斷層**：

1. **「Circuit Breaker」名實不符與概念分裂**：
   - 專案中名為 `[CircuitBreaker]` 且在測試套件 `tests/test_circuit_breaker.js` 中驗證的機制，本質上是 **「Token / 費用預算熔斷器 (Financial / Budget Guard)」**，依據累計 Token 數與 USD 費用中斷整個 Task。
   - 真正具備故障熔斷語意的機制被命名為 `Hot Circuit Breaker`，隱身於 `registry/heartbeat_registry.js`，且僅有二元狀態 (`healthy` vs `degraded`)，**不存在業界標準的 `CLOSED`、`OPEN`、`HALF-OPEN` 狀態機**。

2. **Router 與 CascadingExecutor 呼叫鏈致命脫節**：
   - `services/router.js` 實作了兩個方法：`route()` 與 `getCandidates()`。
   - `route()` 檢查了 `heartbeatRegistry.isHealthy()` 與 `quotaGuard.canProceed()`。
   - 但實際由 `main.js` 呼叫的 `services/cascading_executor.js`，**呼叫的是 `router.getCandidates()`，該方法完全沒有檢查健康狀態與 Quota！** 導致 CascadingExecutor 在遍歷候選模型時，Degraded 模型仍會被無條件選中並重試。

3. **健康狀態顆粒度錯誤（Provider 層級 vs Model 層級）**：
   - `heartbeatRegistry` 以 `provider`（如 `google`, `vertex-ai`, `nvidia-nim`, `deepseek`）為 Key 保存狀態，而非 `(provider, model_id)`。
   - 單一模型（例如已棄用的舊模型）的呼叫失敗，會立即將該 Provider 下的所有模型（包括健康且高效的旗艦模型）全部標記為 Degraded（降級 5 分鐘）。

4. **錯誤分類嚴重缺漏，401 認證錯誤與 429 限流混淆**：
   - `infrastructure/adapters/error_mapper.js` 對 Google 與 DeepSeek 的 401/403 均返回 `HUB_UNKNOWN_ERROR`。
   - `infrastructure/clients/base_client.js` 在 API 拋出任何 Exception 時，均無差別呼叫 `markDegraded()`，並在原地進行 3 次指數退避重試（Exponential Backoff）。認證錯誤（永久性配置缺陷）被誤當作暫時性網路抖動重試，並白白浪費冷卻時間。

5. **測試存在嚴重假陽性與盲區**：
   - 現有離線測試套件中的 `test_circuit_breaker.js` 僅測試了 Token 預算超額阻斷，未測試任何模型健康或節點故障熔斷。
   - 整個測試庫中對 `heartbeatRegistry` 的唯一測試僅出現在外部測試 `test_advanced_features.js` 的 8 行斷言中，且僅測試手動設定後的字串回傳，未測試冷卻超時、探測與自癒機制。

---

## 一、現有模組架構圖 (Module Architecture Diagram)

```mermaid
flowchart TD
    subgraph ClientLayer [呼叫端入口]
        Main[main.js] --> CascadingExec[services/cascading_executor.js]
    end

    subgraph RoutingLayer [路由與決策層]
        CascadingExec -->|1. 請求候選名單: getCandidates()| Router[services/router.js]
        Router -->|讀取模型靜態元資料| ModelReg[registry/model_registry.js]
        Router -.->|route() 內讀取，但 Cascading 未呼叫| HeartbeatReg[registry/heartbeat_registry.js]
        Router -.->|route() 內讀取，但 Cascading 未呼叫| QuotaGuard[infrastructure/adapters/quota_guard.js]
    end

    subgraph ExecutionLayer [級聯執行與熔斷層]
        CascadingExec -->|2. 依序遍歷候選者| BaseClient[infrastructure/clients/base_client.js]
        CascadingExec -->|預算超額檢查: MAX_TASK_BUDGET_TOKENS| CostBreaker[Budget Guard CircuitBreaker]
        
        BaseClient -->|3. 原地重試 3 次| ConcreteClient[Gemini / DeepSeek / NIM / Vertex]
        ConcreteClient -->|HTTP 429 / 401 / 500| ErrorMapper[infrastructure/adapters/error_mapper.js]
        
        ConcreteClient -->|API 失敗| BaseClientFail[BaseClient catch]
        BaseClientFail -->|無差別標記 Degraded 5 分鐘| HeartbeatReg
        
        CascadingExec -->|4. 捕獲 Candidate 失敗| CascadeFail[CascadingExecutor catch]
        CascadeFail -->|再次標記 provider 失敗| HeartbeatReg
        CascadeFail -->|Fallback| NextCandidate[遍歷下一個候選模型]
    end

    subgraph HealthState [健康狀態儲存]
        HeartbeatReg -->|記憶體 Map: history| ProviderStats[Provider-Level: latency, lastStatus, degradedUntil]
    end
```

---

## 二、Router 呼叫鏈與候選機制現況 (Router Forensic Audit)

### 1. 程式碼位置
- 實作檔案：[`services/router.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/services/router.js) (共 137 行)
- 模型註冊表：[`registry/model_registry.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/registry/model_registry.js) (共 94 行)

### 2. 模型候選清單如何建立
- 在 `router.getCandidates(requirements)` 中：
  - 第 113-114 行：
    ```javascript
    let candidates = modelRegistry.getModelsByCapability(modalities)
      .filter(m => m.context_window >= minContext);
    ```
  - 僅依賴 `modalities`（支援模態）與 `context_window` 進行過濾。

### 3. 模型排序與選擇依據
- 排序邏輯（`router.js` 第 117-130 行）：
  1. **第一優先權（Tier Match）**：與任務指定的 `preferredTier` 完全吻合者優先排前。
  2. **第二優先權（Performance Tier 權重）**：權重順序為 `ultra` (4) > `high` (3) > `medium` (2) > `low` (1)。
  3. **第三優先權（Average Latency）**：呼叫 `heartbeatRegistry.getAverageLatency(a.provider)`，延遲低者優先。

### 4. 路由分層與關鍵架構斷層
- **架構斷層證據**：
  - `router.route()`（第 45-102 行）內部確實有健康過濾（第 66-70 行）：
    ```javascript
    candidates = candidates.filter(m => {
      const quotaOk = quotaGuard.canProceed(m.provider, m.limits);
      const isHealthy = heartbeatRegistry.isHealthy(m.provider);
      return quotaOk && isHealthy;
    });
    ```
  - **但是，整個系統的執行引擎 `cascading_executor.js` 完全不使用 `router.route()`！**
  - 在 [`services/cascading_executor.js:182-185`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/services/cascading_executor.js#L182-L185)：
    ```javascript
    const candidates = router.getCandidates({
      modalities: requiredModalities,
      preferredTier: activeTier
    });
    ```
  - **結論**：`router.getCandidates()` 根本沒有過濾掉 Degraded 節點！所有已經降級或熔斷的 Provider 模型依然排在 Candidate 清單中被依次調度執行。

### 5. 是否考慮歷史失敗紀錄？
- 否。候選清單建立時完全不參考歷史失敗次數或當前是否處於 Cooldown 期間。僅在排序時參考了成功的平均 Latency。

### 6. Router 發生 Exception 時呼叫端如何處理？
- 若 `router.getCandidates()` 返回空陣列（例如無任何模型支援請求之 modality）：
  - `cascading_executor.js` 在第 271 行 `for (const capability of candidates)` 直接跳過迴圈。
  - 最終在第 499 行拋出：
    ```javascript
    throw new Error(`[CascadingExecutor] All ${attempts} candidates failed. Last error: ${lastError ? lastError.message : 'undefined'}`);
    ```
  - `attempts` 為 0，`lastError` 為 `null`，導致拋出 `Cannot read property 'message' of null` 的二次未受控異常。

---

## 三、Circuit Breaker 現況鑑識 (Circuit Breaker Forensic Audit)

### 1. 實作位置與概念雙軌
程式庫中存在兩個彼此無關的「熔斷」概念：

| 機制名稱 | 實作檔案 | 職責定義 | 狀態儲存 |
| :--- | :--- | :--- | :--- |
| **Budget Guard Circuit Breaker** | [`services/cascading_executor.js:318-326, 487-493`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/services/cascading_executor.js#L318-L326) | 財務與 Token 上限控制 | 執行階段區域變數 (`cumulativeTokens`, `cumulativeTaskCostUSD`) |
| **Hot Circuit Breaker** | [`registry/heartbeat_registry.js:18-36, 49-56`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/registry/heartbeat_registry.js#L18-L36) | 節點健康與故障冷卻 | 記憶體 Map (`HeartbeatRegistry.history`) |

### 2. CLOSED、OPEN、HALF-OPEN 狀態機檢驗
- **鑑識結果：不存在三態狀態機。**
- 在 `registry/heartbeat_registry.js` 中：
  - 只有字串標記：`healthy` 與 `degraded`（以及未初始化時的 `unknown`、超時未呼叫的 `stale`）。
  - **Failure Threshold**：固定為 **1**。只要單次呼叫 `record(provider, latency, false)`，即無條件觸發：
    ```javascript
    stats.lastStatus = 'degraded';
    stats.degradedUntil = Date.now() + 300000; // 5 minute hot circuit breaker
    ```
  - **Cooldown 時間**：硬編碼（Hardcoded）為 300,000 ms (5 分鐘)，無法依據錯誤型態（如 429 的 Retry-After）動態調整。
  - **HALF-OPEN 探測**：**完全不存在**。
    - 檢驗第 52-54 行：
      ```javascript
      if (stats.lastStatus === 'degraded' && Date.now() < (stats.degradedUntil || 0)) {
        return false;
      }
      return true;
      ```
    - 當 5 分鐘時間一到，`Date.now() < stats.degradedUntil` 瞬間變為 `false`，`isHealthy()` 直接重置為回傳 `true`（全開恢復），允許可怕的併發請求全量灌入，完全缺乏 Canary 試探（HALF-OPEN）保護機制。

### 3. 多模型共用狀態問題（Provider-Level Blast Radius）
- `heartbeat_registry.js` 第 8 行：
  ```javascript
  this.history = new Map(); // Map<provider, { latency, lastStatus, lastSeen, degradedUntil }>
  ```
- 狀態儲存的 Key 是 `provider`（字串：`google`, `deepseek`, `nvidia-nim`, `vertex-ai`）。
- **衝擊舉例**：
  - 若 `vertex/gemini-1.5-pro-002` 發生一次 404（模型停用）或驗證失敗，`provider = "vertex-ai"` 被標記為 `degraded`。
  - 同一 Provider 下的 `vertex/gemini-2.5-pro` 與 `vertex/gemini-2.5-flash` 連帶全部被視為降級！

---

## 四、Provider 錯誤分類現況鑑識 (Error Classification Matrix)

### 1. UnifiedErrorMapper 實作與使用全貌
- 檔案位置：[`infrastructure/adapters/error_mapper.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/infrastructure/adapters/error_mapper.js)
- 定義之內部錯誤碼：
  - `HUB_RATE_LIMIT`
  - `HUB_POLICY_VIOLATION`
  - `HUB_CONTEXT_OVERFLOW`
  - `HUB_AUTH_ERROR`
  - `HUB_INTERNAL_ERROR`
  - `HUB_UNKNOWN_ERROR`

### 2. 現有分類覆蓋率與缺陷分析矩陣

| 錯誤類型 | 各 Provider 實際映射狀態 | 實體程式碼表現 | 缺陷與架構風險 |
| :--- | :--- | :--- | :--- |
| **HTTP 401 (Auth Error)** | 僅 `nvidia-nim` 映射至 `HUB_AUTH_ERROR`；**`google` 與 `deepseek` 均落入 `HUB_UNKNOWN_ERROR`** | `error_mapper.js:39`（NIM 支援）；Google/DeepSeek 無 401 分支 | **嚴重**：Google/DeepSeek 金鑰無效時，系統無法識別為 Auth 故障，反而觸發 3 次重試與 5 分鐘 Degraded。 |
| **HTTP 403 (Forbidden)** | **全部 Provider 均未處理**，落入 `HUB_UNKNOWN_ERROR` | 無任何 `status === 403` 判斷 | 無法區分 IAM 權限不足與一般故障。 |
| **HTTP 429 (Rate Limit)** | Google, DeepSeek, NIM 均映射為 `HUB_RATE_LIMIT` | `error_mapper.js:28, 33, 38` | **未讀取 `Retry-After` Header**。全部被當成固定 5 分鐘冷卻，無法執行微退避或依指定秒數冷卻。 |
| **Timeout (連線/讀取超時)** | **未獨立分類**，落入 catch 區塊被視為 status: 500 | `gemini_client.js:120`, `deepseek_client.js:81` | 網路抖動與服務端內部崩潰混為一談。 |
| **Network Error (DNS/ECONNREFUSED)** | 同上，被客戶端 catch 強制賦予 `status: 500` 送入 mapper | `gemini_client.js:120` | 將傳輸層故障視為 Provider 應用層 500 錯誤。 |
| **HTTP 500 (Internal Error)** | **未獨立處理**，落入 `HUB_UNKNOWN_ERROR` | `error_mapper.js` 無 500 分支，預設回傳 `HUB_UNKNOWN_ERROR` | `HUB_INTERNAL_ERROR` 雖然有定義，但**從未被任何分支 return**（死代碼）。 |
| **HTTP 502/503/504 (網關/服務中斷)** | **全部 Provider 均未處理**，落入 `HUB_UNKNOWN_ERROR` | 無任何 502/503/504 分支 | 上游暫時性 Proxy 錯誤被視為未知異常。 |
| **Model Not Found (404)** | **全部未處理**，落入 `HUB_UNKNOWN_ERROR` | 無任何 404 分支 | 模型已除役或拼寫錯誤時，會觸發 3 次重試與級聯降級，而非快速失敗（Fail-Fast）。 |
| **Invalid Request (400)** | DeepSeek 僅檢查 `message.includes("context")`；其餘 Provider 未處理 | `error_mapper.js:34` | 用戶參數格式錯誤會導致模型端重試 3 次。 |

### 3. 重試與冷卻的盲目性證據
在 [`infrastructure/clients/base_client.js:107-122`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/infrastructure/clients/base_client.js#L107-L122)：
```javascript
} catch (error) {
  const duration = Date.now() - startTime;
  heartbeatRegistry.record(this.modelCapability.provider, duration, false);
  heartbeatRegistry.markDegraded(this.modelCapability.provider, error.message);
  
  console.error(`[BaseClient] API Error on attempt ${attempt}:`, error.message);
  lastError = error;
}

// Exponential backoff
if (attempt < this.retryConfig.maxRetries) {
  const delay = this.retryConfig.initialDelay * Math.pow(2, attempt - 1);
  await new Promise(resolve => setTimeout(resolve, delay));
}
```
**鑑識結論**：
不管錯誤是 401（密鑰錯）、400（參數錯）還是 429（限流），`BaseClient` 都會：
1. 立刻將 Provider 降級 5 分鐘；
2. 依然執行原地 3 次重試（1 秒、2 秒、4 秒延遲）；
3. 產生雙重重複計時（`BaseClient` 記錄一次失敗，`CascadingExecutor` 又記錄一次失敗）。

---

## 五、Router 與 Circuit Breaker 職責邊界矩陣

| 模組職責 | 理論預期責任 | 目前實際代碼責任 | 架構衝突 / 缺陷評估 |
| :--- | :--- | :--- | :--- |
| **Router** | 負責依任務屬性與健康過濾候選模型清單 | `route()` 有做健康檢查；但 `getCandidates()` **完全不做健康與 Quota 檢查** | **嚴重衝突**：調度器調用了未受保護的 `getCandidates()`，使健康檢查形同虛設。 |
| **HeartbeatRegistry** | 負責追蹤端點可用性、RTT 與熔斷狀態機 | 只有 Provider 層級的單純 `healthy`/`degraded` 標記與 5 分鐘固定倒數 | **職責不足**：無模型維度、無三態狀態機、無主動探測。 |
| **CascadingExecutor** | 負責多模型級聯 Fallback、平行競速與驗證循環 | 實作了 Token/USD 財務熔斷；在 Catch 區塊中重複呼叫 `heartbeatRegistry.record()` | **職責混淆**：將財務預算檢查命名為 `[CircuitBreaker]`，與節點健康熔斷產生語意混淆。 |
| **BaseClient** | 負責單一 Provider 的呼叫封裝、Schema 驗證與退避 | 攔截底層 HTTP 錯誤，直接介入全域 `heartbeatRegistry.markDegraded()` | **邊界穿透**：底層 Client 越級直接修改全域 Provider 狀態。 |
| **UnifiedErrorMapper** | 負責統一標準化各 Provider 錯誤代碼與語意 | 覆蓋率極低（死代碼 `HUB_INTERNAL_ERROR`，漏判 401/403/500/502/503） | **機制失效**：無法提供明確的 `isTransient` 或 `isAuth` 判定給上層決策。 |

---

## 六、故障與恢復生命週期追蹤 (Failure & Recovery Lifecycle)

依據現有程式碼，我們追蹤生命週期流程：

### 1. 單一模型故障
- **情境**：`gemini-2.5-flash` 因瞬時限流（429）失敗。
- **實際軌跡**：
  1. `GeminiClient` 拋出 `[HUB_RATE_LIMIT] Gemini API request failed...`
  2. `BaseClient` 捕獲，呼叫 `heartbeatRegistry.markDegraded('google')`，將 `google` provider 鎖定降級 5 分鐘。
  3. `BaseClient` 不理會 429 的冷卻指示，強制在第 2 次與第 3 次 attempt 再次發送請求，連續撞牆兩次。
  4. 3 次耗盡後，`CascadingExecutor` 捕獲，再次呼叫 `heartbeatRegistry.record('google', 0, false)`。
  5. `CascadingExecutor` 嘗試 fallback 到下一個候選模型。若下一個候選是同屬 `google` 的模型，因為 `getCandidates()` 未過濾健康，它會再次調度該模型！

### 2. 探測與恢復自癒（CLOSED → OPEN → HALF-OPEN → CLOSED）
- **CLOSED → OPEN**：
  - 只要 **1 次失敗**，立即轉入 `degraded`（等同於 OPEN）。
- **OPEN → HALF-OPEN**：
  - **不支援**。無 HALF-OPEN 狀態，無放行單一請求試探機制。
- **HALF-OPEN → CLOSED**：
  - 當 300 秒過去後，`isHealthy()` 直接返回 `true`。若此時有 10 個任務同時發起，10 個請求全部會同時打向該 Provider。若 Provider 尚未完全恢復，將瞬間引發雪崩。

### 3. 永久封鎖陷阱（Permanent Lockout Trap）
- 若系統配置了一個已失效的模型 ID（例如版本已過期的 `vertex/gemini-1.5-pro-002`）：
  - 每次任務分配到此模型時必然報錯。
  - 每次報錯均會重置 `stats.degradedUntil = Date.now() + 300000`。
  - 如果系統任務間隔小於 5 分鐘，**整個 `vertex-ai` provider 將永久陷於 `degraded` 狀態！**

---

## 七、狀態隔離性審計 (State Isolation Audit)

健康狀態與熔斷資訊是否會污染使用者任務狀態？

- **GlobalState**：
  - 審計確認：`heartbeatRegistry`、`quotaGuard` 與 `tokenMonitor` 均獨立運作於記憶體或 Singleton，**完全未寫入 `GlobalState`**。
  - 符合原則：任務狀態、OCC 版本控制與變更日誌保持純淨。
- **MemoryManager & SemanticCache**：
  - 審計確認：只有在 `cascading_executor.js:470-471` 任務執行成功且通過驗證閘門時，才會寫入 `memoryManager.saveMemory` 與 `semanticCache.set`。
  - 失敗資訊、降級記錄不會被當成正常語意快取儲存。

---

## 八、現有測試覆蓋矩陣 (Test Coverage Matrix)

| 測試檔案 | 實體驗證項目 | 實際斷言 (Assert) 內容 | 評級 |
| :--- | :--- | :--- | :--- |
| [`tests/test_circuit_breaker.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/tests/test_circuit_breaker.js) | Token 預算超額熔斷 | 斷言拋出錯誤包含 `[CircuitBreaker]`（第 65 行） | **表面無效**：完全未測試 Provider/Model 健康熔斷與恢復。 |
| [`tests/test_ecc_features.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/tests/test_ecc_features.js) (Test 2) | 單次任務費用預算熔斷 | 斷言設定 `MAX_TASK_BUDGET_USD` 後觸發錯誤 | **同上**：僅測試 Financial Budget，未測試 Health。 |
| [`tests/test_advanced_features.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/tests/test_advanced_features.js) (Test 4) | 心跳標記與狀態查詢 | 斷言 `record('deepseek', 0, false)` 後 `getStatus() === 'degraded'` | **表面測試**：僅驗證單純的 getter/setter，無時間演進、無狀態機轉換、無恢復自癒。 |
| [`tests/test_model_selection.js`](file:///c:/Users/etrny/.gemini/antigravity/scratch/model-hub-agent/tests/test_model_selection.js) | 真實 Google API 診斷 | 無斷言（僅 console.log） | **無法離線執行**：依賴即時外部 API Key 與網路。 |
| *(無對應測試)* | 真正的 CLOSED → OPEN 轉換 | 無測試 | **缺失 (Uncovered)** |
| *(無對應測試)* | Cooldown 時間超時與 HALF-OPEN | 無測試 | **缺失 (Uncovered)** |
| *(無對應測試)* | HALF-OPEN 試探成功恢復 CLOSED | 無測試 | **缺失 (Uncovered)** |
| *(無對應測試)* | HALF-OPEN 試探失敗重新 OPEN | 無測試 | **缺失 (Uncovered)** |
| *(無對應測試)* | 401 認證錯誤 Fast-Fail 不進重試 | 無測試 | **缺失 (Uncovered)** |
| *(無對應測試)* | Router getCandidates 排除降級節點 | 無測試 | **缺失 (Uncovered)** |

---

## 九、最小修改方案建議 (Minimal Change Proposal - MCP)

> **設計守則**：禁止新增不必要的包裝類別（如新增獨立的 `RouterHealthManager`）。應**就地強化既有模組**，收斂職責邊界。

### 1. 職責收斂與命名解歧
- 將 `cascading_executor.js` 中對 Token / USD 的防護明確命名為 `[BudgetGuard]`，不再濫用 `[CircuitBreaker]` 標籤。
- 將真正的節點健康與熔斷機制收斂在 `registry/heartbeat_registry.js`，對外提供精確的健康決策。

### 2. 狀態顆粒度下沉：從 Provider 到 (Provider, Model)
- 修改 `heartbeatRegistry` 的 Key 格式：
  - 支援 `modelKey = `${provider}:${modelId}``，並保留 provider-level 作為彙總層。
  - 單一 Model 故障不應直接摧毀同 Provider 的其他可用 Model。

### 3. 引進輕量三態狀態機 (CLOSED / OPEN / HALF-OPEN)
在 `heartbeat_registry.js` 建立規範：
```
  [CLOSED] --(連線/500/429 連續失敗 >= Threshold)--> [OPEN]
     ^                                                  |
     |                                             (Cooldown 結束)
     |                                                  v
     +------(單一 Canary 請求成功)--------------- [HALF-OPEN]
                                                        |
                                            (Canary 請求失敗)
                                                        |
                                                        v
                                                     [OPEN]
```
- **Failure Threshold**：預設 3 次連續失敗才轉為 OPEN（非目前的 1 次即死）。
- **Cooldown**：預設動態冷卻（如 30s ~ 60s，或讀取 429 之 `Retry-After`）。
- **HALF-OPEN**：允許 1 個試探請求進入。其餘併發請求暫時 fallback 至下一個 Candidate。

### 4. 彌合 Router 與 CascadingExecutor 的斷層
- 在 `router.getCandidates()` 中加入健康檢查與過濾邏輯：
  - 優先篩選 `isHealthy(candidate)` 的節點。
  - 當所有候選節點皆不可用時，提供明確的 Fail-Closed 或受控的 Degradation Fallback 機制，避免拋出 `null` 引用錯誤。

### 5. 強化 `UnifiedErrorMapper` 與 Fast-Fail 分類
- 補齊 401、403、500、502、503、404 的標準映射。
- 新增 `isFatal(mappedError)` 或 `shouldRetry(mappedError)` 方法：
  - 若為 `HUB_AUTH_ERROR` 或 `HUB_NOT_FOUND`：**立即 Fast-Fail**，不執行 3 次無謂重試，不將節點誤判為網路暫時降級。
  - 若為 `HUB_RATE_LIMIT`：觸發微退避或標記 OPEN，通知 Router 切換替代模型。

---

## 十、後續建議實作順序與測試驗證計劃

依據先測試後修改之紀律，後續步驟規劃如下：

1. **Step 4.2: 錯誤分類器與認證防護補強 (Error Mapper & Fast-Fail)**
   - 建立離線測試：驗證 401/403/429/500/404 之正確分類與 `shouldRetry` 判定。
   - 修正 `error_mapper.js` 與 `base_client.js`，杜絕 401 無效重試。
2. **Step 4.3: HeartbeatRegistry 三態狀態機升級 (CLOSED / OPEN / HALF-OPEN)**
   - 建立離線測試：使用 Mock Timer 驗證連續失敗閾值、OPEN 冷卻、HALF-OPEN 探測、成功自癒及失敗重熔。
   - 將狀態維度下沉至 Model 層級。
3. **Step 4.4: Router 候選清單健康對齊 (Router & CascadingExecutor Integration)**
   - 建立離線測試：驗證 `getCandidates()` 在有 OPEN 節點時能正確跳過並依序容錯。
   - 修正 `router.js` 與 `cascading_executor.js` 的呼叫契約。
4. **Step 4.5: 全套迴歸審查與離線測試整合格納**
   - 確保所有新測試納入 `run_tests.js` 的 `OFFLINE_SUITES`，達成 0 網路依賴與 100% 綠燈。

---

**鑑識結論**：本審計報告已完整收錄程式碼路徑、函式行號與架構斷層證據。依循專案規範，**鑑識完成後立即停止一切動作，等待架構審查與指示**。
