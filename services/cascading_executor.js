const router = require('./router');
const heartbeatRegistry = require('../registry/heartbeat_registry');
const NvidiaNimClient = require('../infrastructure/clients/nvidia_nim_client');
const GeminiClient = require('../infrastructure/clients/gemini_client');
const DeepSeekClient = require('../infrastructure/clients/deepseek_client');
const VertexAIClient = require('../infrastructure/clients/vertex_ai_client');
const CodeGraphAdapter = require('../infrastructure/adapters/codegraph_adapter');
const verificationGate = require('./verification_gate');
const { RoleAwareContextPlanner } = require('./context_planner');
const { EvidenceAdmissionEngine } = require('./evidence_admission');
const { ContextCompiler } = require('./context_compiler');
const { TokenBudgetGuard } = require('./token_budget_guard');
const guardrail = require('./guardrail_manager');
const codegraph = new CodeGraphAdapter();

/**
 * Compiles verified CodeGraph context via RoleAwareContextPlanner -> EvidenceAdmissionEngine -> ContextCompiler.
 * Returns null when the task provides no structured CodeGraph targets, avoiding crashes on general queries.
 */
async function compileCodeGraphContext(context, options = {}) {
  const hasPlan = Boolean(context && context.retrievalPlan);
  const hasTargets = Boolean(
    context &&
    ((Array.isArray(context.targetFiles) && context.targetFiles.length > 0) ||
     (Array.isArray(context.targetSymbols) && context.targetSymbols.length > 0))
  );
  if (!hasPlan && !hasTargets) {
    return null;
  }

  let retrievalPlan = context.retrievalPlan;
  if (!retrievalPlan) {
    const planner = new RoleAwareContextPlanner();
    retrievalPlan = await planner.plan(context.roleId || options.roleId || null, {
      action: context.action || 'FEATURE',
      targetFiles: context.targetFiles || [],
      targetSymbols: context.targetSymbols || [],
      maxExecutionTokens: context.maxExecutionTokens
    });
  }

  const admissionEngine = new EvidenceAdmissionEngine({
    codeGraphAdapter: codegraph,
    workspaceRoot: options.workspaceRoot || process.cwd()
  });
  const compiler = new ContextCompiler({
    admissionEngine,
    tokenBudgetGuard: TokenBudgetGuard,
    guardrailManager: guardrail,
    codeGraphAdapter: codegraph
  });

  if (options.isolatedEnvelope || context.tenantId) {
    const isoResult = await compiler.compileIsolatedEnvelope(
      retrievalPlan,
      {
        taskId: context.taskId || options.taskId || `task-${Date.now()}`,
        tenantId: context.tenantId || options.tenantId || 'default-tenant',
        taskType: context.taskType || 'FEATURE_DEV'
      },
      options
    );
    if (isoResult.decision && (isoResult.decision.action === 'ABORT' || isoResult.decision.action === 'BLOCK')) {
      throw new Error(`[ContextIsolation] Publication blocked (${isoResult.decision.action}): ${isoResult.decision.reason || 'Policy violation'}`);
    }
    return {
      contextText: (isoResult.envelope && isoResult.envelope.contextText) || '',
      metadata: {
        decision: isoResult.decision,
        admissionReceipt: isoResult.admissionReceipt,
        provenanceToken: isoResult.provenanceToken
      }
    };
  }

  const action = context.action || retrievalPlan.taskCategory || (retrievalPlan.taskPolicy && retrievalPlan.taskPolicy.taskAction) || 'FEATURE';
  const compResult = await compiler.compile(retrievalPlan, { action });
  return {
    contextText: compResult.contextText || '',
    metadata: compResult.metadata || {}
  };
}

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
    const { preferredTier = 'high', maxRetries = 10, taskTimeoutMs = options.timeoutMs || 45000 } = options;
    const taskStartMonotonic = performance.now();
    const taskDeadlineMonotonic = taskStartMonotonic + taskTimeoutMs;
    const globalEmitter = require('../shared/global_emitter');
    globalEmitter.emit('task-status', { type: 'start', objective: context.objective });

    // 0. Deterministic Semantic Cache Check (0 Token / Instant Bypass)
    const SemanticCache = require('./semantic_cache');
    const semanticCache = new SemanticCache();
    const cachedSemantic = semanticCache.get(context, schema);
    if (cachedSemantic.hit) {
      console.log(`✨ [CascadingExecutor] Bypassed LLM execution by 100% Deterministic Semantic Cache.`);
      Object.assign(context, cachedSemantic.data);
      const tokenMonitor = require('../observability/token_monitor');
      tokenMonitor.record('semantic-cache', 0, 0, 0);
      globalEmitter.emit('task-status', { type: 'success', objective: context.objective, modelUsed: 'semantic-cache-bypass' });
      return {
        success: true,
        data: cachedSemantic.data,
        modelUsed: {
          model_id: 'semantic-cache-bypass',
          provider: 'semantic-cache',
          tier: 'ultra-fast',
          context_window: 1000000,
          max_output_tokens: 1000000,
          cost_per_1k_input: 0,
          cost_per_1k_output: 0
        },
        attempts: 1
      };
    }

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
        console.log(`🔄 [CascadingExecutor] Memory audit rejected. Cached memory discarded; proceeding to clean LLM execution...`);
      }
    }

    // Inject Instincts (Continuous Learning)
    const instinctManager = require('./instinct_manager');
    await instinctManager.injectRelevantInstincts(context);

    // Inject compiled CodeGraph context if not already present
    if (!context.code_context) {
      console.log(`\n🕸️  [CascadingExecutor] Running CodeGraph Pre-Query Context Compilation...`);
      const compiledCtx = await compileCodeGraphContext(context, options);
      if (compiledCtx && compiledCtx.contextText) {
        context.code_context = compiledCtx.contextText;
        context.compiledContextMeta = compiledCtx.metadata;
        console.log(`✅ [CascadingExecutor] Injected ${compiledCtx.contextText.length} chars of verified CodeGraph context.`);
      } else {
        console.log(`ℹ️  [CascadingExecutor] No structured CodeGraph targets provided; skipping context compilation.`);
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

    // 2. Parallel Racing Pipeline (Module 2)
    const isRacing = options.race || (context.tags && context.tags.includes('realtime'));
    
    if (isRacing && candidates.length >= 2) {
      console.log(`⚡ [CascadingExecutor] Parallel Racing enabled! Racing top 2 candidates: ${candidates[0].model_id} vs ${candidates[1].model_id}`);
      
      const raceRemaining = taskDeadlineMonotonic - performance.now();
      if (raceRemaining <= 0) {
        const errorMapper = require('../infrastructure/adapters/error_mapper');
        throw errorMapper.createCascadingError({
          type: 'HUB_TASK_TIMEOUT_EXCEEDED',
          message: `Global Task Timeout Exceeded before racing started`,
          statusCode: 504,
          status: 504,
          attempts: 0
        });
      }

      const controller0 = new AbortController();
      const controller1 = new AbortController();
      let winnerDeclared = false;

      const runCandidate = async (capability, myController, otherController) => {
        // Admission Gate
        const admission = heartbeatRegistry.canPass(capability.provider, capability.model_id);
        if (!admission.allowed) {
          throw new Error(`[Admission] Blocked for ${capability.model_id}: ${admission.reason || 'Circuit Open'}`);
        }
        const canaryToken = admission.token || null;
        const canaryTokens = admission.tokens || null;

        const ClientClass = this.clientMap[capability.provider];
        if (!ClientClass) {
          throw new Error(`No client implemented for provider: ${capability.provider}`);
        }

        const client = new ClientClass({ 
          modelCapability: capability,
          promptMapping: { tool_call_template: "Return ONLY a valid JSON object strictly matching the schema." },
          canaryToken,
          canaryTokens
        });
        
        // 1. Scan Input
        const inputScan = await guardrail.scan(processedContext);
        if (!inputScan.safe) {
          throw new Error(`[AgentShield] Input blocked: ${inputScan.reason}`);
        }

        const candidateRemaining = Math.max(1, Math.round(taskDeadlineMonotonic - performance.now()));
        const clampedTimeout = Math.min(capability.timeout_ms || 30000, candidateRemaining);
        
        // 2. Execute with signal & clamped timeout
        const result = await client.execute(processedContext, schema, {
          canaryToken,
          canaryTokens,
          signal: myController.signal,
          timeoutMs: clampedTimeout
        });
        
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
        
        return { result, capability, otherController };
      };

      let racingDeadlineTimer = null;
      const remainingForRacing = Math.max(0, Math.round(taskDeadlineMonotonic - performance.now()));
      if (remainingForRacing > 0) {
        racingDeadlineTimer = setTimeout(() => {
          if (!winnerDeclared) {
            if (!controller0.signal.aborted) controller0.abort('TASK_DEADLINE');
            if (!controller1.signal.aborted) controller1.abort('TASK_DEADLINE');
          }
        }, remainingForRacing);
      }

      try {
        const winner = await Promise.any([
          runCandidate(candidates[0], controller0, controller1),
          runCandidate(candidates[1], controller1, controller0)
        ]);

        winnerDeclared = true;
        // Broadcast cancel to loser
        winner.otherController.abort('RACING_LOST');
        
        console.log(`🏆 [CascadingExecutor] Parallel Racing winner: ${winner.capability.model_id}!`);
        
        // Record and save memory (ONLY for the declared winner)
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
        if (!controller0.signal.aborted) controller0.abort('RACING_LOST');
        if (!controller1.signal.aborted) controller1.abort('RACING_LOST');
      } finally {
        if (racingDeadlineTimer) clearTimeout(racingDeadlineTimer);
      }
    }

    // 3. Loop through candidates until success (Serial Fallback)
    const cascadingSummary = [];
    const allRejectionReasons = [];

    for (const capability of candidates) {
      if (attempts >= maxRetries && attempts > 0) break;

      const remainingMs = taskDeadlineMonotonic - performance.now();
      if (remainingMs <= 0) {
        console.warn(`[CascadingExecutor] Global task deadline exceeded (${taskTimeoutMs}ms). Halting cascading.`);
        const errorMapper = require('../infrastructure/adapters/error_mapper');
        throw errorMapper.createCascadingError({
          type: 'HUB_TASK_TIMEOUT_EXCEEDED',
          message: `Global Task Timeout Exceeded (${taskTimeoutMs}ms budget exhausted)`,
          statusCode: 504,
          status: 504,
          attempts: attempts,
          cascadingSummary: cascadingSummary
        });
      }

      // Admission Gate: Check circuit breaker state and acquire Canary Probe Token if HALF-OPEN
      const admission = heartbeatRegistry.canPass(capability.provider, capability.model_id);
      if (!admission.allowed) {
        console.warn(`[CascadingExecutor] 🛑 Admission rejected for ${capability.model_id} (${capability.provider}): ${admission.reason || 'Circuit Open'}. Cascading to next candidate.`);
        allRejectionReasons.push({
          model_id: capability.model_id,
          provider: capability.provider,
          reason: admission.reason || 'Circuit Open',
          statusCode: 503
        });
        continue;
      }
      const canaryToken = admission.token || null;
      const canaryTokens = admission.tokens || null;
      
      attempts++;
      console.log(`\n🚀 [Attempt ${attempts}] Trying ${capability.model_id} (${capability.provider})...`);

      const currentLoopRemaining = Math.max(1, Math.round(taskDeadlineMonotonic - performance.now()));
      const clientDefaultTimeout = capability.timeout_ms || 30000;
      const clampedTimeoutMs = Math.min(clientDefaultTimeout, currentLoopRemaining);
      const attemptAbortController = new AbortController();

      try {
        const ClientClass = this.clientMap[capability.provider];
        if (!ClientClass) {
          throw new Error(`No client implemented for provider: ${capability.provider}`);
        }

        const client = new ClientClass({ 
          modelCapability: capability,
          promptMapping: { tool_call_template: "Return ONLY a valid JSON object strictly matching the schema." },
          canaryToken,
          canaryTokens
        });

        // Run AgentShield Input Scan
        const inputScan = await guardrail.scan(processedContext);
        if (!inputScan.safe) {
          throw new Error(`[AgentShield] Input blocked: ${inputScan.reason}`);
        }

        // 3. Run execution
        let result = await client.execute(processedContext, schema, {
          canaryToken,
          canaryTokens,
          signal: attemptAbortController.signal,
          timeoutMs: clampedTimeoutMs
        });
        
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
          // If the verification failure is due to infrastructure error (not model content error),
          // DO NOT waste tokens attempting self-correction on the model. Halt immediately and cascade!
          if (verification.errorType === 'VERIFICATION_INFRASTRUCTURE_ERROR') {
            console.error(`🛑 [CascadingExecutor] Verification infrastructure error: ${verification.reason}. Halting self-correction loop.`);
            throw new Error(`[VerificationInfrastructure] ${verification.reason}`);
          }

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
              } else if (reVerification.errorType === 'VERIFICATION_INFRASTRUCTURE_ERROR') {
                console.error(`🛑 [CascadingExecutor] Verification infrastructure error during self-correction: ${reVerification.reason}. Halting loop.`);
                throw new Error(`[VerificationInfrastructure] ${reVerification.reason}`);
              } else {
                console.warn(`⚠️  [CascadingExecutor] Self-Correction failed validation: ${reVerification.reason}`);
                lastResult = correctedResult;
                lastReason = reVerification.reason;
              }
            } catch (err) {
              console.error(`❌ [CascadingExecutor] Error during self-correction: ${err.message}`);
              lastReason = err.message;
              if (err.message.includes('[CircuitBreaker]') || err.message.includes('[VerificationInfrastructure]')) {
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

        // Phase 3: Save successful task execution to memory & semantic cache
        await memoryManager.saveMemory(context.objective, result);
        semanticCache.set(context, schema, result);

        return {
          success: true,
          data: result,
          modelUsed: capability,
          attempts: attempts
        };

      } catch (error) {
        lastError = error;
        console.error(`⚠️  [CascadingExecutor] Failed with ${capability.model_id}: ${error.message}`);
        
        cascadingSummary.push({
          modelId: capability.model_id,
          provider: capability.provider,
          statusCode: error.status || error.statusCode || 500,
          type: error.type || 'HUB_UNKNOWN_ERROR',
          message: error.message
        });

        // Mark as degraded in heartbeat ONLY if not already recorded inside BaseClient
        // This avoids duplicate probe settlement/recording
        if (!error.recordedInClient && error.type !== 'HUB_OPERATION_CANCELLED') {
          heartbeatRegistry.record(
            { provider: capability.provider, modelId: capability.model_id },
            0,
            false,
            { error, token: canaryToken || null, tokens: canaryTokens || null }
          );
        }
        
        // Circuit Breaker abort check
        if (error.message && error.message.includes('[CircuitBreaker]')) {
          console.error(`🛑 [CascadingExecutor] Circuit Breaker tripped. Halting execution!`);
          globalEmitter.emit('circuit-breaker', { type: 'tripped', reason: error.message });
          throw error;
        }

        console.log(`🔄 [CascadingExecutor] Cascading to next available model...`);
        // Continue to next candidate
      }
    }

    // All candidates failed or none admitted. Determine structured terminal error:
    const errorMapper = require('../infrastructure/adapters/error_mapper');

    // Case 1: Deadline expired during execution
    if (performance.now() >= taskDeadlineMonotonic) {
      throw errorMapper.createCascadingError({
        type: 'HUB_TASK_TIMEOUT_EXCEEDED',
        message: `Global Task Timeout Exceeded (${taskTimeoutMs}ms budget exhausted)`,
        statusCode: 504,
        status: 504,
        attempts: attempts,
        cascadingSummary: cascadingSummary
      });
    }

    // Case 2: All candidates were rejected at Admission Gate due to Circuit OPEN (attempts === 0)
    if (attempts === 0) {
      if (candidates.length === 0) {
        const modelRegistry = require('../registry/model_registry');
        const quotaGuard = require('../infrastructure/adapters/quota_guard');
        const capableModels = modelRegistry.getModelsByCapability(requiredModalities)
          .filter(m => m.context_window >= (context.minContext || 0));

        if (capableModels.length === 0) {
          throw errorMapper.createCascadingError({
            type: 'HUB_MODEL_NOT_FOUND',
            message: 'No candidate models available matching required capabilities',
            statusCode: 404,
            status: 404,
            attempts: 0,
            cascadingSummary: []
          });
        }

        const allQuotaExceeded = capableModels.every(m => !quotaGuard.canProceed(m.provider, m.limits));
        if (allQuotaExceeded) {
          throw errorMapper.createCascadingError({
            type: 'HUB_RATE_LIMIT',
            message: 'All candidate models exceeded quota limits',
            statusCode: 429,
            status: 429,
            attempts: 0,
            cascadingSummary: []
          });
        }
      }

      // If candidates exist but all were rejected by canPass(), calculate minRetryAfterMs
      let minRetryAfterMs = null;
      const now = Date.now();
      for (const c of candidates) {
        const node = heartbeatRegistry.getNode(`${c.provider}:${c.model_id}`);
        if (node && node.state === 'OPEN' && !node.permanent && node.notBefore && node.notBefore > now) {
          const remaining = node.notBefore - now;
          if (minRetryAfterMs === null || remaining < minRetryAfterMs) {
            minRetryAfterMs = remaining;
          }
        }
      }

      throw errorMapper.createCascadingError({
        type: 'HUB_ALL_CANDIDATES_CIRCUIT_OPEN',
        message: 'All candidate models are currently in circuit OPEN state',
        statusCode: 503,
        status: 503,
        attempts: 0,
        retryAfterMs: minRetryAfterMs,
        cascadingSummary: allRejectionReasons
      });
    }

    // Case 3: Candidates were attempted, but all failed (mixed or uniform cascading failure)
    throw errorMapper.createCascadingError({
      type: 'HUB_CASCADING_FAILED',
      message: `Cascading execution failed across all ${attempts} attempted candidates: ${lastError ? lastError.message : 'Unknown error'}`,
      statusCode: 502,
      status: 502,
      attempts: attempts,
      cascadingSummary: cascadingSummary,
      cause: lastError
    });
  }
}

module.exports = new CascadingExecutor();
