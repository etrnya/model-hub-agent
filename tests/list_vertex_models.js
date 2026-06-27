const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function listModels() {
  console.log("Listing Vertex AI models for project...");
  
  const keyPath = path.join(__dirname, '../gcp-key.json');
  if (!fs.existsSync(keyPath)) {
    console.error("gcp-key.json not found!");
    return;
  }
  
  try {
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
    
    // Attempt to list publisher models
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models?pageSize=5`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    });
    
    console.log("Response Status:", response.status);
    const data = await response.json();
    console.log("Vertex AI Response:");
    console.log(JSON.stringify(data, null, 2));
    
  } catch (e) {
    console.error("Error listing Vertex AI models:", e);
  }
}

listModels();
