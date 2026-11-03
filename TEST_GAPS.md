# Model Hub Agent 測試覆蓋缺口與風險鑑識報告 (TEST_GAPS.md)

> **報告目的**：深入剖析現存 27 個測試檔案中存在的「斷言缺失」、「錯誤吞噬（Silent False Positive）」以及「未覆蓋的核心模組盲區」，揭露系統表面綠燈背後的真實風險。

---

## ⚠️ 一、 假通過（Silent False Positive）重災區鑑識

在現有測試腳本中，最危險的並非「測試失敗」，而是**「測試明明失敗，但終端機回報 Exit Code 0，誤導 CI 與開發者以為功能正常」**。

### 1. `tests/test_silent_fix.js`：錯誤被 catch 吞噬
* **原始代碼**：
  ```javascript
  testCases.forEach(tc => {
    const fixed = validator.silentFix(tc.input);
    try {
      const parsed = JSON.parse(fixed);
      console.log("✅ Parse Success!");
    } catch (e) {
      console.log(`❌ Parse Failed: ${e.message}`); // ⚠️ 僅印出文字，未拋出，未設 exitCode
    }
  });
  ```
* **真實後果**：若 `silentFix` 的正則表達式改壞，導致 5 個測試案例全數 Parse Failed，進程依然回報 **Exit Code 0**！
* **修復方案**：改用 `assert.deepStrictEqual(JSON.parse(fixed), tc.expected)`。

### 2. `tests/test_self_correction_flow.js`：有 if/else 判斷卻無斷言
* **原始代碼**：
  ```javascript
  if (result.data.magic_word === "antigravity" && result.data.number_check === 999) {
    console.log("✅ TEST PASSED: Self-correction loop successfully corrected the output!");
  } else {
    console.error("❌ TEST FAILED: Output was not corrected."); // ⚠️ 沒有 process.exit(1)，沒有 assert
  }
  ```
* **真實後果**：當 Self-Correction 根本沒有修正成功時，只會在終端機留下一行紅字，隨後腳本正常結束（Exit Code 0），自動化部署管道將直接放行此有 Bug 的版本。
* **修復方案**：引入 `assert.strictEqual(result.data.magic_word, "antigravity")`。

### 3. `tests/test_guardrail.js` 與 `tests/test_compression.js`：純人眼觀察日誌
* **原始代碼**：
  ```javascript
  console.log("Safe:", result1.safe);
  console.log("Reason:", result1.reason);
  console.log("objective preserved:", !!comp2.objective);
  ```
* **真實後果**：完全沒有程式碼層級的預期比對，如果 `result1.safe` 變成 `true`（安全漏洞未被攔截），腳本照樣以 Exit 0 綠燈通過。
* **修復方案**：
  ```javascript
  assert.strictEqual(result1.safe, false, "Prompt injection must be blocked");
  assert.strictEqual(result1.reason, "Prompt Injection Detected");
  ```

---

## 🧩 二、 核心業務模組的「測試覆蓋盲區 (Coverage Gaps)」

經交叉比對 `services/` 與 `infrastructure/` 目錄，以下極為關鍵的核心模組**目前完全缺乏獨立的單元測試**：

### 1. `shared/global_state.js`：樂觀並行控制 (OCC) 衝突拒絕
* **風險現狀**：RPD 與架構宣稱具備 OCC 版本控制（防止多 Agent 寫入覆蓋）。但目前沒有任何單元測試去驗證：**「當輸入舊版本號時，`stateManager.update()` 是否真的嚴格回傳 false 並拒絕覆蓋？」**
* **建議補齊**：新增 `test_global_state_occ.js`，斷言並發衝突時拋錯或拒絕。

### 2. `services/router.js`：降級熔斷標記與權重調度
* **風險現狀**：Router 宣稱會依據 `heartbeatRegistry` 避開 `degraded` 模型。但目前沒有離線測試去驗證：**「當某模型被標記為 degraded 時，Router 是否 100% 不會再選中它？」**
* **建議補齊**：於單元測試中模擬 Heartbeat 記錄失敗，斷言 Router 自動將請求轉向次選端點。

### 3. `services/semantic_cache.js`：Deterministic Cache Key 生成
* **風險現狀**：此模組負責 100% LLM 繞過。若 Cache Key 對物件欄位順序敏感（例如 `{a:1, b:2}` vs `{b:2, a:1}`），會導致快取失效或命中錯誤。目前缺乏正規化單元測試。
* **建議補齊**：測試包含欄位打亂、空格差異時的 Cache Key 一致性。

---

## 🌊 三、 非同步未處理異常（Unhandled Rejection）風險

在多個測試檔案中，呼叫非同步主函式時未綁定拒絕監聽器：
```javascript
// 典型危險模式：
async function test() { ... }
test(); // ⚠️ 若內部拋錯且未被 catch，在 Node.js 中會觸發 UnhandledPromiseRejection
```
在 Node.js 16+ 中，未處理的 Promise 拒絕會導致進程崩潰，但若被某些工具外層封裝，則可能無法留下清晰的錯誤堆疊。
* **統一防範標準**：所有測試入口必須一律採用：
  ```javascript
  runTest().catch(err => {
    console.error("❌ Unhandled test rejection:", err);
    process.exit(1);
  });
  ```

---

## 📌 四、 總結與 P0-B 補齊策略

| 缺口類型 | 影響檔案數量 | 嚴重層級 | P0-B 處置方式 |
| :--- | :---: | :---: | :--- |
| **無 assert 僅靠觀察** | 12 檔 | 🔴 高危 | 第一階段優先重構 4 個純邏輯檔案 |
| **錯誤被 catch 吞噬** | 3 檔 | 🔴 高危 | 替換為標準 assert 斷言 |
| **核心模組無單元測試** | 3 個模組 (OCC/Router/Cache) | 🟡 中危 | 納入 P0-B 第三階段補齊清單 |
| **外部 API 混在常態測試** | 11 檔 | 🟡 中危 | 全數隔離至 `test:external` |
