# model-hub-agent 專案 - AI 助理開發與防坑指南

本文件定義了 `model-hub-agent` (Agent OS 核心) 專案特定的多模型調度、Qdrant 語意記憶與級聯容災防線規則。

---

## 🛠️ 1. 技術棧與架構

- **核心技術**：Node.js (TypeScript)。
- **語意記憶**：Qdrant 向量資料庫 (Docker 運行) + `text-embedding-004`。
- **級聯調度**：GCP Vertex AI (後付款、穩定備援) + Google AI Studio (首選低延遲)。
- **脈絡壓縮**：Context Integrity Gate (CIG) 門禁網關。

---

## 🚫 2. 專案專屬地雷 (AI 必須遵循的防線)

### A. Qdrant 向量維度對齊與連接池
* **地雷原因**：在執行 Task 語意比對時，若 Collection 建立的維度（如 `text-embedding-004` 預設為 768 維）與發送的 Query 向量維度不符，Qdrant 會拋出 Invalid Argument 錯誤並完全拒絕連線。
* **開發規則**：建立或重置 Qdrant Collection 時，必須嚴格鎖定向量長度，並在代碼端進行維度校驗。

### B. 級聯執行器 (Cascading Executor) 容災防線
* **地雷原因**：當 AI Studio 拋出 `429 Resource Exhausted` 額度用盡或計費異常時，若容災機制未被觸發，會直接導致上層的 Code Generator 任務中斷。
* **開發規則**：級聯執行器在攔截到 `429` 錯誤時，**必須在 200 毫秒內無縫自動切換**至 GCP Vertex AI 用戶端，並使用預先配置的 Service Account Key 完成請求，保障高可用性。

### C. Context Compression 門禁臨界值 (防止代碼渙散)
* **地雷原因**：為了節省 Token 費用，網關會對上下文進行有損壓縮。如果對重構任務的代碼文件進行了過度壓縮，LLM 會因丟失上下文而產生代碼幻覺（如刪除沒看見的函數）。
* **開發規則**：在涉及重構 (refactor) 或除錯 (debug) 任務時，CIG 門禁必須自動繞過壓縮，提供 100% 完整代碼庫上下文；僅在問答 (query/explain) 任務時啟用 Context 壓縮。
