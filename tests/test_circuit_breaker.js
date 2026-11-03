/**
 * test_circuit_breaker.js
 * Verifies that the Budget Guard & Circuit Breaker mechanism trips and aborts execution
 * when the cumulative token count exceeds the configured budget limit.
 */
require('dotenv').config();
const assert = require('assert');
const cascadingExecutor = require('../services/cascading_executor');

// Mock client map for all providers to prevent unhandled provider errors
const mockClient = class MockClient {
  async execute(payload, schema) {
    return {
      javascript_code: "const x = 1;",
      explanation: "This is a dummy response designed to test the budget limits."
    };
  }
};

const mockClientMap = {
  'nvidia-nim': mockClient,
  'google': mockClient,
  'deepseek': mockClient,
  'vertex-ai': mockClient
};

async function runTest() {
  console.log("====================================================");
  console.log("🧪 Testing Budget Guard & Circuit Breaker...");
  console.log("====================================================");

  // Set exceptionally low budget to force tripping the breaker deterministically
  process.env.MAX_TASK_BUDGET_TOKENS = "100";

  // Override cascadingExecutor's clientMap with our mock clients
  cascadingExecutor.clientMap = mockClientMap;

  const mockContext = {
    objective: `Verify that the Circuit Breaker trips immediately when token count exceeds budget: ${Date.now()}`,
    constraints: [],
    tags: ["testing", "circuit-breaker"],
    code_context: "// Offline mock context"
  };

  const schema = {
    type: "object",
    properties: {
      javascript_code: { type: "string" },
      explanation: { type: "string" }
    },
    required: ["javascript_code", "explanation"]
  };

  let errorThrown = null;
  try {
    // Run execution with preferredTier standard to select deepseek
    await cascadingExecutor.execute(mockContext, schema, { preferredTier: 'standard' });
  } catch (err) {
    errorThrown = err;
    console.log(`✅ Intercepted expected error: ${err.message}`);
  }

  // Asserts
  assert(errorThrown !== null, "Test failed: Circuit Breaker should have thrown an error.");
  assert(errorThrown.message.includes('[CircuitBreaker]'), `Test failed: Expected error to contain '[CircuitBreaker]', got '${errorThrown.message}'`);

  console.log("\n====================================================");
  console.log("🟢 TEST PASSED: Circuit Breaker successfully aborted execution when budget was exceeded!");
  console.log("====================================================\n");
}

runTest().catch(err => {
  console.error("❌ Test Failed:", err);
  process.exit(1);
});
