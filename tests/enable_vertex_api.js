const fs = require('fs');
const path = require('path');

async function enableVertexAPI() {
  console.log("Enabling Vertex AI API (aiplatform.googleapis.com) via Service Usage API...");
  
  const keyPath = path.join(__dirname, '../gcp-key.json');
  if (!fs.existsSync(keyPath)) {
    console.error("gcp-key.json not found!");
    return;
  }
  
  try {
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const projectId = keyData.project_id;
    
    // 1. Get Access Token with required scopes (cloud-platform and service management)
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
      keyFile: keyPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse.token;
    
    // 2. Call Service Usage API to enable Vertex AI API
    const url = `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/aiplatform.googleapis.com:enable`;
    
    console.log("Sending Enable request to Service Usage API...");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    
    console.log("Response Status:", response.status);
    const data = await response.json();
    if (response.ok) {
      console.log("--- SUCCESS ---");
      console.log("Vertex AI API has been successfully queued/enabled!");
      console.log("Details:", JSON.stringify(data));
      console.log("----------------");
    } else {
      console.error("Failed to enable Vertex AI API:", JSON.stringify(data));
    }
  } catch (e) {
    console.error("Error enabling Vertex AI:", e);
  }
}

enableVertexAPI();
