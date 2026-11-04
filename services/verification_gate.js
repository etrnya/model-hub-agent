const router = require('./router');
const modelRegistry = require('../registry/model_registry');

/**
 * DualVerificationGate
 * Provides secondary validation for high-stakes tasks using a different model family.
 * Optimizes cost by using asymmetric auditing and risk-based triggering.
 */
class DualVerificationGate {
  constructor() {
    // Define task categories that require mandatory cross-verification
    this.HIGH_RISK_TAGS = ['coding', 'financial', 'logic', 'security', 'critical'];
  }

  /**
   * Determines if verification is necessary based on task risk and tier.
   * @param {Object} task - The task object with tags and tier.
   */
  shouldVerify(task) {
    // 1. Force skip if explicitly requested in task
    if (task.skipVerification) return false;

    // 2. High-Risk identification
    const hasHighRiskTag = task.tags && this.HIGH_RISK_TAGS.some(tag => task.tags.includes(tag));
    
    // 3. Logic: Only verify High-Tier models or explicitly tagged high-risk tasks
    // This prevents wasting tokens on simple chat or low-tier model outputs.
    return hasHighRiskTag || task.tier === 'high';
  }

  /**
   * Performs cross-model verification.
   * @param {Object} primaryResult - Result from the first model.
   * @param {Object} context - The original task context.
   * @param {Function} clientFactory - A way to get a client instance for a model.
   */
  async verify(primaryResult, context, clientFactory) {
    if (!this.shouldVerify(context)) {
      console.log("⏩ [VerificationGate] Skipping dual-verification (Low Risk/Tier) to save tokens.");
      return { success: true, data: primaryResult, verified: false, policy: 'NOT_REQUIRED' };
    }

    console.log("🛡️  [VerificationGate] Initiating Cost-Aware Dual-Verification...");

    try {
      // 1. Asymmetric Audit: Pick a CHEAP but capable model for verification
      const primaryModelId = context.primaryModelId;
      const verificationRequirements = {
        modalities: ["text"],
        preferredTier: "base" // Force use a cheaper model for verification
      };

      let validatorModel = router.route(verificationRequirements);
      if (!validatorModel) {
        throw new Error("Router failed to find a suitable auditor model.");
      }

      // Ensure we don't use the same model instance
      if (validatorModel.model_id === primaryModelId) {
        const modelRegistry = require('../registry/model_registry');
        validatorModel = modelRegistry.models.find(m => m.provider !== context.primaryProvider && m.performance_tier !== 'low') || 
                         modelRegistry.models.find(m => m.provider !== context.primaryProvider) || 
                         validatorModel;
      }

      console.log(`🔍 [VerificationGate] Auditor selected: ${validatorModel.model_id} (${validatorModel.provider})`);

      const validatorClient = clientFactory(validatorModel);
      if (!validatorClient) {
        throw new Error("Client factory failed to instantiate auditor client.");
      }

      // 2. Concise Audit Prompt: Focus only on mission-critical verification
      const promptObj = {
        task_id: "verify-" + (context.task_id || "gen"),
        objective: "Verify if the original task output is correct, complete, and adheres to the original task requirements. Do NOT confuse the schema of the output to verify (which is the output of the original task) with your own output schema (passed, violation_details, confidence).",
        original_task: context.objective,
        constraints: context.constraints,
        original_task_expected_schema: context.schema ? JSON.stringify(context.schema) : "Any",
        output_to_verify: JSON.stringify(primaryResult),
        instruction: "Analyze if output_to_verify is a valid and correct response for original_task. Set 'passed' to true if it is correct. Set 'passed' to false and describe what is wrong in 'violation_details' if it is incorrect, incomplete, or violates constraints."
      };

      const verificationResult = await validatorClient.execute(promptObj, { 
        type: "object", 
        properties: { 
          passed: { type: "boolean" },
          violation_details: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["passed", "violation_details"]
      });

      if (verificationResult && verificationResult.passed && verificationResult.confidence > 0.7) {
        console.log("✅ [VerificationGate] Result PASSED verification.");
        return { success: true, data: primaryResult, verified: true };
      } else {
        const violationReason = verificationResult ? verificationResult.violation_details : "Audit rejected: empty verification response";
        console.warn("⚠️  [VerificationGate] Result FAILED verification:", violationReason);
        return { success: false, reason: violationReason, errorType: "VERIFICATION_CONTENT_FAIL" };
      }
    } catch (error) {
      console.error("❌ [VerificationGate] Verification process error:", error.message);
      // Fail-Closed: Infrastructure or network failure must reject delivery
      return { 
        success: false, 
        reason: `Verification infrastructure error: ${error.message}`,
        errorType: "VERIFICATION_INFRASTRUCTURE_ERROR" 
      };
    }
  }

  /**
   * Audits a retrieved memory output to ensure it remains valid and doesn't violate constraints.
   * @param {string} originalObjective - The new task's objective.
   * @param {Object} cachedResult - The cached JSON result.
   * @param {Function} clientFactory - A way to get a client instance for a model.
   * @returns {Promise<boolean>} - True if the memory is valid, false otherwise.
   */
  async auditMemory(originalObjective, cachedResult, clientFactory) {
    console.log("🛡️  [VerificationGate] Auditing retrieved vector memory...");

    try {
      // Pick a cheap model for auditing
      const verificationRequirements = {
        modalities: ["text"],
        preferredTier: "base"
      };
      const validatorModel = router.route(verificationRequirements);
      if (!validatorModel) {
        throw new Error("No auditor model available for memory validation.");
      }

      const validatorClient = clientFactory(validatorModel);
      if (!validatorClient) {
        throw new Error("Client factory failed to instantiate memory auditor client.");
      }

      const promptObj = {
        task_id: "verify-memory",
        objective: "Check if the cached result logically and structurally answers the new objective. Pay attention to specific variables, file names, and parameters.",
        new_objective: originalObjective,
        cached_result: JSON.stringify(cachedResult),
        instruction: "Determine if the cached result is a valid and correct answer to the new objective. If the new objective asks for different files, names, or logic, it must fail. Respond with true/false inside the valid field."
      };

      const auditResult = await validatorClient.execute(promptObj, {
        type: "object",
        properties: {
          valid: { type: "boolean" },
          reason: { type: "string" }
        },
        required: ["valid", "reason"]
      });

      if (auditResult && auditResult.valid) {
        console.log("✅ [VerificationGate] Vector memory PASSED audit.");
        return true;
      } else {
        console.warn("⚠️  [VerificationGate] Vector memory FAILED audit:", auditResult ? auditResult.reason : "Invalid audit response");
        return false;
      }
    } catch (e) {
      // Fail-Closed: Any exception during memory audit strictly rejects the cached memory
      console.error("❌ [VerificationGate] Memory audit failed, defaulting to reject (fail-closed):", e.message);
      return false;
    }
  }
}

module.exports = new DualVerificationGate();
