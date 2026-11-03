# GlobalState 系統保留欄位防護與資料契約鑑識報告 (P0-B Step 3.3)

## 一、鑑識背景與核心問題

在 Step 3.2 中，`shared/global_state.js` 成功以 JavaScript 語言級原生私有欄位 `#data` 實現了內部狀態的封裝，杜絕了外部直接讀寫或繞過公開 API 的路徑。
然而，經由架構審查深入鑑識，發現即使封閉了直接讀寫，**外部仍能透過合法的公開 API（`update()` 與 `merge()`）覆寫系統保留欄位與版本控制核心元資料**。

此缺陷破壞了樂觀並行控制（OCC）的核心不變條件（Invariants），可能導致版本號被外部 произвольно 竄改、稽核日誌被抹除、甚至引發原型鏈污染（Prototype Pollution）。

---

## 二、現有實作風險鑑識 (Seven Key Architectural Findings)

### 1. `update()` 允許覆寫 `version` 的漏洞路徑
目前 `update()` 的執行順序如下：
```javascript
update(newData, expectedVersion) {
  if (this.#data.version !== expectedVersion) return false;
  const clonedUpdates = deepClone(newData);
  Object.assign(this.#data, clonedUpdates); // 👈 漏洞點 1：將 newData 中的 version 寫入 #data
  this.#data.version += 1;                  // 👈 漏洞點 2：基於被竄改的 version 再 +1
  // ...
}
```
**鑑識場景**：
- 目前狀態 `version === 1`。
- 外部呼叫 `state.update({ user: "Alice", version: 999 }, 1)`。
- OCC 檢查 `this.#data.version === 1` 通過。
- `Object.assign` 將 `this.#data.version` 覆寫為 `999`。
- 最終 `this.#data.version += 1` 變為 `1000`。
- **後果**：外部呼叫端透過正常 API 即可隨意跨越或偽造版本號，完全破壞 OCC 版本單調遞增的保證。

### 2. `update()` 允許覆寫 `change_log` 的漏洞路徑
- 若外部傳入 `newData = { change_log: [] }`。
- `Object.assign` 直接將現有歷史稽核陣列替換為 `[]`。
- **後果**：系統稽核軌跡被靜默清空，喪失事後鑑識與故障溯源能力。

### 3. `merge()` 允許覆寫 `version` 的漏洞路徑
```javascript
merge(remoteData) {
  const clonedRemote = deepClone(remoteData);
  Object.assign(this.#data, clonedRemote); // 👈 漏洞點：遠端 version 直接覆寫本地 version
  this.#data.version += 1;
  // ...
}
```
**鑑識場景**：
- 發生併發衝突時觸發 `merge()`，若遠端資料包含 `version: 50`。
- 本地 version 直接被覆寫為 50，隨後 +1 變成 51，喪失本地版本單調遞增與衝突歷史的連續性。

### 4. `merge()` 允許覆寫 `change_log` 的漏洞路徑
- 若 `remoteData` 包含 `change_log`，本地歷史日誌直接被覆蓋，且僅追加一條合併註記，丟失本地所有先前的審計紀錄。

### 5. 系統保留欄位完整清單與原型污染風險
除了業務資料外，系統層級的控制欄位與 JavaScript 物件原型安全關鍵欄位包括：
- `version`：OCC 版本號（GlobalState 專屬控制）。
- `change_log`：變更與審計日誌（GlobalState 專屬控制）。
- `__proto__`：原型污染攻擊向量。
- `prototype`：原型污染攻擊向量。
- `constructor`：原型污染攻擊向量。

### 6. 現有呼叫端錯誤處理契約與向後相容性
經全專案搜尋所有呼叫端（`main.js`、`tests/test_fail_closed.js`、`tests/test_global_state.js`）：
- `main.js`（第 74-76 行）：
  ```javascript
  const updateSuccess = stateManager.update(finalData, currentSnapshot.version);
  if (updateSuccess) { ... }
  ```
