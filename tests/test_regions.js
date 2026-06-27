const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function testRegions() {
  console.log("=== Testing Vertex AI Regions and Models ===");
  
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
  
  const testCases = [
    { region: "us-central1", model: "gemini-1.5-flash-002" },
    { region: "us-central1", model: "gemini-1.5-flash" },
    { region: "asia-east1", model: "gemini-1.5-flash" },
    { region: "europe-west1", model: "gemini-1.5-flash" }
  ];
  
  for (const tc of testCases) {
    console.log(`\n--- Testing region: ${tc.region}, model: ${tc.model} ---`);
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${tc.region}/publishers/google/models/${tc.model}:generateContent`;
    
    // Also try regional domain: e.g. asia-east1-aiplatform.googleapis.com
    const regionalUrl = `https://${tc.region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${tc.region}/publishers/google/models/${tc.model}:generateContent`;
    
    const requestBody = {
      contents: [{
        role: "user",
        parts: [{ text: "Hi" }]
      }]
    };
    
    try {
      const response = await fetch(regionalUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
      
      console.log(`Status code: ${response.status}`);
      const data = await response.json();
      if (response.ok) {
        console.log("Success! Response text:", data.candidates[0].content.parts[0].text.trim());
      } else {
        console.log("Error details:", JSON.stringify(data));
      }
    } catch (e) {
      console.error(`Fetch failed for ${tc.region}:`, e.message);
    }
  }
}

testRegions();
