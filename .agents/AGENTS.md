# Antigravity 專案開發規範 (Project Agent Rules)

## 🚫 瀏覽器工具（browser_subagent）限制使用規則

為避免大體積網頁（例如 Notion, Slack, heavy SPAs）之 DOM 結構與截圖極速消耗用戶 Token 額度，請嚴格遵守以下呼叫規則：

1. **堅決不主動使用 `browser_subagent`**：
   - 嚴禁主動開啟或使用瀏覽器子代理進行一般性的網頁內容抓取。
2. **指定使用 `read_url_content`**：
   - 需要訪問外部 URL、API 文件、程式庫或部落格等靜態網頁時，**必須指定且僅使用 `read_url_content`** 工具。它會以極度輕量、乾淨的 Markdown 格式傳回內容，節省 95% 以上的 Token。
3. **引導用戶手動複製貼上**：
   - 若遇到 Notion 等重型 SPA、需要登入的網頁，或 `read_url_content` 無法解析的動態網頁，請優先引導用戶：*「請協助將該網頁的核心文字內容複製並直接貼在對話框中，或存為本地文字檔讓我讀取，以節省您的 Token 消耗。」*
4. **最後萬不得已的限制**：
   - 只有在進行極為複雜的網頁操作（如模擬點擊、表單送出）且用戶**明確下達指示**要求開啟瀏覽器的萬不得已情況下，才允許使用 `browser_subagent`。
