const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function testAllModels() {
  console.log("=== Testing All Vertex AI Models ===");
  
  const keyPath = path.join(__dirname, '../gcp-key.json');
  if (!fs.existsSync(keyPath)) {
    console.error("gcp-key.json not found!");
    return;
  }
  
  const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const projectId = keyData.project_id;
  
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = tokenResponse.token;
  
  const regions = ["us-central1", "asia-east1"];
  const models = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-1.5-flash-002",
    "gemini-1.5-pro-002",
    "gemini-1.5-flash-001",
    "gemini-1.5-pro-001"
  ];
  
  for (const region of regions) {
    for (const model of models) {
      console.log(`Testing region: ${region}, model: ${model}...`);
      const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
      
      const requestBody = {
        contents: [{
          role: "user",
          parts: [{ text: "Hello" }]
        }]
      };
      
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(requestBody)
        });
        
        if (response.ok) {
          console.log(`🟢 SUCCESS: ${region} / ${model}`);
          const data = await response.json();
          console.log("Response:", data.candidates[0].content.parts[0].text.trim().substring(0, 100));
          return; // Exit on first success to save tokens/time
        } else {
          const data = await response.json().catch(() => ({}));
          console.log(`❌ FAILED: ${region} / ${model} (Status: ${response.status}) - ${data.error?.message || "Unknown error"}`);
        }
      } catch (e) {
        console.log(`Fetch error for ${region}/${model}: ${e.message}`);
      }
    }
  }
}

testAllModels();
