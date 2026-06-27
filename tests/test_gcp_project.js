const fs = require('fs');
const path = require('path');

function inspectKey() {
  const keyPath = path.join(__dirname, '../gcp-key.json');
  if (!fs.existsSync(keyPath)) {
    console.error("gcp-key.json not found!");
    return;
  }
  try {
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    console.log("=== GCP Service Account Key Details ===");
    console.log("Project ID:", keyData.project_id);
    console.log("Client Email:", keyData.client_email);
    console.log("Private Key ID:", keyData.private_key_id);
    console.log("=======================================");
  } catch (e) {
    console.error("Failed to parse gcp-key.json:", e.message);
  }
}

inspectKey();
