require('dotenv').config();
const { dispatchTask } = require('../main');
const memoryManager = require('../infrastructure/adapters/memory_manager');

// Default general schema
const defaultSchema = {
  type: "object",
  properties: {
    analysis: { type: "string" },
    result: { type: "string" },
    recommendations: { type: "array", items: { type: "string" } }
  },
  required: ["analysis", "result"]
};

async function testFuzzyMemory() {
  console.log("==================================================");
  console.log("🧪 Testing Fuzzy Memory Audit & TTL...");
  console.log("==================================================");

  // 1. First task (exact seed)
  const task1 = {
    objective: "Find the specific lines in schema_validator.js where silentFix occurs, and list Direct callers.",
    constraints: ["Explain what silentFix does"],
    tags: ["memory_test"]
  };

  console.log("\n▶️  Running Task 1 (Initial seed)...");
  const res1 = await dispatchTask(task1, defaultSchema, "medium");
  console.log("✅ Task 1 Completed.");

  // 2. Second task (fuzzy matches - slightly different text but asks for same thing)
  const task2 = {
    objective: "Can you find the lines in schema_validator.js where silentFix is located, and direct callers?",
    constraints: ["Explain what silentFix does"],
    tags: ["memory_test"]
  };

  console.log("\n▶️  Running Task 2 (Fuzzy Match - should trigger audit)...");
  const res2 = await dispatchTask(task2, defaultSchema, "medium");
  console.log("✅ Task 2 Completed.");

  // 3. Third task (fuzzy match but asks for different files - should FAIL audit and fall back)
  const task3 = {
    objective: "Find the specific lines in base_client.js where request happens, and list Direct callers.",
    constraints: ["Explain what client request does"],
    tags: ["memory_test"]
  };

  console.log("\n▶️  Running Task 3 (Fuzzy Match with invalid target - should fail audit and rerun LLM)...");
  const res3 = await dispatchTask(task3, defaultSchema, "medium");
  console.log("✅ Task 3 Completed.");

  console.log("\n🎉 Fuzzy Memory Audit tests completed!");
  process.exit(0);
}

testFuzzyMemory().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
