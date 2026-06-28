# Antigravity Agent OS - API 申請與本地環境建置指南

這份指南將帶您一步步取得啟動 Agent OS 所需的各項 AI 資源。我們建議您先取得 NVIDIA 與 Gemini 的免費配額，這已足以涵蓋多數強大的應用場景。

---

## 1. 🟢 NVIDIA NIM (推薦首選：擁有最高等級的免費開源模型)
NVIDIA 提供了 Llama-3.1-405B 等目前最強大的開源模型 API，且提供非常慷慨的免費測試額度。

**申請步驟：**
1. 前往 **[NVIDIA Build 官網](https://build.nvidia.com/)**。
2. 點擊右上角的 **「Login」**，註冊或登入您的 NVIDIA 帳號（建議直接使用 Google 或 GitHub 登入）。
3. 登入後，在首頁的模型列表中，隨意點選一個強大模型（例如：`meta/llama-3.1-405b-instruct`）。
4. 進入模型頁面後，在右側會有一個 **「Get API Key」** 按鈕，點擊它。
5. 點擊 **「Generate Key」**，系統會生成一串以 `nvapi-` 開頭的長字串。
6. **重要**：立刻複製這串密碼，因為它只會顯示一次。
7. 將它貼到您的 `.env` 檔案中的 `NVIDIA_API_KEY=` 後方。

---

## 2. 🔵 Google Gemini (推薦：擁有最大 Context Window 的模型)
Google AI Studio 提供 Gemini 1.5 Pro / Flash 的 API，這兩個模型擁有驚人的 100 萬到 200 萬 Token 上下文視窗，非常適合一次塞入大量程式碼或文件。

**申請步驟：**
1. 前往 **[Google AI Studio](https://aistudio.google.com/)**。
2. 登入您的 Google 帳號。
3. 在左側選單中，點擊 **「Get API key」** (取得 API 金鑰)。
4. 點擊畫面上的 **「Create API key」** 按鈕。
5. 選擇在一個新的專案 (New Project) 中建立。
6. 系統會生成一串字串，點擊複製。
7. 將它貼到您的 `.env` 檔案中的 `GEMINI_API_KEY=` 後方。

---

## 3. 🟣 DeepSeek (推薦：高性價比的推理模型)
DeepSeek 是一家提供極具性價比且編碼能力極強模型的供應商，非常適合用來做為 Agent OS 中大量處理日常任務的「苦力模型」。

**申請步驟：**
1. 前往 **[DeepSeek 開放平台](https://platform.deepseek.com/)**。
2. 點擊右上角註冊或登入帳號。
3. 登入後，點選左側選單的 **「API Keys」**。
4. 點擊 **「Create new API key」**。
5. 為您的 Key 取個名字（例如：AgentOS），然後點擊建立。
6. 複製生成的字串。
7. 將它貼到您的 `.env` 檔案中的 `DEEPSEEK_API_KEY=` 後方。

---

## 4. 💻 本地基礎建設 Ollama (可選：最高隱私，斷網可用)
Ollama 不是一個雲端 API，而是一個安裝在您自己電腦上的軟體。當我們的 `DataSensitivityRouter` 偵測到機密數據時，會自動切換到這裡來確保資料不外洩。

**建置步驟：**
1. 前往 **[Ollama 官網](https://ollama.com/)** 點擊 Download 下載安裝檔。
2. 依照您的作業系統（Windows/Mac）完成安裝。
3. 打開您的終端機 (Terminal 或 PowerShell)。
4. 輸入並執行以下指令來下載並啟動一個輕量級的開源模型（大約需要 4.7 GB 空間）：
   ```bash
   ollama run llama3
   ```
5. 等待下載完成。當您看到可以輸入對話的提示符號 `>>>` 時，就代表本地 AI 引擎已經啟動了。
6. Ollama 預設會在背景運行，其本地 API 網址固定為 `http://localhost:11434`。
7. 在您的 `.env` 檔案中，確保有一行：`OLLAMA_BASE_URL=http://localhost:11434`。

---

## 5. 🟤 GCP Vertex AI (企業級後付款：徹底解決 AI Studio 429 欠費錯誤)
為了消耗 GCP 帳戶內的抵扣額與信用額度，且繞過 Google AI Studio 預付款餘額同步 Bug，本系統支持直接使用 GCP 服務帳戶 JSON 金鑰憑證呼叫 Vertex AI (Agent Platform) API。

**金鑰下載與設定步驟：**
1. 登入 **[Google Cloud 控制台](https://console.cloud.google.com/)**，確認選取您的專案（如 `gemini-api-ai-assistant`）。
2. 點擊左上角導覽選單 ☰，前往 **「IAM 和管理 (IAM & Admin)」** ➔ 點擊 **「服務帳戶 (Service Accounts)」**。
3. 點擊頂部 **「+ 建立服務帳戶」**，為其填寫名稱（例如 `vertex-express`）並點擊建立與繼續。
4. 建立完成後，在列表中點擊該服務帳戶的 Email 進入詳情頁。
5. 切換至頂部的 **「金鑰 (Keys)」** 標籤頁 ➔ 點擊 **「新增金鑰 (Add Key)」** ➔ 選擇 **「建立新金鑰 (Create new key)」**。
6. 在彈出視窗中選擇 **JSON** 格式，點擊 **「建立 (Create)」**，系統會自動下載一個 `.json` 憑證檔案至您的電腦中。
7. 將此 JSON 檔案命名為 **`gcp-key.json`**，妥善保存於專案根目錄或 `.gemini` 安全目錄。
8. **角色授權**：前往 **[IAM 頁面](https://console.cloud.google.com/iam-admin/iam)**，點擊您新增的服務帳戶旁的編輯按鈕，為其新增並授予 **「Agent Platform 使用者」**（即舊稱 `Vertex AI User`）權限。
9. **啟用 API**：前往 **[Agent Platform API 頁面](https://console.cloud.google.com/apis/library/aiplatform.googleapis.com)**，點擊 **「啟用 (Enable)」** 服務。
10. **環境變數設定**：在 `.env` 檔案中，設定您的金鑰絕對路徑：
    ```env
    GCP_KEY_PATH=c:\Users\etrny\.gemini\antigravity\scratch\model-hub-agent\gcp-key.json
    ```

---
> **💡 小提醒**：
> 這些 API 金鑰與服務帳戶憑證就如同您的信用卡，請妥善保管，**絕對不要將 `.env` 或 `gcp-key.json` 檔案上傳到公開的 GitHub 倉庫或傳送給他人**。

