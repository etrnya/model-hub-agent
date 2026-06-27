const VertexAIClient = require('../infrastructure/clients/vertex_ai_client');
const modelRegistry = require('../registry/model_registry');
require('dotenv').config();

async function testVertexClient() {
  console.log("=== Testing VertexAIClient ===");
  
  const modelCapability = modelRegistry.getModelById("vertex/gemini-2.5-flash");
  if (!modelCapability) {
    console.error("Model vertex/gemini-2.5-flash not found in registry!");
    return;
  }

  const client = new VertexAIClient({
    modelCapability,
    retry: { maxRetries: 2, initialDelay: 500 }
  });
  
  try {
    const payload = { input: "Hello from Agent OS Vertex Client! Tell me in 5 words that you are online." };
    const schema = {
      type: "object",
      properties: {
        reply: { type: "string", description: "Your online status in 5 words." }
      },
      required: ["reply"]
    };
    
    console.log("Sending request to Vertex AI...");
    const result = await client.execute(payload, schema);
    console.log("Success! Output:", result);
  } catch (e) {
    console.error("Test failed:", e.message);
  }
}

testVertexClient();
