const router = require('./router');
const heartbeatRegistry = require('../registry/heartbeat_registry');
const NvidiaNimClient = require('../infrastructure/clients/nvidia_nim_client');
const GeminiClient = require('../infrastructure/clients/gemini_client');
const DeepSeekClient = require('../infrastructure/clients/deepseek_client');
const VertexAIClient = require('../infrastructure/clients/vertex_ai_client');
const CodeGraphAdapter = require('../infrastructure/adapters/codegraph_adapter');
const codegraph = new CodeGraphAdapter();

/**
 * Detects required modalities based on objective keywords and tags.
 * (Multimodal-Aware Routing)
 */
function detectRequiredModalities(context) {
  const modalities = ["text"];
  const objective = (context.objective || '').toLowerCase();
  const tags = context.tags || [];

  // If flagged as text-only or realtime, bypass multimodal check
  if (tags.includes('text-only') || tags.includes('realtime')) {
    return modalities;
  }

  // Check for Vision
  const hasVisionTag = tags.includes('vision') || tags.includes('image') || tags.includes('ocr');
  const hasVisionKeywords = objective.includes('.png') || objective.includes('.jpg') || objective.includes('.jpeg') || objective.includes('.webp') || objective.includes('.gif') || objective.includes('圖片') || objective.includes('圖像') || objective.includes('影像') || objective.includes('image') || objective.includes('picture');
  
  if (hasVisionTag || hasVisionKeywords) {
    modalities.push('vision');
  }

  // Check for Audio
  const hasAudioTag = tags.includes('audio') || tags.includes('voice');
  const hasAudioKeywords = objective.includes('.mp3') || objective.includes('.wav') || objective.includes('語音') || objective.includes('錄音') || objective.includes('聲音') || objective.includes('audio') || objective.includes('voice');
  
  if (hasAudioTag || hasAudioKeywords) {
    modalities.push('audio');
  }

  // Check for Tool Use
  if (tags.includes('tool_use') || tags.includes('tools')) {
    modalities.push('tool_use');
  }

  return modalities;
}

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
    const globalEmitter = require('../shared/global_emitter');
    globalEmitter.emit('task-status', { type: 'start', objective: context.objective });

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
        globalEmitter.emit('task-status', { type: 'success', objective: context.objective, modelUsed: 'qdrant-memory-cache' });
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

    // Inject Instincts (Continuous Learning)
    const instinctManager = require('./instinct_manager');
    await instinctManager.injectRelevantInstincts(context);

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
    
    // 1. Get ordered candidates from router (Multimodal-Aware Routing)
    const requiredModalities = detectRequiredModalities(context);
    console.log(`📡 [CascadingExecutor] Required modalities detected: [${requiredModalities.join(', ')}]`);

    // 關鍵決策動態提權 (Critical Decision Escalation)
    let activeTier = preferredTier;
    const objectiveText = (context.objective || '').toLowerCase();
    const tags = context.tags || [];
    
    // 大批次或純文字生成任務 (帶有 realtime 或 text-only 標籤) 免於提權，確保預算安全
    const isTextOnlyTask = tags.includes('realtime') || tags.includes('text-only');
    
    if (!isTextOnlyTask) {
      const criticalKeywords = ['delete', 'remove', 'rmdir', 'remove-item', '重構', '刪除', '清空', 'reconstruct', 'refactor', 'unlink'];
      const isCritical = criticalKeywords.some(keyword => objectiveText.includes(keyword));
      
      if (isCritical && activeTier !== 'high' && activeTier !== 'ultra') {
        console.log(`⚠️ [CascadingExecutor] Critical keywords detected in non-text-only task. Escalating preferredTier to 'high' for safety.`);
        activeTier = 'high';
      }
    }

    const candidates = router.getCandidates({
      modalities: requiredModalities,
      preferredTier: activeTier
    });

    console.log(`\n🛡️  [CascadingExecutor] Plan initialized with ${candidates.length} candidates.`);

    let lastError = null;
    let attempts = 0;
    let cumulativeTokens = 0;
    let cumulativeTaskCostUSD = 0;
    const maxBudgetTokens = parseInt(process.env.MAX_TASK_BUDGET_TOKENS || '150000', 10);
    const maxTaskBudgetUSD = parseFloat(process.env.MAX_TASK_BUDGET_USD || '0.05');
    const maxSessionBudgetUSD = parseFloat(process.env.MAX_SESSION_BUDGET_USD || '0.50');
    const tokenMonitor = require('../observability/token_monitor');
    const guardrail = require('./guardrail_manager');

    // 2. Parallel Racing Pipeline (Module 2)
    const isRacing = options.race || (context.tags && context.tags.includes('realtime'));
    
    if (isRacing && candidates.length >= 2) {
      console.log(`⚡ [CascadingExecutor] Parallel Racing enabled! Racing top 2 candidates: ${candidates[0].model_id} vs ${candidates[1].model_id}`);
      
      const runCandidate = async (capability) => {
        const ClientClass = this.clientMap[capability.provider];
        const client = new ClientClass({ 
          modelCapability: capability,
          promptMapping: { tool_call_template: "Return ONLY a valid JSON object strictly matching the schema." }
        });
        
        // 1. Scan Input
        const inputScan = await guardrail.scan(processedContext);
        if (!inputScan.safe) {
          throw new Error(`[AgentShield] Input blocked: ${inputScan.reason}`);
        }
        
        // 2. Execute
        const result = await client.execute(processedContext, schema);
        
        // 3. Scan Output
        const outputScan = await guardrail.scan(result);
        if (!outputScan.safe) {
          throw new Error(`[AgentShield] Output blocked: ${outputScan.reason}`);
        }
        
        // 4. Verify
        const auditContext = {
          ...context,
          primaryModelId: capability.model_id,
          primaryProvider: capability.provider,
          tier: preferredTier,
          tags: context.tags || []
        };
        const clientFactory = (cap) => new (this.clientMap[cap.provider])({ modelCapability: cap });
        const verification = await verificationGate.verify(result, auditContext, clientFactory);
        if (!verification.success) {
          throw new Error(`[Verification] Audit failed: ${verification.reason}`);
        }
        
        return { result, capability };
      };

      try {
        const winner = await Promise.any([
          runCandidate(candidates[0]),
          runCandidate(candidates[1])
        ]);
        
        console.log(`🏆 [CascadingExecutor] Parallel Racing winner: ${winner.capability.model_id}!`);
        
        // 記錄與儲存記憶
        const inputTokens = JSON.stringify(processedContext).length / 4;
        const outputTokens = JSON.stringify(winner.result).length / 4;
        tokenMonitor.record(winner.capability, inputTokens, inputTokens, outputTokens);
        await memoryManager.saveMemory(context.objective, winner.result);
        globalEmitter.emit('task-status', { type: 'success', objective: context.objective, modelUsed: winner.capability.model_id });
        
        return {
          success: true,
          data: winner.result,
          modelUsed: winner.capability,
          attempts: 1
        };
      } catch (err) {
        console.warn(`⚠️  [CascadingExecutor] Parallel Racing failed or all candidates rejected. Fallback to serial execution. Error: ${err.message}`);
      }
    }

    // 3. Loop through candidates until success (Serial Fallback)
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

        // Run AgentShield Input Scan
        const inputScan = await guardrail.scan(processedContext);
        if (!inputScan.safe) {
          throw new Error(`[AgentShield] Input blocked: ${inputScan.reason}`);
        }

        // 3. Run execution
        let result = await client.execute(processedContext, schema);
        
        // Run AgentShield Output Scan
        const outputScan = await guardrail.scan(result);
        if (!outputScan.safe) {
          throw new Error(`[AgentShield] Output blocked: ${outputScan.reason}`);
        }

        console.log(`✅ [CascadingExecutor] Raw execution success with ${capability.model_id}.`);

        // Track cumulative tokens and cost for budget guard
        const primaryInputTokens = JSON.stringify(processedContext).length / 4;
        const primaryOutputTokens = JSON.stringify(result).length / 4;
        cumulativeTokens += (primaryInputTokens + primaryOutputTokens);
        
        const inputCost = (primaryInputTokens / 1000) * (capability.input_cost_per_1k || 0);
        const outputCost = (primaryOutputTokens / 1000) * (capability.output_cost_per_1k || 0);
        const currentCostUSD = inputCost + outputCost;
        cumulativeTaskCostUSD += currentCostUSD;
        const sessionCostUSD = tokenMonitor.totalSessionCost + currentCostUSD;

        console.log(`📊 [BudgetGuard] Tokens: ${cumulativeTokens}/${maxBudgetTokens}, TaskCost: $${cumulativeTaskCostUSD.toFixed(6)}/$${maxTaskBudgetUSD}, SessionCost: $${sessionCostUSD.toFixed(6)}/$${maxSessionBudgetUSD}`);

        if (cumulativeTokens > maxBudgetTokens) {
          throw new Error(`[CircuitBreaker] Cumulative task tokens exceeded budget limit of ${maxBudgetTokens}. Current: ${cumulativeTokens}`);
        }
        if (cumulativeTaskCostUSD > maxTaskBudgetUSD) {
          throw new Error(`[CircuitBreaker] Cumulative task cost exceeded budget limit of $${maxTaskBudgetUSD} USD. Current: $${cumulativeTaskCostUSD.toFixed(6)}`);
        }
        if (sessionCostUSD > maxSessionBudgetUSD) {
          throw new Error(`[CircuitBreaker] Cumulative session cost exceeded budget limit of $${maxSessionBudgetUSD} USD. Current: $${sessionCostUSD.toFixed(6)}`);
        }

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

        // Add approximate tokens for verification check call
        const approxAuditInput = JSON.stringify(auditContext).length / 4;
        cumulativeTokens += (approxAuditInput + 150); // validator output is small
        if (cumulativeTokens > maxBudgetTokens) {
          throw new Error(`[CircuitBreaker] Cumulative task tokens exceeded budget limit of ${maxBudgetTokens}. Current: ${cumulativeTokens}`);
        }

        let verification = await verificationGate.verify(result, auditContext, clientFactory);

        if (!verification.success) {
          console.log(`🔄 [CascadingExecutor] Verification failed for ${capability.model_id}. Initiating Self-Correction Loop...`);
          
          const initialFailedOutput = result;
          const initialErrorReason = verification.reason;
          
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
              // Run AgentShield Input Scan for Correction Payload
              const corrInputScan = await guardrail.scan(correctionPayload);
              if (!corrInputScan.safe) {
                throw new Error(`[AgentShield] Correction input blocked: ${corrInputScan.reason}`);
              }

              const correctedResult = await client.execute(correctionPayload, schema);
              
              // Run AgentShield Output Scan for Correction Output
              const corrOutputScan = await guardrail.scan(correctedResult);
              if (!corrOutputScan.safe) {
                throw new Error(`[AgentShield] Correction output blocked: ${corrOutputScan.reason}`);
              }

              // Track budget for self-correction call
              const corrInput = JSON.stringify(correctionPayload).length / 4;
              const corrOutput = JSON.stringify(correctedResult).length / 4;
              cumulativeTokens += (corrInput + corrOutput);
              
              const corrInputCost = (corrInput / 1000) * (capability.input_cost_per_1k || 0);
              const corrOutputCost = (corrOutput / 1000) * (capability.output_cost_per_1k || 0);
              const corrCostUSD = corrInputCost + corrOutputCost;
              cumulativeTaskCostUSD += corrCostUSD;
              const sessionCostUSD = tokenMonitor.totalSessionCost + corrCostUSD;

              console.log(`📊 [BudgetGuard] After correction - Tokens: ${cumulativeTokens}/${maxBudgetTokens}, TaskCost: $${cumulativeTaskCostUSD.toFixed(6)}/$${maxTaskBudgetUSD}, SessionCost: $${sessionCostUSD.toFixed(6)}/$${maxSessionBudgetUSD}`);

              if (cumulativeTokens > maxBudgetTokens) {
                throw new Error(`[CircuitBreaker] Cumulative task tokens exceeded budget limit of ${maxBudgetTokens}. Current: ${cumulativeTokens}`);
              }
              if (cumulativeTaskCostUSD > maxTaskBudgetUSD) {
                throw new Error(`[CircuitBreaker] Cumulative task cost exceeded budget limit of $${maxTaskBudgetUSD} USD. Current: $${cumulativeTaskCostUSD.toFixed(6)}`);
              }
              if (sessionCostUSD > maxSessionBudgetUSD) {
                throw new Error(`[CircuitBreaker] Cumulative session cost exceeded budget limit of $${maxSessionBudgetUSD} USD. Current: $${sessionCostUSD.toFixed(6)}`);
              }

              console.log(`✨ [CascadingExecutor] Self-corrected output generated. Re-verifying...`);
              
              // Add tokens for verification audit
              cumulativeTokens += (approxAuditInput + 150);
              if (cumulativeTokens > maxBudgetTokens) {
                throw new Error(`[CircuitBreaker] Cumulative task tokens exceeded budget limit of ${maxBudgetTokens}. Current: ${cumulativeTokens}`);
              }

              const reVerification = await verificationGate.verify(correctedResult, auditContext, clientFactory);
              if (reVerification.success) {
                console.log(`🟢 [CascadingExecutor] Self-Correction Successful!`);
                
                // 儲存 Instinct 教訓
                await instinctManager.saveInstinct(context.objective, initialFailedOutput, initialErrorReason, correctedResult);
                
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
              if (err.message.includes('[CircuitBreaker]')) {
                throw err;
              }
            }
          }

          if (!correctionSuccess) {
            throw new Error(`Model output did not pass verification after ${maxCorrectionAttempts} self-correction attempts. Reason: ${lastReason}`);
          }
        }

        console.log(`✅ [CascadingExecutor] Final success with ${capability.model_id}!`);
        
        // Record usage to monitor
        const inputTokens = JSON.stringify(processedContext).length / 4;
        const outputTokens = JSON.stringify(result).length / 4;
        tokenMonitor.record(capability, inputTokens, inputTokens, outputTokens);
        globalEmitter.emit('task-status', { type: 'success', objective: context.objective, modelUsed: capability.model_id });

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
        
        // Circuit Breaker abort check
        if (error.message.includes('[CircuitBreaker]')) {
          console.error(`🛑 [CascadingExecutor] Circuit Breaker tripped. Halting execution!`);
          globalEmitter.emit('circuit-breaker', { type: 'tripped', reason: error.message });
          throw error;
        }

        console.log(`🔄 [CascadingExecutor] Cascading to next available model...`);
        // Continue to next candidate
      }
    }

    throw new Error(`[CascadingExecutor] All ${attempts} candidates failed. Last error: ${lastError.message}`);
  }
}

module.exports = new CascadingExecutor();
