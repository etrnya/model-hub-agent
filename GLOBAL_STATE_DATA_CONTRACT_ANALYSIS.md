# GlobalState 資料契約與邊界完整閉合鑑識報告 (P0-B Step 3.5 Final)

## 一、鑑識背景與審查核心

在 P0-B Step 3.4 / 3.5 實作後，經架構裁決進一步深入程式碼層級審查，確立了 GlobalState 最終資料契約一致性規範：
1. **`merge()` 於前置驗證前使用 `remoteData[key]`，若資料包含 Accessor (Getter)，會導致 Getter 提前觸發執行，產生不可控副作用**（已於 Step 3.5 修正）。
2. **保留欄位（Reserved Fields）層級劃分不一致：`version` 與 `change_log` 被全域禁止，導致正常的業務巢狀物件（如 `metadata.version`）在 `update()` 中被誤殺**（已於 Step 3.5 修正）。
3. **`constructor(initialData = {})` 預設參數會使 `new GlobalState(undefined)` 被靜默替換為 `{}`，違反 Pure Structured Data 嚴格禁止 `undefined` 的契約**（已於 Step 3.5 修正）。
4. **`deepClone` 保留的 JSON fallback 與 `structuredClone` 在 DAG 共用參照上語意不一致（JSON 會裂解共用參照為兩份獨立物件）**（已於 Step 3.5 修正）。
5. **不可列舉屬性（Non-enumerable Property）在不同入口之處理不一致：`structuredClone()` 會忽略一般物件之 non-enumerable 自訂屬性，導致 `constructor` / `merge` 與 `update` 間資料保留行為不一致**（Step 3.5 Final 核心修正）。

---

## 二、關鍵架構解決方案

### 1. `merge()` Getter 執行阻斷與零副作用保證 (P0)
- `merge(remoteData)` 必須在**任何屬性讀取前**先以 `validateStateData(remoteData, { allowRootReserved: true, isRoot: true })` 進行全量安全鑑識。
- 驗證器檢查所有屬性的 Property Descriptor：若 `desc.get || desc.set` 存在，立即判定無效並回傳失敗，**絕不讀取屬性值**。
- 驗證完全通過後，萃取非保留欄位時使用 `desc.value`，確保全過程零 Getter 執行（`sideEffectRan === false`）。
- 驗證失敗時直接終止，保證 `#data`、`version` 與 `change_log` 零變更（100% 原子性）。

### 2. 系統保留欄位階層劃分：根層級專用 vs 巢狀業務資料允許 (P1)
- **根層級保留欄位 (`ROOT_RESERVED_FIELDS`)**：`version`、`change_log`。
  - 僅在 GlobalState 根層級由系統專屬控制。
  - `update()` 根層級禁止傳入（明確拒絕並回傳 `false`）。
  - `merge()` 根層級自動剝除，不得採用遠端版本或覆蓋本地日誌。
  - `constructor()` 根層級自動過濾並強制設為 `version: 1, change_log: []`。
- **巢狀層級業務欄位 (`Nested Fields`)**：
  - `metadata.version`、`config.change_log` 為合法業務資料，在 `constructor`、`update`、`merge` 所有入口皆正常放行。
- **全層級安全黑名單 (`GLOBAL_FORBIDDEN_FIELDS`)**：
  - `__proto__`、`prototype`、`constructor` 在**任何層級（根或巢狀）**一律嚴格拒絕。
  - `Function`、`Symbol`、`BigInt`、`undefined`、`NaN`、`Infinity`、Accessors 在**任何層級**一律嚴格拒絕。

### 3. `constructor` 引數語意一致性 (P2)
- 利用剩餘參數 `...args` 精準判斷呼叫意圖：
  - `new GlobalState()` (0 引數)：合法，使用預設空物件 `{}`。
  - `new GlobalState(undefined)`：顯式違反契約，拋出 `TypeError`。
  - `new GlobalState(null)`：顯式違反契約，拋出 `TypeError`。

### 4. 深度拷貝語意一致性：移除 JSON Fallback (P3)
- 由於專案執行環境為 Node.js 18+，全域環境皆具備原生 `structuredClone`。
- 移除 JSON fallback，確保 DAG 結構之共用記憶體參照在深拷貝後語意完全一致（`snap.a === snap.b`）。

### 5. 不可列舉屬性一致性契約 (Non-enumerable Property Contract)
- **現狀**：`Object.getOwnPropertyNames` 會抓取不可列舉屬性，但在 `update()` 走 `structuredClone` 時會丟棄它，導致 API 間不一致。
- **正式規則**：
  - **一般物件**：所有業務自有屬性必須為 **enumerable data property**。若 `!desc.enumerable`，直接拒絕，不靜默丟棄。
  - **Array**：`length` 為 JavaScript 語言規範之必要例外；所有索引元素必須為 **enumerable data property**。若索引元素為 `!desc.enumerable`，直接拒絕。
  - 所有入口（`constructor`、`update`、`merge`）遵循完全相同之可列舉性檢驗。

---

## 三、精準安全界線宣告 (Security Boundary Specification)

> [!IMPORTANT]
> **防護邊界聲明**：
> 對符合一般 JavaScript Plain Object / Array 結構的輸入，驗證器不會執行 Getter / Setter。
> JavaScript 引擎之 `Proxy` 物件可於元編程層級攔截 `getPrototypeOf`、`getOwnPropertyNames`、`getOwnPropertyDescriptor` 等基本內部操作（Traps），因此 **`Proxy` 物件不屬於受支援的 Pure Structured Data 輸入契約**。呼叫端嚴禁傳入 Proxy 實例。

---

## 四、確定性測試案例設計 (GS1 ~ GS34)

| 測試編號 | 測試情境 | 驗證斷言重點 |
| :--- | :--- | :--- |
| **GS1~GS26** | OCC、封裝、隔離、資料型別、存取器防護 | 全數保留並通過。 |
| **GS27** | `merge()` 傳入含 Getter 之 remoteData | 嚴格拒絕；`mergeGetterRan === false`；狀態與版本維持原子性。 |
| **GS28** | `constructor` 接受合法巢狀 `version` / `change_log` | `{ metadata: { version: 2, change_log: [...] } }` 正常放行，根 `version` 仍為 1。 |
| **GS29** | `update()` 接受合法巢狀 `version` / `change_log` | `{ schema: { version: "v3.1", change_log: [...] } }` 正常放行，根 `version` 遞增。 |
| **GS30** | `merge()` 接受合法巢狀 `version` / `change_log` | `{ remoteMeta: { version: 99 } }` 正常合併，根 `version` 依本地遞增 +1。 |
| **GS31** | 根層級保留欄位在三種入口之防護 | 根 `version` 於 update 被拒絕、於 merge 被剝除、於 constructor 被重置，系統元資料不被竄改。 |
| **GS32** | `constructor` 引數契約驗證 | `new GlobalState()` 成功；`new GlobalState(undefined)` 拋出 `TypeError`；`new GlobalState(null)` 拋出 `TypeError`。 |
| **GS33** | DAG 共用參照之 clone 參照完整性 | `snap.nodeA === snap.nodeB` 參照相等性在深拷貝後完美保全。 |
| **GS34** | 不可列舉屬性契約 (Non-enumerable Property) | `constructor`、`update`、`merge` 收到 non-enumerable 自有屬性一律拒絕；陣列 non-enumerable 索引元素拒絕；正常 enumerable 業務資料正常通過。 |

---
**報告更新完成，準備實施 GS34 測試與最小修正。**
