# P0-B Step 3: GlobalState OCC (樂觀並行控制) 架構鑑識與分析報告 (GLOBAL_STATE_OCC_ANALYSIS.md)

本報告於建立 `tests/test_global_state.js` 之前，針對 `shared/global_state.js` 的現有原始程式碼與呼叫端契約進行深入鑑識，釐清其初始化方式、版本遞增、衝突契約與併發機制。

---

## 一、現有程式碼深度分析（七大鑑識問題）

### 1. GlobalState 的初始化方式
```javascript
constructor(initialData = {}) {
  this.data = {
    ...initialData,
    version: 1,
    change_log: []
  };
}
```
* **機制**：傳入初始資料物件 `initialData`（預設為 `{}`），以淺拷貝展開後，強制附加 `version: 1` 與 `change_log: []`。
* **特性**：任何實例的起點版本必定為 `1`。若傳入的 `initialData` 自帶舊版本欄位，也會被重置為 `1`。

### 2. Version 的遞增規則
```javascript
this.data.version += 1;
```
* **機制**：每一次合法的 `update` 成功時，版本號嚴格遞增 1（$V_{n+1} = V_n + 1$）。
* **備援合併**：若呼叫 `merge()`，版本號亦會遞增 1。
* **特性**：單調遞增，不跳號、不倒退。

### 3. update 的實際 API 與參數
```javascript
update(newData, expectedVersion)
```
* **參數**：
  * `newData` (Object)：欲寫入的新狀態鍵值對。
  * `expectedVersion` (Number)：提交者持有的預期版本號。
* **執行流程**：
  1. 比對 `this.data.version !== expectedVersion`。
  2. 若不符：輸出錯誤並中止。
  3. 若相符：`Object.assign(this.data, newData)` 寫入新資料。
  4. `this.data.version += 1` 遞增版本。
  5. 寫入 `change_log`（記錄 timestamp、新 version、changedFields）。
  6. 回傳 `true`。

### 4. 舊版本衝突時的回傳或例外契約
* **重要契約確認**：**舊版本衝突時不拋出例外 (Does NOT throw Error)**。
* **回傳值**：回傳布林值 **`false`**。
* **副作用隔離**：
  * `this.data.version` 保持不變。
  * 資料欄位不被覆寫。
  * `change_log` 不增加記錄。
* **結論**：測試斷言**不得**期待其 `assert.throws` 或 `rejects`，而必須斷言其回傳 `false`，並驗證內部狀態與版本不受污染。

### 5. 是否有 Mutex、Lock 或其他原子性保護
* **單行程機制**：純 JavaScript 同步函式執行，無外部 Redis 或分散式 Mutex。
* **同步保護**：在 Node.js 事件循環中，`update()` 為同步操作，保證單一函式調用期間無其他程式碼交錯執行；但在非同步 I/O 競賽時，以 `version === expectedVersion` 作為樂觀鎖守門員。

### 6. 狀態讀取是否有深拷貝或參照污染風險
```javascript
getSnapshot() {
  return JSON.parse(JSON.stringify(this.data));
}
```
* **參照隔離保證**：`getSnapshot()` 具備**嚴格深拷貝 (Deep Clone)**。
* **防護效果**：呼叫端取得 snapshot 後，即便任意修改其內部深層巢狀物件或陣列（如 `snapshot.tags.push(...)` 或 `snapshot.config.nested = 'hacked'`），**絕不會污染 GlobalState 內部的真正資料**。

### 7. 多個 Session 同時更新時，實際採用何種同步機制
* **樂觀並行控制 (OCC)**：
  * Session A 與 Session B 同時取得 `Snapshot (Version 1)`。
  * Session A 先執行完成，呼叫 `update(dataA, 1)` $\to$ 比對通過，狀態更新，版本晉升為 `2`，回傳 `true`。
  * Session B 後執行完成，呼叫 `update(dataB, 1)` $\to$ 比對失敗（當前已為 `2`，預期為 `1`），拒絕更新，回傳 `false`。
  * **結果**：成功防止「遺失更新 (Lost Update)」問題。

---

## 二、六大測試情境 (GS1 ~ GS6) 斷言設計規範

依據上述程式碼契約，設計 `tests/test_global_state.js` 測試案例：

1. **`[GS1] Normal Version Increment`**：
   * 驗證初始 Version 為 1。
   * 傳入合法 expectedVersion 更新後，斷言回傳 `true`、版本晉升為 2、資料正確寫入、`change_log` 記錄包含 `changedFields`。
2. **`[GS2] Stale Version Rejection (OCC Conflict)`**：
   * 狀態更新至 Version 2 後，刻意以過期的 Version 1 提交更新。
   * 斷言回傳 `false`。
   * 斷言版本仍鎖定在 2（不倒退、不晉升）。
   * 斷言新資料 100% 被保留，過期提交的資料 100% 被拒絕。
3. **`[GS3] Sequential Multiple Updates`**：
   * 連續執行 5 次合法更新（$V1 \to V2 \to V3 \to V4 \to V5 \to V6$）。
   * 斷言版本嚴格單調遞增，`change_log` 陣列長度嚴格等於 5，無跳號、無遺失。
4. **`[GS4] Concurrent Race Conflict Simulation (Promise Barrier)`**：
   * 建立 Promise Barrier，讓兩個非同步操作在微任務佇列完全同步解凍，同時以相同的初始 Version 1 競爭更新。
   * 斷言結果必定恰好**一個回傳 `true`、一個回傳 `false`**。
   * 斷言最終 Version 恰好為 2。
   * 斷言最終資料僅包含成功者的內容，未被失敗者覆蓋。
5. **`[GS5] State Consistency on Rejection & Fallback Merge`**：
   * 驗證在 OCC 拒絕後，系統狀態處於完全一致的穩定態。
   * 測試備援 `merge()` 策略：驗證當主動採用 merge 解決衝突時，遠端資料被合併且版本明確再遞增 1，並標記 conflict resolution 備註。
6. **`[GS6] Deep Clone Snapshot Mutation Isolation`**：
   * 取得 `getSnapshot()`。
   * 在快照中修改純量欄位、修改陣列、修改深度巢狀物件。
   * 再次取得新快照，斷言內部資料完全未受外部竄改影響（真正的資料隔離）。
