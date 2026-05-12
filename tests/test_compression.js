const ContextCompressor = require('./infrastructure/adapters/context_compressor');

async function testCompression() {
  const compressor = new ContextCompressor();
  
  const largeState = {
    task_id: "TASK-123",
    objective: "Build a interstellar navigation system.",
    constraints: ["Must be faster than light", "Must support 1000 crew members"],
    version: 5,
    change_log: [
      { version: 1, changedFields: ["init"] },
      { version: 2, changedFields: ["engine"] },
      { version: 3, changedFields: ["navigation"] },
      { version: 4, changedFields: ["crew_quarters"] },
      { version: 5, changedFields: ["life_support"] }
    ],
    debug_logs: "A".repeat(2000),
    internal_trace: { traceId: "xyz", hops: 10 },
    raw_provider_response: "DUMMY_RAW_JSON_DATA"
  };

  // Scenario 1: Standard Compression (Limit 500)
  console.log("=== Scenario 1: Standard Compression (Limit 500) ===");
  const comp1 = await compressor.compress(largeState, { context_window: 500 });
  console.log("Strategy Used:", comp1.compression_metadata.strategy);
  console.log("change_log length:", comp1.change_log ? comp1.change_log.length : "N/A");
  console.log("debug_logs exists:", !!comp1.debug_logs);
  console.log("internal_trace exists (should be false):", !!comp1.internal_trace);

  // Scenario 2: Hard Truncation (Limit 100)
  console.log("\n=== Scenario 2: Hard Truncation (Limit 100) ===");
  const comp2 = await compressor.compress(largeState, { context_window: 100 });
  console.log("Strategy Used:", comp2.compression_metadata.strategy);
  console.log("objective preserved:", !!comp2.objective);
  console.log("change_log exists (should be false):", !!comp2.change_log);
  console.log("Warning present:", !!comp2._warning);
}

testCompression();
