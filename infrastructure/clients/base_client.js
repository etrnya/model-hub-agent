const SchemaValidator = require('../adapters/schema_validator');
const ContextCompressor = require('../adapters/context_compressor');
const quotaGuard = require('../adapters/quota_guard');

/**
 * BaseClient
 * The core communication bridge for Agent OS.
 * Integrates validation, compression, and model-specific mapping.
 */
class BaseClient {
  constructor(config = {}) {
    this.modelCapability = config.modelCapability; // ModelCapabilitySchema
    this.promptMapping = config.promptMapping;     // PromptMapping for this model family
    
    this.validator = new SchemaValidator();
    this.compressor = new ContextCompressor();
    
    this.retryConfig = config.retry || { maxRetries: 3, initialDelay: 1000 };
  }

  /**
   * Prepares the state for the target model, applying compression if necessary.
   * @param {Object} globalState 
   */
  async prepareState(globalState) {
    return await this.compressor.compress(globalState, this.modelCapability);
  }

  /**
   * Executes a request to the model with integrated resilience logic.
   * @param {Object} globalState 
   * @param {Object} outputSchema - The expected JSON schema for the response.
   */
  async execute(globalState, outputSchema) {
    const heartbeatRegistry = require('../../registry/heartbeat_registry');

    // 1. Quota Check
    if (!quotaGuard.canProceed(this.modelCapability.provider, this.modelCapability.limits)) {
      throw new Error(`[BaseClient] Quota limit reached for ${this.modelCapability.provider}`);
    }

    const readyState = await this.prepareState(globalState);
    
    let lastError = null;
    for (let attempt = 1; attempt <= this.retryConfig.maxRetries; attempt++) {
      const startTime = Date.now();
      try {
        console.log(`[BaseClient] Attempt ${attempt} for model: ${this.modelCapability.model_id}`);
        
        const rawResponse = await this._callModelApi(readyState, outputSchema);
        const duration = Date.now() - startTime;
        
        // 1. Record Heartbeat (Success)
        heartbeatRegistry.record(this.modelCapability.provider, duration, true);

        // 2. Silent Fix & Validation
        const result = this.validator.parseAndValidate(rawResponse, outputSchema);
        
        if (result.success) {
          if (result.fixed) console.log("[BaseClient] Response successfully repaired via SilentFix.");
          
          // 3. Record Quota Usage (Estimate if not provided by provider)
          const estimatedTokens = (JSON.stringify(readyState).length + JSON.stringify(result.data).length) / 4;
          quotaGuard.recordUsage(this.modelCapability.provider, estimatedTokens);
          
          return result.data;
        }

        if (result.error) {
          console.warn(`[BaseClient] JSON Parse Error on attempt ${attempt}: ${result.error}`);
          console.warn(`[BaseClient] Raw Response: ${result.raw}`);
        } else {
          console.warn(`[BaseClient] Validation failed on attempt ${attempt}:`, result.errors);
        }
        lastError = new Error(result.error || "Validation Failed");
        
      } catch (error) {
        const duration = Date.now() - startTime;
        // Record Heartbeat (Failure)
        heartbeatRegistry.record(this.modelCapability.provider, duration, false);
        
        console.error(`[BaseClient] API Error on attempt ${attempt}:`, error.message);
        lastError = error;
      }

      // Exponential backoff
      if (attempt < this.retryConfig.maxRetries) {
        const delay = this.retryConfig.initialDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error(`[BaseClient] Failed after ${this.retryConfig.maxRetries} attempts. Last error: ${lastError.message}`);
  }

  /**
   * Abstract method to be implemented by specific provider clients (Gemini, DeepSeek, etc.)
   */
  async _callModelApi(payload) {
    throw new Error("_callModelApi must be implemented by subclass");
  }
}

module.exports = BaseClient;
