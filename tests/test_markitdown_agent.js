/**
 * test_markitdown_agent.js
 * End-to-end integration test demonstrating Agent OS ingesting a document via MarkItDown
 * and processing it with Vertex AI Gemini.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const markitdown = require('../infrastructure/adapters/markitdown_adapter');
const VertexAIClient = require('../infrastructure/clients/vertex_ai_client');
const modelRegistry = require('../registry/model_registry');

const testHtmlPath = path.resolve(__dirname, '../../markitdown/test.html');

// Simple rough token estimator (approx. 4 characters per token)
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

async function runEndToEnd() {
  console.log("====================================================");
  console.log("🚀 Agent OS & MarkItDown End-to-End Integration Demo");
  console.log("====================================================\n");

  try {
    // Phase 1: Convert document to markdown using MarkItDown
    console.log("📂 [Phase 1] Converting document via MarkItDown...");
    const rawHtml = fs.readFileSync(testHtmlPath, 'utf8');
    const htmlTokens = estimateTokens(rawHtml);

    const startTime = Date.now();
    const markdownContent = await markitdown.convert(testHtmlPath);
    const convertDuration = Date.now() - startTime;
    const markdownTokens = estimateTokens(markdownContent);

    console.log(`\n📄 Original HTML size: ${rawHtml.length} chars (~${htmlTokens} tokens)`);
    console.log(`📄 Converted Markdown size: ${markdownContent.length} chars (~${markdownTokens} tokens)`);
    console.log(`🗜️ Token savings: ${htmlTokens - markdownTokens} tokens (${((htmlTokens - markdownTokens) / htmlTokens * 100).toFixed(1)}% savings)`);
    console.log(`⏱️ Conversion time: ${convertDuration}ms\n`);

    // Phase 2: Ingest the markdown into Agent OS Vertex AI Gemini
    console.log("🧠 [Phase 2] Initializing Vertex AI Gemini Client...");
    const modelCapability = modelRegistry.getModelById("vertex/gemini-2.5-flash");
    if (!modelCapability) {
      throw new Error("Model vertex/gemini-2.5-flash not found in registry!");
    }

    const client = new VertexAIClient({
      modelCapability,
      retry: { maxRetries: 2, initialDelay: 500 }
    });

    const taskPayload = {
      objective: "Read the converted document below, extract the heading, list items, and tabular data into a structured format.",
      constraints: ["Output must exactly follow the JSON schema.", "List items should be extracted as an array.", "Table rows should be key-value pairs."],
      document_content: markdownContent
    };

    const outputSchema = {
      type: "object",
      properties: {
        document_title: { type: "string", description: "The main title or heading of the document." },
        bullets: { 
          type: "array", 
          items: { type: "string" }, 
          description: "List items extracted from the document." 
        },
        table_data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              header_a: { type: "string" },
              header_b: { type: "string" }
            },
            required: ["header_a", "header_b"]
          },
          description: "Rows of the table converted to structured objects."
        }
      },
      required: ["document_title", "bullets", "table_data"]
    };

    console.log("⚡ Sending request to Vertex AI Gemini...");
    const primaryStartTime = Date.now();
    const result = await client.execute(taskPayload, outputSchema);
    const execDuration = Date.now() - primaryStartTime;

    console.log(`\n✅ [Success] Agent OS Vertex AI returned structured data in ${execDuration}ms:`);
    console.log(JSON.stringify(result, null, 2));

    console.log("\n====================================================");
    console.log("🎉 Integration test completed successfully!");
    console.log("====================================================");

  } catch (error) {
    console.error("\n❌ End-to-End Demo Failed:", error.message);
    process.exit(1);
  }
}

runEndToEnd();
