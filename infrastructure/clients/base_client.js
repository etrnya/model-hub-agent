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
    
    this.retryConfig = {
      maxRetries: 3,
      initialDelay: 1000,
      maxRetryAfterMs: parseInt(process.env.MAX_RETRY_AFTER_MS || '30000', 10),
      ...(config.retry || {})
    };
    this.canaryToken = config.canaryToken || null;
    this.canaryTokens = config.canaryTokens || null;
    this._sleep = config.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /**
   * Prepares the state for the target model, applying compression if necessary.
   * @param {Object} globalState 
   */
  async prepareState(globalState) {
    return await this.compressor.compress(globalState, this.modelCapability);
  }

  /**
   * Resolves the request URL and headers, optionally routing through the Headroom Context Shaper.
   * @param {string} originalUrl 
   * @param {Object} originalHeaders 
   * @param {Object} [integrityHeaders={}] 
   * @returns {{ url: string, headers: Object }}
   */
  resolveRequestRoute(originalUrl, originalHeaders = {}, integrityHeaders = {}) {
    const useProxy = process.env.USE_HEADROOM_PROXY === 'true';
    const proxyUrl = process.env.HEADROOM_PROXY_URL || 'http://localhost:8787';

    if (!useProxy) {
      return { url: originalUrl, headers: originalHeaders };
    }

    const parsed = new URL(originalUrl);
    const originalBase = parsed.origin;
    
    // Redirect endpoint to Headroom Proxy
    const targetUrl = `${proxyUrl.replace(/\/$/, '')}${parsed.pathname}${parsed.search}`;

    const headers = {
      ...originalHeaders,
      ...integrityHeaders, // Automatically inject CIG policies
      'x-headroom-base-url': originalBase
    };

    return { url: targetUrl, headers };
  }

  /**
   * Executes a request to the model with integrated resilience logic.
   * @param {Object} globalState 
   * @param {Object} outputSchema - The expected JSON schema for the response.
   */
  async execute(globalState, outputSchema, executionOptions = {}) {
    if (executionOptions && executionOptions.canaryToken) {
      this.canaryToken = executionOptions.canaryToken;
    }
    if (executionOptions && executionOptions.canaryTokens) {
      this.canaryTokens = executionOptions.canaryTokens;
    }
    this.signal = executionOptions?.signal || null;
    this.timeoutMs = executionOptions?.timeoutMs || null;
    const heartbeatRegistry = require('../../registry/heartbeat_registry');
    const errorMapper = require('../adapters/error_mapper');

    // Pre-execution abort check
    if (this.signal && this.signal.aborted) {
      const cancelReason = typeof this.signal.reason === 'string'
        ? this.signal.reason
        : (this.signal.reason?.message || 'CALLER_CANCELLED');
      const abortErr = new Error(cancelReason);
      abortErr.name = 'AbortError';
      abortErr.reason = cancelReason;
      abortErr.isInternalAbort = true;
      const structuredError = errorMapper.toHubError(abortErr, {
        provider: this.modelCapability.provider,
        modelId: this.modelCapability.model_id,
        reason: cancelReason,
        isInternalAbort: true,
        faultScope: 'NONE'
      });
      heartbeatRegistry.record(
        { provider: this.modelCapability.provider, modelId: this.modelCapability.model_id },
        0,
        false,
        { error: structuredError, faultScope: 'NONE', token: this.canaryToken || null, tokens: this.canaryTokens || null }
      );
      structuredError.recordedInClient = true;
      throw structuredError;
    }

    // 1. Quota Check
    if (!quotaGuard.canProceed(this.modelCapability.provider, this.modelCapability.limits)) {
      throw errorMapper.createError(this.modelCapability.provider, {
        status: 429,
        message: `Quota limit reached for ${this.modelCapability.provider}`,
        modelId: this.modelCapability.model_id
      });
    }

    const readyState = await this.prepareState(globalState);
    
    let lastError = null;
    for (let attempt = 1; attempt <= this.retryConfig.maxRetries; attempt++) {
      const startTime = Date.now();
      let callSettled = true;
      let callPromise = null;
      try {
        console.log(`[BaseClient] Attempt ${attempt} for model: ${this.modelCapability.model_id}`);
        
        if (this.signal && this.signal.aborted) {
          const cancelReason = typeof this.signal.reason === 'string'
            ? this.signal.reason
            : (this.signal.reason?.message || 'CALLER_CANCELLED');
          const abortErr = new Error(cancelReason);
          abortErr.name = 'AbortError';
          abortErr.reason = cancelReason;
          abortErr.isInternalAbort = true;
          throw abortErr;
        }

        callSettled = false;
        callPromise = this._callModelApi(readyState, outputSchema, {
          signal: this.signal,
          timeoutMs: this.timeoutMs
        });
        callPromise.then(
          () => { callSettled = true; },
          () => { callSettled = true; }
        );

        let rawResponse;
        if (typeof this.timeoutMs === 'number' && this.timeoutMs > 0) {
          let timer;
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
              const err = new Error(`Client Execution Timeout (${this.timeoutMs}ms)`);
              err.name = "TimeoutError";
              reject(err);
            }, this.timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
          });
          let abortListener;
          const abortPromise = this.signal ? new Promise((_, reject) => {
            if (this.signal.aborted) {
              const reason = this.signal.reason || 'CALLER_CANCELLED';
              const err = new Error(typeof reason === 'string' ? reason : 'Aborted');
              err.name = 'AbortError';
              err.reason = reason;
              err.isInternalAbort = true;
              return reject(err);
            }
            abortListener = () => {
              const reason = this.signal.reason || 'CALLER_CANCELLED';
              const err = new Error(typeof reason === 'string' ? reason : 'Aborted');
              err.name = 'AbortError';
              err.reason = reason;
              err.isInternalAbort = true;
              reject(err);
            };
            this.signal.addEventListener('abort', abortListener, { once: true });
          }) : null;

          try {
            rawResponse = await Promise.race(
              abortPromise ? [callPromise, timeoutPromise, abortPromise] : [callPromise, timeoutPromise]
            );
          } finally {
            if (timer) clearTimeout(timer);
            if (this.signal && abortListener) this.signal.removeEventListener('abort', abortListener);
          }
        } else if (this.signal) {
          let abortListener;
          const abortPromise = new Promise((_, reject) => {
            if (this.signal.aborted) {
              const reason = this.signal.reason || 'CALLER_CANCELLED';
              const err = new Error(typeof reason === 'string' ? reason : 'Aborted');
              err.name = 'AbortError';
              err.reason = reason;
              err.isInternalAbort = true;
              return reject(err);
            }
            abortListener = () => {
              const reason = this.signal.reason || 'CALLER_CANCELLED';
              const err = new Error(typeof reason === 'string' ? reason : 'Aborted');
              err.name = 'AbortError';
              err.reason = reason;
              err.isInternalAbort = true;
              reject(err);
            };
            this.signal.addEventListener('abort', abortListener, { once: true });
          });
          try {
            rawResponse = await Promise.race([callPromise, abortPromise]);
          } finally {
            if (abortListener) this.signal.removeEventListener('abort', abortListener);
          }
        } else {
          rawResponse = await callPromise;
        }

        const duration = Date.now() - startTime;

        // Side-Effect Defense 1: Verify not cancelled right after API call returns
        if (this.signal && this.signal.aborted) {
          const cancelReason = typeof this.signal.reason === 'string'
            ? this.signal.reason
            : (this.signal.reason?.message || 'CALLER_CANCELLED');
          const abortErr = new Error(cancelReason);
          abortErr.name = 'AbortError';
          abortErr.reason = cancelReason;
          abortErr.isInternalAbort = true;
          throw abortErr;
        }

        // Silent Fix & Validation
        const result = this.validator.parseAndValidate(rawResponse, outputSchema);

        // Side-Effect Defense 2: Verify not cancelled right before recording success & quota
        if (this.signal && this.signal.aborted) {
          const cancelReason = typeof this.signal.reason === 'string'
            ? this.signal.reason
            : (this.signal.reason?.message || 'CALLER_CANCELLED');
          const abortErr = new Error(cancelReason);
          abortErr.name = 'AbortError';
          abortErr.reason = cancelReason;
          abortErr.isInternalAbort = true;
          throw abortErr;
        }

        if (result.success) {
          if (result.fixed) console.log("[BaseClient] Response successfully repaired via SilentFix.");

          // Record Heartbeat (Success) ONLY when validated AND not aborted
          heartbeatRegistry.record(
            { provider: this.modelCapability.provider, modelId: this.modelCapability.model_id },
            duration,
            true,
            { token: this.canaryToken || null, tokens: this.canaryTokens || null }
          );

          // Record Quota Usage (Estimate if not provided by provider)
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
        lastError = errorMapper.createError(this.modelCapability.provider, {
          status: 400,
          message: result.error || "Validation Failed",
          modelId: this.modelCapability.model_id
        });
        
      } catch (rawError) {
        const duration = Date.now() - startTime;

        // Check if this error represents an internal cancellation
        const cancelReason = (this.signal && this.signal.aborted)
          ? (typeof this.signal.reason === 'string' ? this.signal.reason : (this.signal.reason?.message || 'CALLER_CANCELLED'))
          : (typeof rawError?.reason === 'string' ? rawError.reason : (rawError?.name === 'AbortError' ? rawError.message : null));

        const isInternalAbort = Boolean(
          rawError.isInternalAbort ||
          (cancelReason && ['RACING_LOST', 'TASK_DEADLINE', 'CALLER_CANCELLED'].includes(cancelReason)) ||
          (this.signal && this.signal.aborted)
        );

        const effectiveReason = isInternalAbort ? (cancelReason || 'CALLER_CANCELLED') : null;

        const structuredError = errorMapper.toHubError(rawError, {
          provider: this.modelCapability.provider,
          modelId: this.modelCapability.model_id,
          reason: effectiveReason,
          isInternalAbort: isInternalAbort,
          faultScope: isInternalAbort ? 'NONE' : undefined
        });
        
        lastError = structuredError;

        if (isInternalAbort) {
          // Allow any synchronous or microtask abort listener on callPromise to settle
          await Promise.resolve();

          if (callSettled || !callPromise) {
            console.warn(`[BaseClient] Internal cancellation encountered [${effectiveReason}] with settled call. Immediate neutral probe release.`);
            heartbeatRegistry.record(
              { provider: this.modelCapability.provider, modelId: this.modelCapability.model_id },
              duration,
              false,
              {
                error: structuredError,
                faultScope: 'NONE',
                token: this.canaryToken || null,
                tokens: this.canaryTokens || null
              }
            );
          } else {
            console.warn(`[BaseClient] Stop-Waiting cancellation [${effectiveReason}]: underlying request still in-flight. Deferring probe release until underlying operation settles.`);
            callPromise.finally(() => {
              console.warn(`[BaseClient] In-flight request settled late following Stop-Waiting cancellation [${effectiveReason}]. Executing deferred neutral probe release.`);
              heartbeatRegistry.record(
                { provider: this.modelCapability.provider, modelId: this.modelCapability.model_id },
                Date.now() - startTime,
                false,
                {
                  error: structuredError,
                  faultScope: 'NONE',
                  token: this.canaryToken || null,
                  tokens: this.canaryTokens || null
                }
              );
            }).catch(() => {});
          }
          structuredError.recordedInClient = true;
          throw structuredError;
        }

        console.error(`[BaseClient] API Error on attempt ${attempt} (${structuredError.type}):`, structuredError.message);

        // Fast-Fail: Check if error is Fatal (non-retryable configuration/client error)
        if (!errorMapper.shouldRetry(structuredError)) {
          console.warn(`[BaseClient] Fatal error encountered [${structuredError.type}]. Aborting retries immediately (Fast-Fail on attempt ${attempt}).`);
          heartbeatRegistry.record(
            { provider: this.modelCapability.provider, modelId: this.modelCapability.model_id },
            duration,
            false,
            { error: structuredError, token: this.canaryToken || null, tokens: this.canaryTokens || null }
          );
          structuredError.recordedInClient = true;
          throw structuredError;
        }

        // Transient Error: Record Heartbeat & Degraded mark
        heartbeatRegistry.record(
          { provider: this.modelCapability.provider, modelId: this.modelCapability.model_id },
          duration,
          false,
          { error: structuredError, token: this.canaryToken || null, tokens: this.canaryTokens || null }
        );
        structuredError.recordedInClient = true;
      }

      // Retry delay for transient errors: respect Retry-After header if present
      if (attempt < this.retryConfig.maxRetries) {
        let delay;
        const hasExplicitRetryAfter = lastError && lastError.retryAfterMs !== null && lastError.retryAfterMs !== undefined;

        if (hasExplicitRetryAfter) {
          const requestedDelay = lastError.retryAfterMs;
          const maxAllowedDelay = this.retryConfig.maxRetryAfterMs;

          // Check if Retry-After exceeds single task in-place wait budget
          if (typeof maxAllowedDelay === 'number' && maxAllowedDelay > 0 && requestedDelay > maxAllowedDelay) {
            console.warn(`[BaseClient] Retry-After delay (${lastError.retryAfter}s / ${requestedDelay}ms) exceeds max in-place retry limit (${maxAllowedDelay}ms). Aborting in-place retry to trigger cascading fallback.`);
            lastError.retryAfterExceeded = true;
            heartbeatRegistry.record(
              { provider: this.modelCapability.provider, modelId: this.modelCapability.model_id },
              0,
              false,
              { error: lastError, notBefore: Date.now() + requestedDelay, token: this.canaryToken || null, tokens: this.canaryTokens || null }
            );
            throw lastError;
          }

          delay = requestedDelay;
          console.log(`[BaseClient] Respecting Retry-After header: waiting ${lastError.retryAfter}s (${delay}ms)...`);
        } else {
          delay = this.retryConfig.initialDelay * Math.pow(2, attempt - 1);
        }

        if (this.signal && this.signal.aborted) {
          const cancelReason = typeof this.signal.reason === 'string'
            ? this.signal.reason
            : (this.signal.reason?.message || 'CALLER_CANCELLED');
          const abortErr = new Error(cancelReason);
          abortErr.name = 'AbortError';
          abortErr.reason = cancelReason;
          abortErr.isInternalAbort = true;
          throw abortErr;
        }

        if (delay > 0) {
          if (this.signal) {
            await Promise.race([
              this._sleep(delay),
              new Promise((_, reject) => {
                const onAbort = () => {
                  const reason = this.signal.reason || 'CALLER_CANCELLED';
                  const err = new Error(typeof reason === 'string' ? reason : 'Aborted');
                  err.name = 'AbortError';
                  err.reason = reason;
                  err.isInternalAbort = true;
                  reject(err);
                };
                if (this.signal.aborted) {
                  return onAbort();
                }
                this.signal.addEventListener('abort', onAbort, { once: true });
              })
            ]);
          } else {
            await this._sleep(delay);
          }
        } else {
          console.log(`[BaseClient] Retry-After is 0s: executing immediate retry without backoff delay.`);
        }
      }
    }

    throw lastError || new Error(`[BaseClient] Failed after ${this.retryConfig.maxRetries} attempts.`);
  }

  /**
   * Abstract method to be implemented by specific provider clients (Gemini, DeepSeek, etc.)
   */
  async _callModelApi(payload) {
    throw new Error("_callModelApi must be implemented by subclass");
  }
}

module.exports = BaseClient;
