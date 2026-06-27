require('dotenv').config();

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Missing GEMINI_API_KEY");
    return;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log("Status:", res.status);
    if (data.models) {
      console.log("Available Gemini Models:");
      data.models.forEach(m => {
        console.log(`- ${m.name} (${m.displayName})`);
      });
    } else {
      console.log("No models returned. Response:", JSON.stringify(data));
    }
  } catch (e) {
    console.error("Error listing models:", e);
  }
}

listModels();
