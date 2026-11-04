# P0-B Step 3.2: GlobalState 內部狀態封裝邊界與型別語意鑑識報告 (GLOBAL_STATE_ENCAPSULATION_AUDIT.md)

本報告針對 P0-B Step 3.1 審查所提出的兩大關鍵架構問題進行深入原始碼鑑識：
1. **內部狀態封裝邊界**：`this.data` 是否公開？外部能否直接透過屬性存取繞過 OCC？若改用 JavaScript Private Field (`#data`) 是否會破壞既有呼叫端？
2. **深拷貝型別語意**：精確定義 `structuredClone` 的型別相容性矩陣，明確界定 GlobalState 的資料契約與邊界。

---

## 一、內部狀態公開程度與全專案直接存取鑑識

### 1. 全專案存取位置逐行鑑識
透過對專案全量代碼進行 Ripgrep 搜尋（`grep .data`、`grep stateManager.`、`grep globalState.`），全面盤點對 `GlobalState` 實例的呼叫方式：

| 檔案路徑 | 行號 | 程式碼片段 | 存取形式 | 是否直接存取 `.data` |
| :--- | :---: | :--- | :---: | :---: |
| `main.js` | 44-45 | `const stateManager = new GlobalState(activePayload); const currentSnapshot = stateManager.getSnapshot();` | 受控 API (`getSnapshot`) | **否** |
| `main.js` | 74 | `const updateSuccess = stateManager.update(finalData, currentSnapshot.version);` | 受控 API (`update`) | **否** |
| `main.js` | 79 | `console.log(JSON.stringify(stateManager.getSnapshot(), null, 2));` | 受控 API (`getSnapshot`) | **否** |
| `tests/test_fail_closed.js` | 108 | `const initialSnapshot = stateManager.getSnapshot();` | 受控 API (`getSnapshot`) | **否** |
| `tests/test_fail_closed.js` | 127 | `stateManager.update({ leaked: true }, initialVersion);` | 受控 API (`update`) | **否** |
| `tests/test_fail_closed.js` | 133 | `assert.strictEqual(stateManager.getSnapshot().version, initialVersion);` | 受控 API (`getSnapshot`) | **否** |
| `tests/test_fail_closed.js` | 237, 255 | `stateManager.getSnapshot().version`, `stateManager.update(...)` | 受控 API | **否** |
| `tests/test_global_state.js` | 49, 58, 80 等 | 全部測試皆呼叫 `state.getSnapshot()`, `state.update(...)`, `state.merge(...)` | 受控 API | **否** |

**重要發現**：
在整個 Model Hub Agent 專案中，**沒有任何呼叫端曾經直接讀寫 `stateManager.data`**！
所有業務邏輯與既有測試，無一例外皆遵守呼叫受控 API（`getSnapshot()`、`update()`、`merge()`）。

---

### 2. 潛在風險分析：`this.data` 仍為公開屬性
雖然現有程式碼「自律地」沒有直接讀寫 `.data`，但在語言層面上：
```javascript
class GlobalState {
  constructor(initialData = {}) {
    const cloned = deepClone(initialData);
    this.data = { ...cloned, version: 1, change_log: [] };
  }
}
```
* **公開漏洞**：`this.data` 在物件導向層面屬於 **Public Property**。
* **潛在旁路 (Bypass Route)**：
  外部惡意程式或疏忽的協作者隨時可以執行：
  ```javascript
  // 繞過 update() 的旁路攻擊
  stateManager.data.version = 999;
  stateManager.data.critical_setting = "compromised";
  ```
  這完全不會觸發 `update()` 的版本比對，不會寫入 `change_log`，而後續其他模組呼叫 `stateManager.getSnapshot()` 時，取出的卻是已被旁路竄改的狀態！
* **結論**：單純在輸入/輸出做深拷貝（Step 3.1）只能防止參照外洩，**只要內部容器 `this.data` 仍是公開屬性，狀態封裝就尚未完全閉合**。

---

## 二、改用 Private Field (`#data`) 的影響評估

### 1. 私有化方案分析
若將 `shared/global_state.js` 中的 `this.data` 升級為 ECMAScript 原生私有欄位 `#data`：
```javascript
class GlobalState {
  #data;

  constructor(initialData = {}) {
    const cloned = deepClone(initialData);
    this.#data = { ...cloned, version: 1, change_log: [] };
  }
  
  // 內部函式全面以 this.#data 存取
  update(...) { ... this.#data.version ... }
  getSnapshot() { return deepClone(this.#data); }
  merge(...) { ... this.#data ... }

  // 提供唯讀 getter 方便快速讀取版本，無需拷貝整個快照
  get version() {
    return this.#data.version;
  }
}
```

