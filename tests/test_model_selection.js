require('dotenv').config();

const models = [
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash-lite'
];

async function testModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  for (const model of models) {
    console.log(`Testing model: ${model}`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const requestBody = {
      contents: [{
        parts: [{ text: "Hello, say test" }]
      }]
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      const data = await res.json();
      console.log(`  Status: ${res.status}`);
      if (res.status === 200) {
        console.log(`  Success! Response: ${data.candidates[0].content.parts[0].text.trim()}`);
      } else {
        console.log(`  Failed: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }
  return null;
}

testModels();