- `update()` 的標準契約為：成功回傳 `true`，失敗回傳 `false` 並在終端輸出 `console.error`。
- 若 `update()` 傳入保留欄位或非純量型別，**明確拒絕並回傳 `false`（不靜默吞掉錯誤，輸出警告）**，最能兼顧向後相容性與 Fail-Closed 防禦原則。

### 7. `deepClone()` 的 Fallback 與非法型別處理
目前 `deepClone` 函式：
```javascript
function deepClone(obj) {
  if (obj === undefined || obj === null || typeof obj !== 'object') {
    return obj;
  }
  // ...
}
```
- 若傳入 `typeof obj !== 'object'`，函式（`typeof fn === 'function'`）會直接被放行並原樣回傳。
- Symbol 雖然 `typeof sym === 'symbol'` 亦被原樣回傳。
- 因此，不能將 `deepClone` 作為驗證工具，必須將**深拷貝**與**資料契約驗證（validateStateData）**明確拆分為職責單一的模組。

---

## 三、架構決策與資料契約規範 (Pure Structured Data Contract)

1. **保留欄位集合 (`RESERVED_FIELDS`)**：
   定義為 `const RESERVED_FIELDS = new Set(['version', 'change_log', '__proto__', 'constructor', 'prototype']);`
2. **驗證分離 (`validateStateData(data, { allowReserved = false })`)**：
   - 遞迴檢查物件與陣列。
   - 拒絕 `Function`、`Symbol`、`BigInt`、`undefined` 或自訂 Class 實例（除 Date/RegExp 外，純資料必須是 Plain Object 或 Array）。
   - 當 `allowReserved === false` 時（即 `update()` 情境），若資料頂層或巢狀包含 `RESERVED_FIELDS` 鍵名，驗證失敗並拒絕。
3. **`update()` 拒絕政策**：
   - 若 `newData` 未通過驗證或包含保留欄位，記錄明確錯誤 `console.error` 並回傳 `false`。
   - 狀態維持原子性，不修改 `#data` 任何內容，不遞增版本，不寫入 `change_log`。
4. **`merge()` 清洗與保護政策**：
   - 遠端衝突資料進行白名單/保留欄位剝離（Sanitization），去除 `version`、`change_log`、`__proto__`。
   - 僅將純業務資料合併至 `#data`。
   - 本地 `version` 嚴格依本地順序遞增 +1。
   - 本地 `change_log` 保留完整歷史，並追加一筆 `note: "Merged conflict resolution"` 的審計紀錄。

---

## 四、第二階段：確定性測試案例設計 (GS13 ~ GS18)

| 測試編號 | 測試情境 | 驗證斷言重點 |
| :--- | :--- | :--- |
| **GS13** | `update()` 傳入 `version` | 回傳 `false`；內部 `version` 保持不變；業務資料不被局部寫入；`change_log` 不增加。 |
| **GS14** | `update()` 傳入 `change_log` | 回傳 `false`；現有 `change_log` 完整保留；內部狀態不被污染。 |
| **GS15** | `merge()` 傳入遠端 `version` | 遠端 `version` 被隔離；本地 `version` 嚴格由原本地版本 +1，不可跳躍為遠端版本。 |
| **GS16** | `merge()` 傳入遠端 `change_log` | 本地既有歷史日誌完整保留，遠端日誌不可覆蓋本地；末端追加合併紀錄。 |
| **GS17** | `update()` 傳入非法型別 (`Function`, `Symbol`) | 拒絕非純結構化資料；回傳 `false`；內部狀態維持原狀。 |
| **GS18** | 一般業務欄位正常更新與原型防護 | 純業務欄位可正常更新，OCC 正常遞增；驗證 `__proto__` 鍵名遭嚴格阻擋。 |

---
**報告建立完成，準備進入第二階段：編寫 GS13～GS18 測試案例並進行紅燈驗證。**
