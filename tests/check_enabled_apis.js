const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function checkAPIs() {
  console.log("Checking enabled APIs for project...");
  
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
    
    // Check aiplatform.googleapis.com
    const url = `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/aiplatform.googleapis.com`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    });
    
    const data = await response.json();
    console.log("Service status response:");
    console.log(JSON.stringify(data, null, 2));
    
  } catch (e) {
    console.error("Error checking APIs:", e);
  }
}

checkAPIs();
