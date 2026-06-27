require('dotenv').config();
const NvidiaNimClient = require('../infrastructure/clients/nvidia_nim_client');
const GeminiClient = require('../infrastructure/clients/gemini_client');

async function testRaw() {
  console.log("Testing raw API output...");
  
  const testCapability = {
    model_id: "meta/llama-3.1-70b-instruct",
    provider: "nvidia-nim",
    context_window: 128000,
    supported_modalities: ["text"],
    performance_tier: "high",
    limits: { rpm: 50, tpm: 100000 }
  };
  
  const nvidia = new NvidiaNimClient({ modelCapability: testCapability });
  const schema = {
    type: "object",
    properties: {
      greeting: { type: "string" },
      model_name: { type: "string" }
    },
    required: ["greeting", "model_name"]
  };
  
  try {
    const rawNvidia = await nvidia._callModelApi({ objective: "Say hello and give your model name" }, schema);
    console.log("--- RAW NVIDIA NIM RESPONSE ---");
    console.log(rawNvidia);
    console.log("-------------------------------");
  } catch (e) {
    console.error("Nvidia Raw API call failed:", e);
  }

  const geminiCapability = {
    model_id: "gemini-2.5-flash",
    provider: "google",
    context_window: 1000000,
    supported_modalities: ["text"],
    performance_tier: "medium",
    limits: { rpm: 15, tpm: 1000000 }
  };
  
  const gemini = new GeminiClient({ modelCapability: geminiCapability });
  try {
    const rawGemini = await gemini._callModelApi({ objective: "Say hello and give your model name" }, schema);
    console.log("--- RAW GEMINI RESPONSE ---");
    console.log(rawGemini);
    console.log("---------------------------");
  } catch (e) {
    console.error("Gemini Raw API call failed:", e);
  }
}

testRaw();