### 2. 既有呼叫端衝擊評估
* **破壞性評估**：**零破壞 (Zero Breaking Change)**。
  * 鑑於全專案 0 處直接存取 `.data`，改為 `#data` 不會影響任何現行呼叫端。
  * 外部若嘗試存取 `state.data`，將直接取得 `undefined`；若試圖賦值 `state.data = ...`，僅是掛載無關的外部屬性，完全無法影響內部的 `#data`。
  * 外部若試圖在類別外使用 `#data`，JavaScript 引擎會在編譯階段直接拋出語法錯誤 `SyntaxError: Private field '#data' must be declared in an enclosing class`，形成語言級的硬性安全防護。

---

## 三、`structuredClone` 型別相容性與語意規範

為修正前份報告中「保留型別原型」之不精確敘述，特此依據 HTML / WHATWG Structured Clone Specification 建立正式相容性規範：

### 1. 完整支援且安全保留的型別 (Supported Types)
* **所有 JavaScript 基元型別**：`string`, `number`, `boolean`, `null`, `undefined`, `BigInt`（JSON.stringify 會在 BigInt 拋錯，但 structuredClone 完美支援）。
* **結構化資料容器**：純物件 `{}`、陣列 `[]`。
* **特定內建值物件**：
  * `Date`：精確保留為新的 `Date` 實例，時間戳記一致（JSON.stringify 會破壞原型降級為字串）。
  * `RegExp`：精確保留為新的 `RegExp` 實例，pattern 與 flags 完整保留。
* **二進位與集合型別**：`ArrayBuffer`, `Uint8Array`, `Map`, `Set`。
* **循環參照 (Circular References)**：自動解構並重構圖狀關聯，**絕不**發生堆疊溢位崩潰。

### 2. 不支援或具語意降級之型別 (Semantic Limitations & Unsupported Types)
* **函式與方法 (Functions / Methods)**：
  * **完全不支援**。若物件內包含任何箭頭函式或標準函式，會立即拋出 `DOMException [DataCloneError]: () => {} could not be cloned`。
* **符號 (Symbols)**：
  * **不支援**。Symbol 鍵或值無法被結構化複製，會拋出 `DataCloneError`。
* **自訂類別實例與原型鏈 (Custom Class Instances & Prototype Chain)**：
  * **原型鏈遺失 (Prototype Stripped)**：若傳入 `new MyCustomModel()`，`structuredClone` 僅會複製其本身的自有可枚舉屬性（own enumerable properties），並將其建構成純 `Object.prototype` 物件。**其自訂類別方法、Getter/Setter 與 `instanceof MyCustomModel` 關係會全部遺失**！
* **屬性描述符 (Property Descriptors)**：
  * 只複製值；`writable: false`、`enumerable: false` 或自訂 Getter 會被平鋪為普通純值屬性。

### 3. GlobalState 正式資料契約定義
> **[GlobalState 資料契約鐵律]**：
> `GlobalState` 僅接受並儲存 **純資料 (Pure Structured Data)**。
> 允許型別：純量值（字串、數字、布林、BigInt、null、undefined）、純物件 `{}`、陣列 `[]` 及 `Date`。
> **嚴禁將含有方法、函式或自訂類別原型之複雜物件存入 GlobalState**。

---

## 四、最小修改建議方案

雖然目前全專案無直接讀寫 `.data` 的代碼，但基於 Fail-Closed 與防禦性程式設計原則，消除 `this.data` 公開暴露是消除隱形旁路的最後一哩路。

### 建議之最小補強變更：
1. **將 `this.data` 升級為 `#data`**：
   * 在 `shared/global_state.js` 宣告 `#data`。
   * 將類別內部之 `this.data` 全數替換為 `this.#data`。
   * 提供唯讀 getter：`get version() { return this.#data.version; }`。
2. **在 `tests/test_global_state.js` 新增 GS11**：
   * 驗證外部執行 `state.data` 為 `undefined`，且外部賦值 `state.data = ...` 絕對無法改動內部狀態與版本。
3. **影響範圍**：
   * 僅限 `shared/global_state.js` 與 `tests/test_global_state.js`。
   * 完全相容既有 7 大套件。

---

## 五、結論與等待審查

目前鑑識確認：
1. 專案中現存呼叫端皆已百分之百遵循受控 API，並未直接破壞狀態。
2. `this.data` 確實具備潛在公開旁路，可透過最小改動（升級為 `#data`）徹底杜絕。
3. `structuredClone` 的資料契約已精確規範為 Pure Structured Data。

**本階段恪守指令，僅完成深度鑑識與方案規劃，未擅自修改業務代碼。請審查本鑑識報告與建議方案！**
