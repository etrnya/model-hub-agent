# Antigravity 專案開發規範 (Project Agent Rules)

## 🚫 網址（URL）節流建議策略
為防止瀏覽器代理開啟大體積網頁（例如 Notion、GitHub、新聞部落格）時造成的 Token 噴發與截圖浪費，任何 AI 代理人在面對 URL 連結時，**必須**遵循以下流程：

1. **域名自動路由**：
   - 若為 `notion.so` 的網址，**必須優先使用 Notion MCP 工具**獲取結構化 Markdown。禁止使用任何瀏覽器。
   - 若為 `github.com` 的程式碼連結，**必須優先使用 GitHub MCP** 或直接轉換為 `raw.githubusercontent.com` 下載原始文字。
2. **預設輕量讀取**：
   - 處理一般部落格、技術文件、新聞或靜態網頁時，**必須預設使用 `read_url_content`**（提取乾淨的 Markdown 內容，節省 95% 以上 Token）。
3. **瀏覽器降級與確認機制**：
   - **禁止主動使用 `browser_subagent`**。
   - 僅在 `read_url_content` 被 Cloudflare 阻擋或該網頁完全為客戶端 JS 動態渲染、且嘗試其他方式失敗時，方可**向用戶說明原因並詢問是否啟用 `browser_subagent` 進行瀏覽**。

---

## 💾 本地讀取與搜尋節流策略
在讀取或搜尋本機專案目錄與檔案時，為避免龐大的目錄資訊與過長的文件耗盡 Context Token，請嚴格遵守以下操作：

1. **排除名單 (Exclude Patterns) 強制隔離**：
   - 在執行目錄遍歷（`list_dir`）或全文檢索（`grep_search`）時，**必須自動過濾並排除以下目錄**：
     `node_modules/`、`.git/`、`.venv/`、`dist/`、`build/`、`package-lock.json`、`yarn.lock`。
2. **「先 Grep 定位，後範圍 View」**：
   - **嚴禁**在未確認位置的情況下，直接讀取整個大於 500 行的程式碼檔案。
   - 應優先使用 `grep_search` 搜尋關鍵變數或函數，取得行號後，**僅使用 `view_file` 讀取對應的局部行號範圍（如 L20-L80）**。
3. **大檔案與二進制自動阻斷（MarkItDown 轉換）**：
   - 若檔案大於 200KB（如 HTML 文件、PDF 報告、DOCX 手冊、XLSX 表格），**嚴禁**直接當作文字讀取。
   - 必須引導或在背景自動調用本地的 `MarkItDown` 轉檔工具，將其轉換為簡潔的 Markdown 文字後，方可載入至上下文中讀取。對於圖片，轉換時調用一次 Vision 模組進行 OCR，後續直接重複利用文字，防範視覺 Token 重複扣除。

