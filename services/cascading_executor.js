const router = require('./router');
const heartbeatRegistry = require('../registry/heartbeat_registry');
const NvidiaNimClient = require('../infrastructure/clients/nvidia_nim_client');
const GeminiClient = require('../infrastructure/clients/gemini_client');
const DeepSeekClient = require('../infrastructure/clients/deepseek_client');
const VertexAIClient = require('../infrastructure/clients/vertex_ai_client');

/**
 * CascadingExecutor
 * Ensures task completion by automatically falling back to secondary models if the primary fails.
 */
class CascadingExecutor {
  constructor() {
    this.clientMap = {
      'nvidia-nim': NvidiaNimClient,
      'google': GeminiClient,
      'deepseek': DeepSeekClient,
      'vertex-ai': VertexAIClient
    };
  }

  /**
   * Executes a task with automatic cascading failover.
   * @param {Object} context - The task context/snapshot
   * @param {Object} schema - The output JSON schema
   * @param {Object} options - { preferredTier: 'high', maxRetries: 3 }
   */
  async execute(context, schema, options = {}) {
    const { preferredTier = 'high', maxRetries = 3 } = options;
    
    // 1. Get ordered candidates from router
    const candidates = router.getCandidates({
      modalities: ["text"],
      preferredTier: preferredTier
    });

    console.log(`\n🛡️  [CascadingExecutor] Plan initialized with ${candidates.length} candidates.`);

    let lastError = null;
    let attempts = 0;

    // 2. Loop through candidates until success
    for (const capability of candidates) {
      if (attempts >= maxRetries && attempts > 0) break;
      
      attempts++;
      console.log(`\n🚀 [Attempt ${attempts}] Trying ${capability.model_id} (${capability.provider})...`);

      try {
        const ClientClass = this.clientMap[capability.provider];
        if (!ClientClass) {
          throw new Error(`No client implemented for provider: ${capability.provider}`);
        }

        const client = new ClientClass({ 
          modelCapability: capability,
          promptMapping: { tool_call_template: "Return ONLY a valid JSON object strictly matching the schema." }
        });

        // 3. Run execution
        const result = await client.execute(context, schema);
        
        console.log(`✅ [CascadingExecutor] Success with ${capability.model_id}!`);
        
        // Record usage to monitor
        const tokenMonitor = require('../observability/token_monitor');
        const inputTokens = JSON.stringify(context).length / 4;
        const outputTokens = JSON.stringify(result).length / 4;
        tokenMonitor.record(capability.provider, inputTokens, inputTokens, outputTokens);

        return {
          success: true,
          data: result,
          modelUsed: capability,
          attempts: attempts
        };

      } catch (error) {
        lastError = error;
        console.error(`⚠️  [CascadingExecutor] Failed with ${capability.model_id}: ${error.message}`);
        
        // Mark as degraded in heartbeat to avoid immediate reuse by other components
        heartbeatRegistry.record(capability.provider, 0, false);
        
        console.log(`🔄 [CascadingExecutor] Cascading to next available model...`);
        // Continue to next candidate
      }
    }

    throw new Error(`[CascadingExecutor] All ${attempts} candidates failed. Last error: ${lastError.message}`);
  }
}

module.exports = new CascadingExecutor();
