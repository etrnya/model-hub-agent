/**
 * test_self_correction_flow.js
 * Unit/Integration test for CascadingExecutor self-correction loop logic.
 * Mocks the clients to simulate a constraint violation and verify that correction feedback is sent.
 */
require('dotenv').config();
const cascadingExecutor = require('../services/cascading_executor');
const verificationGate = require('../services/verification_gate');

// Mock client map in cascadingExecutor
const originalClientMap = { ...cascadingExecutor.clientMap };

class MockClient {
  constructor(config) {
    this.modelCapability = config.modelCapability;
    this.attemptCount = 0;
  }

  async prepareState(globalState) {
    return globalState;
  }

  async execute(payload, schema) {
    this.attemptCount++;
    console.log(`[MockClient] Execute called. Attempt: ${this.attemptCount}`);
    
    // On the first attempt, simulate a constraint violation
    if (this.attemptCount === 1) {
      console.log(`[MockClient] Attempt 1: Returning incorrect output...`);
      return {
        magic_word: "wrong_word",
        number_check: 123
      };
    }

    // On subsequent attempts (correction), check if correction feedback is provided
    if (payload._correction_feedback) {
      console.log(`[MockClient] Attempt ${this.attemptCount}: Received correction feedback!`);
      console.log(`[MockClient] Feedback error: "${payload._correction_feedback.validation_error}"`);
      console.log(`[MockClient] Correcting output...`);
      return {
        magic_word: "antigravity",
        number_check: 999
      };
    }

    return {
      magic_word: "still_wrong",
      number_check: 456
    };
  }
}

class MockValidatorClient {
  constructor(config) {
    this.modelCapability = config.modelCapability;
  }

  async execute(payload, schema) {
    console.log(`[MockValidatorClient] Auditing output...`);
    const output = JSON.parse(payload.output_to_verify);
    
    if (output.magic_word === "antigravity" && output.number_check === 999) {
      console.log(`[MockValidatorClient] Audit passed!`);
      return {
        passed: true,
        violation_details: "",
        confidence: 0.95
      };
    } else {
      console.log(`[MockValidatorClient] Audit failed!`);
      return {
        passed: false,
        violation_details: "magic_word must be 'antigravity' and number_check must be 999.",
        confidence: 0.95
      };
    }
  }
}

// Override cascadingExecutor client map to use MockClient
cascadingExecutor.clientMap = {
  'nvidia-nim': MockClient,
  'google': MockClient,
  'deepseek': MockClient,
  'vertex-ai': MockClient
};

// Override verification_gate verify to use MockValidatorClient
const originalVerify = verificationGate.verify;
verificationGate.verify = async function(primaryResult, context, clientFactory) {
  // Use MockValidatorClient instead of routing to real model
  const validator = new MockValidatorClient({});
  
  // Format prompt object
  const promptObj = {
    original_task: context.objective,
    constraints: context.constraints,
    output_to_verify: JSON.stringify(primaryResult)
  };

  const verificationResult = await validator.execute(promptObj, null);

  if (verificationResult.passed) {
    return { success: true, data: primaryResult };
  } else {
    return { success: false, reason: verificationResult.violation_details };
  }
};

// Override verificationGate shouldVerify to force verification in tests
const originalShouldVerify = verificationGate.shouldVerify;
verificationGate.shouldVerify = () => true;

async function runTest() {
  console.log("====================================================");
  console.log("🧪 Testing CascadingExecutor Self-Correction Loop...");
  console.log("====================================================\n");

  const context = {
    objective: "Generate a JSON with magic_word 'antigravity' and number_check 999.",
    constraints: ["magic_word must be 'antigravity'", "number_check must be 999"],
    tags: ["critical"]
  };

  const schema = {
    type: "object",
    properties: {
      magic_word: { type: "string" },
      number_check: { type: "number" }
    },
    required: ["magic_word", "number_check"]
  };

  try {
    const result = await cascadingExecutor.execute(context, schema, { preferredTier: 'high' });
    console.log("\n====================================================");
    console.log("📊 TEST RESULT");
    console.log("====================================================");
    console.log("Execution Success:", result.success);
    console.log("Final Output:", JSON.stringify(result.data));
    console.log("Attempts Taken:", result.attempts);
    console.log("====================================================\n");
    
    if (result.data.magic_word === "antigravity" && result.data.number_check === 999) {
      console.log("✅ TEST PASSED: Self-correction loop successfully corrected the output!");
    } else {
      console.error("❌ TEST FAILED: Output was not corrected.");
    }
  } catch (error) {
    console.error("\n❌ TEST FAILED with error:", error.message);
  } finally {
    // Restore original functions/maps
    cascadingExecutor.clientMap = originalClientMap;
    verificationGate.verify = originalVerify;
    verificationGate.shouldVerify = originalShouldVerify;
  }
}

runTest();
