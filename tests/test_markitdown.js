/**
 * test_markitdown.js
 * Verification test to confirm MarkItDown adapter integration and token savings.
 */
const fs = require('fs');
const path = require('path');
const markitdown = require('../infrastructure/adapters/markitdown_adapter');

const testHtmlPath = path.resolve(__dirname, '../../markitdown/test.html');

// Simple rough token estimator (approx. 4 characters per token)
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

async function runTest() {
  console.log("====================================================");
  console.log("🧪 Starting MarkItDown Integration & Token Saving Test");
  console.log("====================================================\n");

  try {
    // 1. Read raw HTML file
    if (!fs.existsSync(testHtmlPath)) {
      throw new Error(`Test file not found at ${testHtmlPath}. Please run step 1 first.`);
    }

    const rawHtml = fs.readFileSync(testHtmlPath, 'utf8');
    const htmlTokens = estimateTokens(rawHtml);
    
    console.log(`Original HTML Size: ${rawHtml.length} characters`);
    console.log(`Estimated Original Tokens: ${htmlTokens} tokens\n`);

    // 2. Perform Markdown conversion using adapter
    const startTime = Date.now();
    const markdownResult = await markitdown.convert(testHtmlPath);
    const duration = Date.now() - startTime;
    const markdownTokens = estimateTokens(markdownResult);

    console.log(`\nMarkdown Output:\n${'-'.repeat(40)}`);
    console.log(markdownResult.trim());
    console.log(`${'-'.repeat(40)}\n`);

    console.log(`Markdown Size: ${markdownResult.length} characters`);
    console.log(`Estimated Markdown Tokens: ${markdownTokens} tokens`);
    console.log(`Conversion time: ${duration}ms`);

    // 3. Calculate and display savings
    const tokenSaved = htmlTokens - markdownTokens;
    const savingsPercent = ((tokenSaved / htmlTokens) * 100).toFixed(2);

    console.log("\n====================================================");
    console.log("📊 TOKEN SAVINGS REPORT");
    console.log("====================================================");
    console.log(`Original HTML Tokens:  ${htmlTokens} tokens`);
    console.log(`Markdown Tokens:       ${markdownTokens} tokens`);
    console.log(`Tokens Saved:          ${tokenSaved} tokens`);
    console.log(`Token Saving Ratio:    ${savingsPercent}%`);
    console.log("====================================================\n");

    console.log("✅ MarkItDown Integration Verification: SUCCESS!");

  } catch (error) {
    console.error("❌ Test failed with error:", error.message);
    process.exit(1);
  }
}

runTest();
