const router = require('./router');
const heartbeatRegistry = require('../registry/heartbeat_registry');
const NvidiaNimClient = require('../infrastructure/clients/nvidia_nim_client');
const GeminiClient = require('../infrastructure/clients/gemini_client');
const DeepSeekClient = require('../infrastructure/clients/deepseek_client');
const VertexAIClient = require('../infrastructure/clients/vertex_ai_client');
const CodeGraphAdapter = require('../infrastructure/adapters/codegraph_adapter');
const codegraph = new CodeGraphAdapter();

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

    const memoryManager = require('../infrastructure/adapters/memory_manager');
    const threshold = parseFloat(process.env.MEMORY_SIMILARITY_THRESHOLD || '0.90');
    const cachedMemory = await memoryManager.searchMemory(context.objective, threshold);
    if (cachedMemory) {
      let isMemoryValid = true;
      // If similarity is not 100% exact (e.g. < 99.9%), run it through Verification Gate audit
      if (cachedMemory.score < 0.999) {
        const verificationGate = require('./verification_gate');
        const clientFactory = (cap) => {
          const Cls = this.clientMap[cap.provider];
          return new Cls({ modelCapability: cap });
        };
        isMemoryValid = await verificationGate.auditMemory(context.objective, cachedMemory.result, clientFactory);
      }

      if (isMemoryValid) {
        console.log(`✨ [CascadingExecutor] Bypassed LLM execution by retrieving cached result from Qdrant Memory.`);
        Object.assign(context, cachedMemory.result);
        const tokenMonitor = require('../observability/token_monitor');
        tokenMonitor.record('memory-cache', 0, 0, 0);
        return {
          success: true,
          data: cachedMemory.result,
          modelUsed: {
            model_id: 'qdrant-memory-cache',
            provider: 'memory-cache',
            tier: 'high',
            context_window: 1000000,
            max_output_tokens: 1000000,
            cost_per_1k_input: 0,
            cost_per_1k_output: 0
          },
          attempts: 1
        };
      } else {
        console.log(`🔄 [CascadingExecutor] Memory audit failed. Proceeding to normal LLM execution...`);
      }
    }

    // Inject CodeGraph context if not already present
    if (!context.code_context) {
      console.log(`\n🕸️  [CascadingExecutor] Running CodeGraph Pre-Query Context Injection...`);
      const codeCtx = await codegraph.extractAndBuildRelations(context.objective, context.constraints);
      if (codeCtx) {
        context.code_context = codeCtx;
        console.log(`✅ [CascadingExecutor] Injected ${codeCtx.length} chars of CodeGraph context.`);
      } else {
        console.log(`ℹ️  [CascadingExecutor] No CodeGraph context found for this task.`);
      }
    }
    
    // Run Context Integrity Gate (CIG) to evaluate context and prepare headers
    const cig = require('../infrastructure/adapters/context_integrity_gate');
    const processedContext = cig.process(context);
    
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
        let result = await client.execute(processedContext, schema);
        
        console.log(`✅ [CascadingExecutor] Raw execution success with ${capability.model_id}.`);

        // Run Verification Gate
        const verificationGate = require('./verification_gate');
        const clientFactory = (cap) => {
          const Cls = this.clientMap[cap.provider];
          return new Cls({ modelCapability: cap });
        };

        const auditContext = {
          ...context,
          primaryModelId: capability.model_id,
          primaryProvider: capability.provider,
          tier: preferredTier,
          tags: context.tags || []
        };

        let verification = await verificationGate.verify(result, auditContext, clientFactory);

        if (!verification.success) {
          console.log(`🔄 [CascadingExecutor] Verification failed for ${capability.model_id}. Initiating Self-Correction Loop...`);
          
          let correctionAttempts = 0;
          const maxCorrectionAttempts = 3;
          let correctionSuccess = false;
          let lastResult = result;
          let lastReason = verification.reason;

          while (correctionAttempts < maxCorrectionAttempts && !correctionSuccess) {
            correctionAttempts++;
            console.log(`🔄 [CascadingExecutor] Self-Correction Attempt ${correctionAttempts}/${maxCorrectionAttempts}...`);

            const correctionPayload = {
              ...processedContext,
              _correction_feedback: {
                previous_failed_output: lastResult,
                validation_error: lastReason,
                instruction: "Your previous output violated the constraints. Please carefully review the validation_error and correct the JSON output. Do NOT repeat the violation."
              }
            };

            try {
              const correctedResult = await client.execute(correctionPayload, schema);
              console.log(`✨ [CascadingExecutor] Self-corrected output generated. Re-verifying...`);
              
              const reVerification = await verificationGate.verify(correctedResult, auditContext, clientFactory);
              if (reVerification.success) {
                console.log(`🟢 [CascadingExecutor] Self-Correction Successful!`);
                result = correctedResult;
                correctionSuccess = true;
              } else {
                console.warn(`⚠️  [CascadingExecutor] Self-Correction failed validation: ${reVerification.reason}`);
                lastResult = correctedResult;
                lastReason = reVerification.reason;
              }
            } catch (err) {
              console.error(`❌ [CascadingExecutor] Error during self-correction: ${err.message}`);
              lastReason = err.message;
            }
          }

          if (!correctionSuccess) {
            throw new Error(`Model output did not pass verification after ${maxCorrectionAttempts} self-correction attempts. Reason: ${lastReason}`);
          }
        }

        console.log(`✅ [CascadingExecutor] Final success with ${capability.model_id}!`);
        
        // Record usage to monitor
        const tokenMonitor = require('../observability/token_monitor');
        const inputTokens = JSON.stringify(processedContext).length / 4;
        const outputTokens = JSON.stringify(result).length / 4;
        tokenMonitor.record(capability.provider, inputTokens, inputTokens, outputTokens);

        // Phase 3: Save successful task execution to memory
        await memoryManager.saveMemory(context.objective, result);

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
