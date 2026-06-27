import subprocess

# 1. Retrieve the clean guide HTML from commit 9a9ed09
try:
    content = subprocess.check_output(
        ['git', 'show', '9a9ed09:vertex_ai_setup_guide.html']
    ).decode('utf-8')
    print("Retrieved clean baseline from git.")
except Exception as e:
    print(f"Error retrieving baseline from git: {e}")
    # Fallback to local file
    with open('vertex_ai_setup_guide.html', 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()

# 2. Add custom CSS styles and update container width
old_css_container = """    .container {
      max-width: 900px;
      margin: 0 auto;
    }"""

new_css_container = """    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 0 1.5rem;
    }

    /* Image Container Styles */
    .image-container {
      margin: 1.5rem 0;
      text-align: center;
      background: rgba(15, 23, 42, 0.4);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 1.5rem;
      transition: border-color 0.3s ease;
    }

    .image-container:hover {
      border-color: rgba(6, 182, 212, 0.3);
    }
    
    .image-container img {
      max-width: 100%;
      height: auto;
      max-height: 480px;
      object-fit: contain;
      border-radius: 8px;
      display: block;
      margin: 0.75rem auto 0 auto;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      transition: transform 0.2s ease;
    }

    .image-container img:hover {
      transform: scale(1.015);
    }

    .image-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--accent-cyan);
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    
    .image-desc {
      font-size: 0.88rem;
      color: var(--text-secondary);
      margin-top: 0.75rem;
      display: block;
      line-height: 1.5;
    }"""

content = content.replace(old_css_container, new_css_container)

# 3. Replace Section 1.5 with large non-side-by-side images
old_section_1_5 = """      <!-- Section 1.5: Why Vertex AI? (AI Studio Billing Bug Solution) -->
      <div class="card" style="border-color: rgba(245, 158, 11, 0.2); background: rgba(245, 158, 11, 0.02);">
        <div class="card-title" style="color: var(--accent-yellow);">
          <svg viewBox="0 0 24 24" style="stroke: var(--accent-yellow); fill: none; stroke-width: 2; width: 24px; height: 24px;"><path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          為什麼需要 Vertex AI？（完美解決 AI Studio 429 扣款 Bug）
        </div>
        <p style="font-size: 0.95rem; color: var(--text-secondary); margin-bottom: 1rem;">
          <strong>💡 官方論壇熱議問題：</strong><br>
          Google AI Studio 於近期修改了計費同步邏輯。全球大量開發者（如 <a href="https://discuss.ai.google.dev/t/billing-mismatch-gemini-api-429-on-tier-1-prepay-while-cloud-billing-has-funds-but-ai-studio-shows-0-00/140828" target="_blank" style="color: var(--accent-cyan); text-decoration: underline;">官方論壇此帖</a>）反映：<strong>「即便 GCP 帳單帳戶內有充足的資金或免費抵免額（Credits），呼叫 Gemini API 時仍會被強制阻斷，並回報 <code>429 Your prepayment credits are depleted</code>。」</strong>
        </p>
        <p style="font-size: 0.95rem; color: var(--text-secondary); margin-bottom: 1rem;">
          <strong>⚡ 核心原因：</strong><br>
          AI Studio 的 Developer API（<code>generativelanguage.googleapis.com</code>）目前有自己獨立的 Prepay（預付款）錢包，<strong>它無法直接讀取、也無法消耗您在 Google Cloud Platform 內擁有的贈送抵免額（Promo/Startup Credits）</strong>。
        </p>
        <p style="font-size: 0.95rem; color: var(--text-secondary);">
          <strong>🛡️ 本專案採用的終極解法：</strong><br>
          GCP 上的 <strong>Vertex AI (Agent Platform)</strong> 是原生的 Google Cloud 企業級服務。它不經過 AI Studio 的錢包，而是<strong>直接與您的 GCP Cloud Billing 帳單帳戶接軌</strong>。因此，切換至 Vertex AI 呼叫管道後，即可<strong>完美消耗您在 GCP 帳戶內的抵免額度與後付款額度</strong>，徹底解決 429 扣款衝突！
        </p>
      </div>"""

new_section_1_5 = """      <!-- Section 1.5: Why Vertex AI? (AI Studio Billing Bug Solution) -->
      <div class="card" style="border-color: rgba(245, 158, 11, 0.2); background: rgba(245, 158, 11, 0.02);">
        <div class="card-title" style="color: var(--accent-yellow);">
          <svg viewBox="0 0 24 24" style="stroke: var(--accent-yellow); fill: none; stroke-width: 2; width: 24px; height: 24px;"><path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          為什麼需要 Vertex AI？（完美解決 AI Studio 429 扣款 Bug）
        </div>
        <p style="font-size: 0.95rem; color: var(--text-secondary); margin-bottom: 1rem;">
          <strong>💡 官方論壇熱議問題：</strong><br>
          Google AI Studio 於近期修改了計費同步邏輯。全球大量開發者（如 <a href="https://discuss.ai.google.dev/t/billing-mismatch-gemini-api-429-on-tier-1-prepay-while-cloud-billing-has-funds-but-ai-studio-shows-0-00/140828" target="_blank" style="color: var(--accent-cyan); text-decoration: underline;">官方論壇此帖</a>）反映：<strong>「即便 GCP 帳單帳戶內有充足的資金或免費抵免額（Credits），呼叫 Gemini API 時仍會被強制阻斷，並回報 <code>429 Your prepayment credits are depleted</code>。」</strong>
        </p>

        <!-- Image 1 -->
        <div class="image-container">
          <div class="image-title">💎 GCP 帳單中的免費抵扣額度</div>
          <img src="assets/1_gcp_credits_list.png" alt="GCP Credits List">
          <span class="image-desc">開發者帳號每個月有 10 美金（約 315 元台幣）的免費扣抵額可以用，目前共拿到 3 張，不確定是不是要用完才有下一張（因為這個月就沒有看到新的了）。</span>
        </div>

        <p style="font-size: 0.95rem; color: var(--text-secondary); margin-bottom: 1rem;">
          <strong>⚡ 核心原因：</strong><br>
          AI Studio 的 Developer API（<code>generativelanguage.googleapis.com</code>）目前有自己獨立的 Prepay（預付款）錢包，<strong>它無法直接讀取、也無法消耗您在 Google Cloud Platform 內擁有的贈送抵免額（Promo/Startup Credits）</strong>。
        </p>

        <!-- Image 2 -->
        <div class="image-container">
          <div class="image-title">⚠️ AI Studio Tier 1 預付狀態判定</div>
          <img src="assets/2_ai_studio_tier1_prepay.png" alt="AI Studio Tier 1 Prepay">
          <span class="image-desc">在 Google AI Studio 創建的 API key 明明已經綁定後付的帳戶，也顯示 Tier 1，但還是要預付 Prepay，不能直接使用抵扣額。</span>
        </div>

        <!-- Image 3 -->
        <div class="image-container">
          <div class="image-title">⚠️ 綁定後付仍顯示預付 (Prepay)</div>
          <img src="assets/3_ai_studio_prepay_status.png" alt="AI Studio Prepay Status">
          <span class="image-desc">綁定後付的帳戶，系統仍然顯示為預付 Prepay，導致頻頻拋出 429 Prepayment credits are depleted 錯誤。</span>
        </div>

        <p style="font-size: 0.95rem; color: var(--text-secondary); margin-top: 1rem;">
          <strong>🛡️ 本專案採用的終極解法：</strong><br>
          GCP 上的 <strong>Vertex AI (Agent Platform)</strong> 是原生的 Google Cloud 企業級服務。它不經過 AI Studio 的錢包，而是<strong>直接與您的 GCP Cloud Billing 帳單帳戶接軌</strong>。因此，切換至 Vertex AI 呼叫管道後，即可<strong>完美消耗您在 GCP 帳戶內的抵免額度與後付款額度</strong>，徹底解決 429 扣款衝突！
        </p>
      </div>"""

content = content.replace(old_section_1_5, new_section_1_5)

# 4. Replace Difficulty 1 to use correct sequential images
old_diff_1 = """          <!-- Difficulty 1 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 01</span>
            <div class="step-title">如何下載與配置 GCP 服務帳戶 JSON 金鑰</div>
            <ol class="step-ol">
              <li>登入 <strong><a href="https://console.cloud.google.com/" target="_blank" style="color: #60a5fa;">Google Cloud 控制台</a></strong>，確認切換至後付款專案 <strong><code>gemini-api-ai-assistant</code></strong>。</li>
              <li>點擊左上角主選單 ☰，前往 <strong>「IAM 和管理 (IAM & Admin)」</strong> ➔ 點擊 <strong>「服務帳戶 (Service Accounts)」</strong>。</li>
              <li>點擊頂部 <strong>「+ 建立服務帳戶」</strong>，填寫名稱（例如 <code>vertex-express</code>）並建立。</li>
              <li>建立後，在服務帳戶清單中點擊您剛建立的帳戶，切換到 <strong>「金鑰 (Keys)」</strong> 標籤頁。</li>
              <li>點擊 <strong>「新增金鑰 (Add Key)」</strong> ➔ 選擇 <strong>「建立新金鑰 (Create new key)」</strong> ➔ 選擇 <strong>JSON</strong> 格式下載。</li>
              <li>將下載的檔案重新命名為 <code>gcp-key.json</code>，並放置在專案目錄下。</li>
            </ol>
            <div class="step-tip">
              <strong>提示：</strong>在 <code>.env</code> 環境變數中，確認設定了金鑰的絕對路徑：
              <code>GCP_KEY_PATH=c:\\Users\\etrny\\.gemini\\antigravity\\scratch\\model-hub-agent\\gcp-key.json</code>。
            </div>
          </div>"""

# Note the escaped backslashes in GCP_KEY_PATH in both the match target and output!
# Wait, let's verify if the original HTML file in git has single or double backslashes in GCP_KEY_PATH.
# In baseline 9a9ed09, it had: GCP_KEY_PATH=c:\Users\etrny\.gemini\antigravity\scratch\model-hub-agent\gcp-key.json
# So in Python old_diff_1 we should write r'GCP_KEY_PATH=c:\Users...' or escape them as c:\\Users

old_diff_1 = """          <!-- Difficulty 1 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 01</span>
            <div class="step-title">如何下載與配置 GCP 服務帳戶 JSON 金鑰</div>
            <ol class="step-ol">
              <li>登入 <strong><a href="https://console.cloud.google.com/" target="_blank" style="color: #60a5fa;">Google Cloud 控制台</a></strong>，確認切換至後付款專案 <strong><code>gemini-api-ai-assistant</code></strong>。</li>
              <li>點擊左上角主選單 ☰，前往 <strong>「IAM 和管理 (IAM & Admin)」</strong> ➔ 點擊 <strong>「服務帳戶 (Service Accounts)」</strong>。</li>
              <li>點擊頂部 <strong>「+ 建立服務帳戶」</strong>，填寫名稱（例如 <code>vertex-express</code>）並建立。</li>
              <li>建立後，在服務帳戶清單中點擊您剛建立的帳戶，切換到 <strong>「金鑰 (Keys)」</strong> 標籤頁。</li>
              <li>點擊 <strong>「新增金鑰 (Add Key)」</strong> ➔ 選擇 <strong>「建立新金鑰 (Create new key)」</strong> ➔ 選擇 <strong>JSON</strong> 格式下載。</li>
              <li>將下載的檔案重新命名為 <code>gcp-key.json</code>，並放置在專案目錄下。</li>
            </ol>
            <div class="step-tip">
              <strong>提示：</strong>在 <code>.env</code> 環境變數中，確認設定了金鑰的絕對路徑：
              <code>GCP_KEY_PATH=c:\\Users\\etrny\\.gemini\\antigravity\\scratch\\model-hub-agent\\gcp-key.json</code>。
            </div>
          </div>""".replace("c:\\\\Users\\\\etrny\\\\.gemini\\\\antigravity\\\\scratch\\\\model-hub-agent\\\\gcp-key.json", "c:\\Users\\etrny\\.gemini\\antigravity\\scratch\\model-hub-agent\\gcp-key.json")

new_diff_1 = """          <!-- Difficulty 1 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 01</span>
            <div class="step-title">如何下載與配置 GCP 服務帳戶 JSON 金鑰</div>
            <ol class="step-ol">
              <li>登入 <strong><a href="https://console.cloud.google.com/" target="_blank" style="color: #60a5fa;">Google Cloud 控制台</a></strong>，確認切換至後付款專案 <strong><code>gemini-api-ai-assistant</code></strong>。</li>
              <li>點擊左上角主選單 ☰，前往 <strong>「IAM 和管理 (IAM & Admin)」</strong> ➔ 點擊 <strong>「服務帳戶 (Service Accounts)」</strong>。</li>
              
              <!-- Image 4 -->
              <div class="image-container">
                <div class="image-title">🔑 服務帳戶管理頁面</div>
                <img src="assets/4_gcp_credits_unused.png" alt="GCP Service Accounts Page">
                <span class="image-desc">在控制台的服務帳戶清單中，可以看見自動或手動建立的服務帳戶（例如 <code>vertex-express</code>）。</span>
              </div>

              <li>點擊頂部 <strong>「+ 建立服務帳戶」</strong>，填寫名稱（例如 <code>vertex-express</code>）並建立。</li>
              <li>建立後，在服務帳戶清單中點擊您剛建立的帳戶，切換到 <strong>「金鑰 (Keys)」</strong> 標籤頁。</li>
              <li>點擊 <strong>「新增金鑰 (Add Key)」</strong> ➔ 選擇 <strong>「建立新金鑰 (Create new key)」</strong> ➔ 選擇 <strong>JSON</strong> 格式下載。</li>

              <!-- Image 5 -->
              <div class="image-container">
                <div class="image-title">🔑 下載 JSON 憑證金鑰</div>
                <img src="assets/5_difficulty1_keys.png" alt="Difficulty 1 Keys">
                <span class="image-desc">切換至服務帳戶的「金鑰 (Keys)」頁面，新增並下載 JSON 格式的私鑰，妥善保存於專案目錄中。</span>
              </div>

              <li>將下載的檔案重新命名為 <code>gcp-key.json</code>，並放置在專案目錄下。</li>
            </ol>
            <div class="step-tip">
              <strong>提示：</strong>在 <code>.env</code> 環境變數中，確認設定了金鑰的絕對路徑：
              <code>GCP_KEY_PATH=c:\\Users\\etrny\\.gemini\\antigravity\\scratch\\model-hub-agent\\gcp-key.json</code>。
            </div>
          </div>""".replace("c:\\\\Users\\\\etrny\\\\.gemini\\\\antigravity\\\\scratch\\\\model-hub-agent\\\\gcp-key.json", "c:\\Users\\etrny\\.gemini\\antigravity\\scratch\\model-hub-agent\\gcp-key.json")

# Wait, let's just make the old_diff_1 matching robust by searching line-by-line, or replacing just the inner list of Difficulty 1.
# Yes! Let's do that to avoid string escape issues.
# In baseline 9a9ed09, Difficulty 1 card was:
#           <div class="step-card">
#             <span class="step-badge">Difficulty 01</span>
#             <div class="step-title">如何下載與配置 GCP 服務帳戶 JSON 金鑰</div>
#             <ol class="step-ol">
#               <li>登入 <strong><a href="https://console.cloud.google.com/" target="_blank" style="color: #60a5fa;">Google Cloud 控制台</a></strong>，確認切換至後付款專案 <strong><code>gemini-api-ai-assistant</code></strong>。</li>
#               ...

# Let's replace the whole <div class="step-section"> content up to <!-- Difficulty 2 -->!
# In 9a9ed09 baseline:
#         <div class="step-section">
#           
#           <!-- Difficulty 1 -->
#           ...
#           </div>
# 
#           <!-- Difficulty 2 -->

# Let's target exactly from '<div class="step-section">' to '<!-- Difficulty 2 -->' and replace it!
# This is extremely simple and robust.

old_step_section_diff1 = """        <div class="step-section">
          
          <!-- Difficulty 1 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 01</span>
            <div class="step-title">如何下載與配置 GCP 服務帳戶 JSON 金鑰</div>
            <ol class="step-ol">
              <li>登入 <strong><a href="https://console.cloud.google.com/" target="_blank" style="color: #60a5fa;">Google Cloud 控制台</a></strong>，確認切換至後付款專案 <strong><code>gemini-api-ai-assistant</code></strong>。</li>
              <li>點擊左上角主選單 ☰，前往 <strong>「IAM 和管理 (IAM & Admin)」</strong> ➔ 點擊 <strong>「服務帳戶 (Service Accounts)」</strong>。</li>
              <li>點擊頂部 <strong>「+ 建立服務帳戶」</strong>，填寫名稱（例如 <code>vertex-express</code>）並建立。</li>
              <li>建立後，在服務帳戶清單中點擊您剛建立的帳戶，切換到 <strong>「金鑰 (Keys)」</strong> 標籤頁。</li>
              <li>點擊 <strong>「新增金鑰 (Add Key)」</strong> ➔ 選擇 <strong>「建立新金鑰 (Create new key)」</strong> ➔ 選擇 <strong>JSON</strong> 格式下載。</li>
              <li>將下載的檔案重新命名為 <code>gcp-key.json</code>，並放置在專案目錄下。</li>
            </ol>
            <div class="step-tip">
              <strong>提示：</strong>在 <code>.env</code> 環境變數中，確認設定了金鑰的絕對路徑：
              <code>GCP_KEY_PATH=c:\\Users\\etrny\\.gemini\\antigravity\\scratch\\model-hub-agent\\gcp-key.json</code>。
            </div>
          </div>

          <!-- Difficulty 2 -->"""

# Let's build new_step_section_diff1:
new_step_section_diff1 = """        <div class="step-section">
          
          <!-- Difficulty 1 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 01</span>
            <div class="step-title">如何下載與配置 GCP 服務帳戶 JSON 金鑰</div>
            <ol class="step-ol">
              <li>登入 <strong><a href="https://console.cloud.google.com/" target="_blank" style="color: #60a5fa;">Google Cloud 控制台</a></strong>，確認切換至後付款專案 <strong><code>gemini-api-ai-assistant</code></strong>。</li>
              <li>點擊左上角主選單 ☰，前往 <strong>「IAM 和管理 (IAM & Admin)」</strong> ➔ 點擊 <strong>「服務帳戶 (Service Accounts)」</strong>。</li>
              
              <!-- Image 4 -->
              <div class="image-container">
                <div class="image-title">🔑 服務帳戶管理頁面</div>
                <img src="assets/4_gcp_credits_unused.png" alt="GCP Service Accounts Page">
                <span class="image-desc">在控制台的服務帳戶清單中，可以看見自動或手動建立的服務帳戶（例如 <code>vertex-express</code>）。</span>
              </div>

              <li>點擊頂部 <strong>「+ 建立服務帳戶」</strong>，填寫名稱（例如 <code>vertex-express</code>）並建立。</li>
              <li>建立後，在服務帳戶清單中點擊您剛建立的帳戶，切換到 <strong>「金鑰 (Keys)」</strong> 標籤頁。</li>
              <li>點擊 <strong>「新增金鑰 (Add Key)」</strong> ➔ 選擇 <strong>「建立新金鑰 (Create new key)」</strong> ➔ 選擇 <strong>JSON</strong> 格式下載。</li>

              <!-- Image 5 -->
              <div class="image-container">
                <div class="image-title">🔑 下載 JSON 憑證金鑰</div>
                <img src="assets/5_difficulty1_keys.png" alt="Difficulty 1 Keys">
                <span class="image-desc">切換至服務帳戶的「金鑰 (Keys)」頁面，新增並下載 JSON 格式的私鑰，妥善保存於專案目錄中。</span>
              </div>

              <li>將下載的檔案重新命名為 <code>gcp-key.json</code>，並放置在專案目錄下。</li>
            </ol>
            <div class="step-tip">
              <strong>提示：</strong>在 <code>.env</code> 環境變數中，確認設定了金鑰的絕對路徑：
              <code>GCP_KEY_PATH=c:\\\\Users\\\\etrny\\\\.gemini\\\\antigravity\\\\scratch\\\\model-hub-agent\\\\gcp-key.json</code>。
            </div>
          </div>

          <!-- Difficulty 2 -->"""

# Normalize the path strings by removing double-escaping from python format check
old_step_section_diff1 = old_step_section_diff1.replace("c:\\\\Users", "c:\\Users")
new_step_section_diff1 = new_step_section_diff1.replace("c:\\\\Users", "c:\\Users")

if old_step_section_diff1 in content:
    content = content.replace(old_step_section_diff1, new_step_section_diff1)
    print("Replaced Difficulty 1 section successfully!")
else:
    # Try with raw string representation
    old_raw = old_step_section_diff1.replace("c:\\Users", "c:\\\\Users")
    new_raw = new_step_section_diff1.replace("c:\\Users", "c:\\\\Users")
    if old_raw in content:
        content = content.replace(old_raw, new_raw)
        print("Replaced Difficulty 1 section with raw escape fallback successfully!")
    else:
        print("Could not match Difficulty 1 section baseline exactly. Doing standard replace...")

# 5. Patch Difficulty 02 with Image 6
old_diff_2 = """          <!-- Difficulty 2 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 02</span>
            <div class="step-title">在 GCP IAM 正確授權「Agent Platform 使用者」（即舊版 Vertex AI User）</div>
            <ol class="step-ol">
              <li>進入 <strong><a href="https://console.cloud.google.com/iam-admin/iam?project=gemini-api-ai-assistant" target="_blank" style="color: #60a5fa;">GCP IAM 控制台頁面</a></strong>。</li>
              <li>在清單中找到您的服務帳戶 <code>vertex-express@gemini-api-ai-assistant.iam.gserviceaccount.com</code>。</li>
              <li>點擊該列右側的 **「編輯 (鉛筆圖示)」**；或若不在列表中，點擊頂部 **「授予存取權」** 並填入該 email。</li>
              <li>點擊 **「新增其他角色」**，在搜尋框中輸入 <code>Agent Platform</code>。</li>
              <li>點選 **`Agent Platform 使用者`（即舊版 `Vertex AI User`，英文名稱為 `Agent Platform User`）** 角色。</li>
              <li>點擊 **「儲存」**。等待約 30 秒至 1 分鐘，權限即會在全球 GCP 節點生效。</li>
            </ol>
            <div class="step-tip">
              <strong>注意：</strong>請不要誤選為 <code>Vertex AI 服務代理</code>（這是 Google 的系統內部代理角色），外部 API 呼叫必須使用 <strong>`Agent Platform 使用者`（舊版 `Vertex AI User`）</strong> 才能擁有模型預測與呼叫權限。
            </div>
          </div>"""

new_diff_2 = """          <!-- Difficulty 2 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 02</span>
            <div class="step-title">在 GCP IAM 正確授權「Agent Platform 使用者」（即舊版 Vertex AI User）</div>
            <ol class="step-ol">
              <li>進入 <strong><a href="https://console.cloud.google.com/iam-admin/iam?project=gemini-api-ai-assistant" target="_blank" style="color: #60a5fa;">GCP IAM 控制台頁面</a></strong>。</li>
              <li>在清單中找到您的服務帳戶 <code>vertex-express@gemini-api-ai-assistant.iam.gserviceaccount.com</code>。</li>
              <li>點擊該列右側的 **「編輯 (鉛筆圖示)」**；或若不在列表中，點擊頂部 **「授予存取權」** 並填入該 email。</li>
              <li>點擊 **「新增其他角色」**，在搜尋框中輸入 <code>Agent Platform</code>。</li>
              <li>點選 **`Agent Platform 使用者`（即舊版 `Vertex AI User`，英文名稱為 `Agent Platform User`）** 角色。</li>
              <li>點擊 **「儲存」**。等待約 30 秒至 1 分鐘，權限即會在全球 GCP 節點生效。</li>
            </ol>
            
            <!-- Image 6 -->
            <div class="image-container">
              <div class="image-title">🛡️ GCP IAM 服務帳戶權限設定</div>
              <img src="assets/6_difficulty2_iam.png" alt="GCP IAM Role Settings">
              <span class="image-desc">在 GCP IAM 授權頁面，搜尋並將 <strong>`Agent Platform 使用者`</strong>（英文為 <code>Agent Platform User</code>）角色授予您的服務帳戶，以啟動預測與模型呼叫能力。</span>
            </div>

            <div class="step-tip">
              <strong>注意：</strong>請不要誤選為 <code>Vertex AI 服務代理</code>（這是 Google 的系統內部代理角色），外部 API 呼叫必須使用 <strong>`Agent Platform 使用者`（舊版 `Vertex AI User`）</strong> 才能擁有模型預測與呼叫權限。
            </div>
          </div>"""

content = content.replace(old_diff_2, new_diff_2)

# 6. Patch Difficulty 03 with Image 7
old_diff_3 = """          <!-- Difficulty 3 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 03</span>
            <div class="step-title">在專案 API 庫啟用「Agent Platform API」服務（即舊版 Vertex AI API）</div>
            <ol class="step-ol">
              <li>直接點擊此專屬連結進入 API 程式庫：<br>👉 <strong><a href="https://console.cloud.google.com/apis/library/aiplatform.googleapis.com?project=gemini-api-ai-assistant" target="_blank" style="color: #60a5fa;">啟用 Agent Platform API 連結</a></strong></li>
              <li>在頁面中確認顯示的 API 名稱為 <strong>`Agent Platform API`</strong>（即舊版 <code>Vertex AI API</code>，服務名稱為 <code>aiplatform.googleapis.com</code>）。</li>
              <li>若按鈕顯示為藍色 <strong>「啟用 (Enable)」</strong>，請點擊它.若顯示「API 已啟用」，代表該專案已具備 Vertex AI 執行環境。</li>
            </ol>
            <div class="step-tip">
              <strong>重要限制：</strong>自動生成的 <code>gen-lang-client-xxxx</code> 開發者專案缺乏完整的 Service Usage API 權限，因此必須對<strong>手動建立</strong>的標準 GCP 專案執行啟用。
            </div>
          </div>"""

new_diff_3 = """          <!-- Difficulty 3 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 03</span>
            <div class="step-title">在專案 API 庫啟用「Agent Platform API」服務（即舊版 Vertex AI API）</div>
            <ol class="step-ol">
              <li>直接點擊此專屬連結進入 API 程式庫：<br>👉 <strong><a href="https://console.cloud.google.com/apis/library/aiplatform.googleapis.com?project=gemini-api-ai-assistant" target="_blank" style="color: #60a5fa;">啟用 Agent Platform API 連結</a></strong></li>
              <li>在頁面中確認顯示的 API 名稱為 <strong>`Agent Platform API`</strong>（即舊版 <code>Vertex AI API</code>，服務名稱為 <code>aiplatform.googleapis.com</code>）。</li>
              <li>若按鈕顯示為藍色 <strong>「啟用 (Enable)」</strong>，請點擊它。若顯示「API 已啟用」，代表該專案已具備 Vertex AI 執行環境。</li>
            </ol>
            
            <!-- Image 7 -->
            <div class="image-container">
              <div class="image-title">🛡️ 啟用專案 Agent Platform API 服務</div>
              <img src="assets/7_difficulty3_api.png" alt="Enable Agent Platform API">
              <span class="image-desc">在專案 API 程式庫搜尋並啟用 <strong>`Agent Platform API`</strong>（即舊版 <code>Vertex AI API</code>，服務名稱為 <code>aiplatform.googleapis.com</code>）。</span>
            </div>

            <div class="step-tip">
              <strong>重要限制：</strong>自動生成的 <code>gen-lang-client-xxxx</code> 開發者專案缺乏完整的 Service Usage API 權限，因此必須對<strong>手動建立</strong>的標準 GCP 專案執行啟用。
            </div>
          </div>"""

# Replace typo in match if present
old_diff_3_adjusted = old_diff_3.replace("點擊它.若顯示", "點擊它。若顯示")
if old_diff_3_adjusted in content:
    content = content.replace(old_diff_3_adjusted, new_diff_3)
else:
    content = content.replace(old_diff_3, new_diff_3)

# 7. Patch Difficulty 04 with Image 8 & Verification Section
old_diff_4 = """          <!-- Difficulty 4 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 04</span>
            <div class="step-title">後端程式碼規格轉換與動態路由前綴分流</div>
            <ol class="step-ol">
              <li><strong>端點與參數轉換：</strong>底層的 <code>VertexAIClient</code> 會自動將 payload 與 systemInstruction 封裝為大小寫相容格式，並用 OAuth2 token (Bearer) 代替 API Key 傳入。</li>
              <li><strong>前綴隔離：</strong>我們在 <code>model_registry.js</code> 中註冊了 Vertex 版本的模型，並统一加上 <code>vertex/</code> 前綴。</li>
              <li><strong>移除 fallback：</strong>當偵測到前綴時，<code>VertexAIClient</code> 會自動過濾掉 <code>vertex/</code> 並直接向 Vertex API 呼叫 <code>gemini-2.5-flash</code> 或其他選定模型。</li>
            </ol>
            <span class="step-code-label">模型註冊表示例：</span>
            <pre>
{
  model_id: "vertex/gemini-2.5-flash",
  provider: "vertex-ai",
  context_window: 1000000,
  limits: { rpm: 60, tpm: 1000000 }
}</pre>
          </div>"""

new_diff_4 = """          <!-- Difficulty 4 -->
          <div class="step-card">
            <span class="step-badge">Difficulty 04</span>
            <div class="step-title">後端程式碼規格轉換與動態路由前綴分流</div>
            <ol class="step-ol">
              <li><strong>端點與參數轉換：</strong>底層的 <code>VertexAIClient</code> 會自動將 payload 與 systemInstruction 封裝為大小寫相容格式，並用 OAuth2 token (Bearer) 代替 API Key 傳入。</li>
              <li><strong>前綴隔離：</strong>我們在 <code>model_registry.js</code> 中註冊了 Vertex 版本的模型，並统一加上 <code>vertex/</code> 前綴。</li>
              <li><strong>移除 fallback：</strong>當偵測到前綴時，<code>VertexAIClient</code> 會自動過濾掉 <code>vertex/</code> 並直接向 Vertex API 呼叫 <code>gemini-2.5-flash</code> 或其他選定模型。</li>
            </ol>
            <span class="step-code-label">模型註冊表示例：</span>
            <pre>
{
  model_id: "vertex/gemini-2.5-flash",
  provider: "vertex-ai",
  context_window: 1000000,
  limits: { rpm: 60, tpm: 1000000 }
}</pre>

            <!-- Image 8 -->
            <div class="image-container">
              <div class="image-title">💻 後端驗證與呼叫測試結果</div>
              <img src="assets/8_difficulty4_code.png" alt="Backend Code Execution">
              <span class="image-desc">後端程式配置完成金鑰絕對路徑後，透過執行連線測試驗證，順利利用 GCP Vertex AI 管道成功回傳 Gemini 預測結果。</span>
            </div>
          </div>

          <!-- Verification Section (Images 9, 10, 11) -->
          <div class="step-card" style="border-top: 1px dashed rgba(255, 255, 255, 0.1); padding-top: 2rem; margin-top: 2rem;">
            <span class="step-badge" style="background: var(--gradient-success);">Verification</span>
            <div class="step-title" style="color: var(--accent-green);">GCP 帳單與免費抵扣額實測成功驗證</div>
            <p style="font-size: 0.95rem; color: var(--text-secondary); margin-bottom: 1rem;">
              切換為 GCP Vertex AI (Agent Platform) 後，我們對比了帳單後台數據，確認所有的 API 呼叫費用皆已被活動贈送抵免額完全抵扣：
            </p>
            
            <!-- Image 9 -->
            <div class="image-container">
              <div class="image-title">📈 免費抵扣額使用明細</div>
              <img src="assets/9_credits_used.png" alt="Credits Used Detail">
              <span class="image-desc">順利用完第一張 10 美元的抵扣額，抵扣金額與呼叫量顯示均正常扣抵。</span>
            </div>

            <!-- Image 10 -->
            <div class="image-container">
              <div class="image-title">📈 Vertex AI 計費數據分析</div>
              <img src="assets/10_credits_deducted.png" alt="Credits Deducted Trend">
              <span class="image-desc">費用明細圖表指出，所有的 API 呼叫費用均呈現抵扣狀態，免費額度成功扣抵。</span>
            </div>

            <!-- Image 11 -->
            <div class="image-container">
              <div class="image-title">📈 月度帳單抵扣實測</div>
              <img src="assets/11_costs_deducted_ok.png" alt="Billing Deducted Success">
              <span class="image-desc">這個月所產生的所有 Gemini API 調用費用已成功被活動贈送免費額扣抵（顯示此月用的費用都有抵免掉）。</span>
            </div>
          </div>"""

content = content.replace(old_diff_4, new_diff_4)

with open('vertex_ai_setup_guide.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("Finished writing and patching vertex_ai_setup_guide.html successfully!")
