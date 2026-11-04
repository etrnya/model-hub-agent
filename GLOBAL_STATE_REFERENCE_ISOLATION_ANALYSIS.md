# P0-B Step 3.1: GlobalState 外部參照隔離與潛在漏洞鑑識報告 (GLOBAL_STATE_REFERENCE_ISOLATION_ANALYSIS.md)

本報告針對 `shared/global_state.js` 的參照共享漏洞進行深度鑑識，回答架構審查要求的六大核心問題，並提出不依賴脆弱序列化的原生防禦方案。

---

## 一、六大核心鑑識問題回覆

### 1. `constructor` 是否保留 `initialData` 的巢狀物件參照？
* **鑑識結論**：**是，100% 保留巢狀參照。**
* **代碼證據**：
  ```javascript
  constructor(initialData = {}) {
    this.data = {
      ...initialData,
      version: 1,
      change_log: []
    };
  }
  ```
  `...initialData` 僅為 JavaScript 物件展開運算（Shallow Spread）。第一層屬性雖然被拷貝，但其包含的任何物件（如 `initialData.user = { role: "admin" }`）或陣列（如 `initialData.tags = ["critical"]`），在 `this.data` 內部均指向與外部完全相同的記憶體位址。

### 2. `update()` 是否保留 `newData` 的巢狀物件或陣列參照？
* **鑑識結論**：**是，100% 保留外部參照。**
* **代碼證據**：
  ```javascript
  update(newData, expectedVersion) {
    if (this.data.version !== expectedVersion) { ... }
    Object.assign(this.data, newData);
    ...
  }
  ```
  `Object.assign` 同樣是淺層拷貝（Shallow Copy）。呼叫端傳入包含物件或陣列的 `newData` 時，`this.data` 內部直接保存了外部參照。

### 3. 是否會造成「版本不變、日誌不變，但資料已被偷偷改寫」的漏洞？
* **鑑識結論**：**是，這是嚴重的 OCC 繞過漏洞 (Bypass Update Vulnerability)。**
* **危害情境**：
  1. 呼叫端以 `const payload = { config: { timeout: 1000 } }` 初始化 `GlobalState`。
  2. 外部隨後執行 `payload.config.timeout = 99999`。
  3. `GlobalState` 內部的 `timeout` 立刻變為 `99999`。
  4. 但 `this.data.version` 仍然停留在 `1`，`change_log` 完全是一片空白！
  5. 其他依賴 OCC 的 Agent Session 無法察覺資料已變更，導致狀態失去可追溯性與可信度。

### 4. `getSnapshot()` 是否確實提供深層資料隔離？
* **鑑識結論**：**是，出口端已實作隔離。**
* **代碼證據**：
  ```javascript
  getSnapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }
  ```
  外部呼叫 `getSnapshot()` 時，取得的是序列化後再反序列化的全新深拷貝物件。修改快照不會回寫污染內部狀態（已由 GS6 驗證通過）。
* **缺陷**：這只保護了「讀取出口」，完全沒有防禦「初始化入口 (`constructor`)」與「更新入口 (`update()`, `merge()`)」。

### 5. GlobalState 的正式資料型別契約是否限定 JSON-compatible data？
* **鑑識結論**：**是。**
* **依據**：
  * 在 Model Hub Agent 架構中，`GlobalState` 儲存的是任務快照（`context.objective`、`constraints`、`tags`）與模型執行的結構化 JSON 輸出（`executionResult.data`）。
  * 各層間傳遞（包含 `SemanticCache`、`VerificationGate`、`CIG`）皆要求資料能轉為標準 JSON。
  * 業務契約不要求儲存函式、Symbol 或原生 DOM/C++ 物件。

### 6. 現有序列化方式對特定型別的限制，以及深拷貝方案選擇
* **`JSON.parse(JSON.stringify())` 的既有缺陷**：
  * `undefined` 欄位會被自動抹除。
  * `Date` 物件會降級為 ISO 字串，失去 Date 型別原型。
  * `BigInt` 與循環參照會拋出 `TypeError` 導致系統崩潰。
* **推薦升級方案：Node.js 18+ 原生 `structuredClone`**：
  * 當前系統運行於 Node.js `v24.15.0`，全域內建標準 `structuredClone`。
  * 原生支援深度物件、陣列、`Date`、`RegExp`、`Map`、`Set` 與 `undefined` 保留，且執行速度顯著優於 JSON 雙重轉換。
  * **防禦性封裝**：封裝一個安全的 `deepClone(obj)`，預設呼叫 `structuredClone(obj)`；若遇不合法物件時丟出明確的資料合規例外，絕不靜默破壞資料。

---

## 二、新測試案例規劃 (GS7 ~ GS10)

在 `tests/test_global_state.js` 中新增以下四個嚴格斷言案例：

1. **`[GS7]` constructor 外部修改 initialData 巢狀物件**：
   * 傳入包含巢狀物件的 `initialData`（如 `{ nested: { role: 'admin' } }`）。
   * 初始化後，外部直接修改 `initialData.nested.role = 'hacked'`。
   * 斷言 GlobalState 內部的 `role` 仍嚴格等於 `'admin'`，version 為 1，`change_log` 為空。
2. **`[GS8]` constructor 外部修改 initialData 陣列**：
   * 傳入包含陣列的 `initialData`（如 `{ tags: ['read', 'write'] }`）。
   * 初始化後，外部直接執行 `initialData.tags.push('unauthorized')` 或 `initialData.tags[0] = 'corrupted'`。
   * 斷言 GlobalState 內部的 `tags` 仍為 `['read', 'write']`。
3. **`[GS9]` update() 後外部修改 newData 巢狀物件**：
   * 呼叫 `state.update(newData, 1)`，其中 `newData` 包含 `{ security: { level: 5 } }`。
   * 更新完成後，外部直接修改 `newData.security.level = 0`。
   * 斷言 GlobalState 內部的 `security.level` 仍嚴格等於 `5`，version 為 2。
4. **`[GS10]` update() 後外部修改 newData 陣列**：
   * 呼叫 `state.update(newData, 1)`，其中 `newData` 包含 `{ workers: ['alpha', 'beta'] }`。
   * 更新完成後，外部執行 `newData.workers.push('rogue_worker')`。
   * 斷言 GlobalState 內部的 `workers` 陣列長度嚴格等於 2，內容不受外部污染。
