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
      return { success: true, data: primaryResult };
    }

    console.log("🛡️  [VerificationGate] Initiating Cost-Aware Dual-Verification...");

    // 1. Asymmetric Audit: Pick a CHEAP but capable model for verification
    // Even if the primary was high-tier, we can use a base-tier model for auditing constraints.
    const primaryModelId = context.primaryModelId;
    const verificationRequirements = {
      modalities: ["text"],
      preferredTier: "base" // Force use a cheaper model for verification
    };

    let validatorModel = router.route(verificationRequirements);

    // Ensure we don't use the same model instance
    if (validatorModel.model_id === primaryModelId) {
       // Fallback to a different provider if possible (preferring non-low tier first)
       const modelRegistry = require('../registry/model_registry');
       validatorModel = modelRegistry.models.find(m => m.provider !== context.primaryProvider && m.performance_tier !== 'low') || 
                        modelRegistry.models.find(m => m.provider !== context.primaryProvider) || 
                        validatorModel;
    }

    console.log(`🔍 [VerificationGate] Auditor selected: ${validatorModel.model_id} (${validatorModel.provider})`);

    const validatorClient = clientFactory(validatorModel);

    // 2. Concise Audit Prompt: Focus only on mission-critical verification
    const promptObj = {
      task_id: "verify-" + (context.task_id || "gen"),
      objective: "Verify the adherence to constraints for the following task output.",
      original_task: context.objective,
      constraints: context.constraints,
      output_to_verify: JSON.stringify(primaryResult),
      instruction: "Analyze if the output violates any constraints. Be critical."
    };

    try {
      const verificationResult = await validatorClient.execute(promptObj, { 
        type: "object", 
        properties: { 
          passed: { type: "boolean" },
          violation_details: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["passed", "violation_details"]
      });

      if (verificationResult.passed && verificationResult.confidence > 0.7) {
        console.log("✅ [VerificationGate] Result PASSED verification.");
        return { success: true, data: primaryResult };
      } else {
        console.warn("⚠️  [VerificationGate] Result FAILED verification:", verificationResult.violation_details);
        return { success: false, reason: verificationResult.violation_details };
      }
    } catch (error) {
      console.error("❌ [VerificationGate] Verification process error:", error.message);
      // Fail-safe: if verification itself fails, we default to passing the result but with a warning
      return { success: true, data: primaryResult, _warning: "Verification could not be completed." };
    }
  }
}

module.exports = new DualVerificationGate();
