/**
 * UnifiedErrorMapper
 * Maps provider-specific error codes (Google, DeepSeek, NVIDIA NIM, Vertex AI)
 * to standard internal exceptions with structured classification, Retry-After parsing,
 * and Fast-Fail / Retry dispositions.
 */

class HubError extends Error {
  /**
   * @param {Object} options
   * @param {string} options.type - Internal error type (e.g. HUB_AUTH_ERROR)
   * @param {string} [options.provider='unknown'] - Provider ID (google, deepseek, nvidia-nim, vertex-ai)
   * @param {string|null} [options.modelId=null] - Target model ID
   * @param {number|null} [options.status=null] - HTTP status code
   * @param {string|null} [options.providerCode=null] - Provider native error code
   * @param {string} [options.message=''] - Error message
   * @param {number|null} [options.retryAfter=null] - Cooldown delay in seconds
   * @param {Error|null} [options.cause=null] - Underlying original error / exception
   * @param {boolean} [options.isTransient=false] - Whether this error is transient and eligible for retry
   */
  constructor(options = {}) {
    const {
      type = 'HUB_UNKNOWN_ERROR',
      provider = 'unknown',
      modelId = null,
      status = null,
      providerCode = null,
      message = 'An error occurred',
      retryAfter = null,
      cause = null,
      isTransient = false,
      faultScope = 'UNKNOWN'
    } = options;

    super(`[${type}] ${message}`);
    this.name = 'HubError';
    this.type = type;
    this.provider = provider;
    this.modelId = modelId;
    this.status = status;
    this.providerCode = providerCode;
    this.retryAfter = retryAfter;
    this.retryAfterMs = typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter * 1000 : null;
    this.cause = cause;
    this.isTransient = isTransient;
    this.faultScope = faultScope;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, HubError);
    }
  }
}

class HubCascadingError extends HubError {
  constructor(options = {}) {
    const {
      type = 'HUB_CASCADING_FAILED',
      message = 'Cascading execution failed across all candidates',
      status = 502,
      statusCode = 502,
      faultScope = 'TASK',
      retryAfter = null,
      retryAfterMs = null,
      attempts = 0,
      cascadingSummary = [],
      cause = null
    } = options;

    const resolvedStatus = status !== undefined && status !== 502 ? status : statusCode;
    const resolvedRetryAfter = retryAfter !== null ? retryAfter : (typeof retryAfterMs === 'number' ? Math.ceil(retryAfterMs / 1000) : null);

    super({
      type,
      message,
      status: resolvedStatus,
      faultScope,
      retryAfter: resolvedRetryAfter,
      cause,
      isTransient: false
    });

    this.name = 'HubCascadingError';
    this.statusCode = resolvedStatus;
    this.attempts = attempts;
    this.cascadingSummary = cascadingSummary;
    if (typeof retryAfterMs === 'number') {
      this.retryAfterMs = retryAfterMs;
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, HubCascadingError);
    }
  }
}

class UnifiedErrorMapper {
  constructor() {
    this.HubError = HubError;
    this.HubCascadingError = HubCascadingError;

    this.ERROR_TYPES = {
      // Standardized Provider Error Taxonomy
      AUTH_ERROR: 'HUB_AUTH_ERROR',
      OPERATION_CANCELLED: 'HUB_OPERATION_CANCELLED',
      ALL_CANDIDATES_CIRCUIT_OPEN: 'HUB_ALL_CANDIDATES_CIRCUIT_OPEN',
      TASK_TIMEOUT_EXCEEDED: 'HUB_TASK_TIMEOUT_EXCEEDED',
      CASCADING_FAILED: 'HUB_CASCADING_FAILED',
      PERMISSION_ERROR: 'HUB_PERMISSION_ERROR',
      INVALID_REQUEST: 'HUB_INVALID_REQUEST',
      MODEL_NOT_FOUND: 'HUB_MODEL_NOT_FOUND',
      RESOURCE_NOT_FOUND: 'HUB_RESOURCE_NOT_FOUND',
      RATE_LIMIT_ERROR: 'HUB_RATE_LIMIT',
      TIMEOUT_ERROR: 'HUB_TIMEOUT_ERROR',
      NETWORK_ERROR: 'HUB_NETWORK_ERROR',
      PROVIDER_SERVER_ERROR: 'HUB_PROVIDER_SERVER_ERROR',
      UNKNOWN_ERROR: 'HUB_UNKNOWN_ERROR',

      // Backward-compatible aliases
      HUB_RATE_LIMIT: 'HUB_RATE_LIMIT',
      HUB_POLICY_VIOLATION: 'HUB_POLICY_VIOLATION',
      HUB_CONTEXT_OVERFLOW: 'HUB_CONTEXT_OVERFLOW',
      HUB_AUTH_ERROR: 'HUB_AUTH_ERROR',
      HUB_INTERNAL_ERROR: 'HUB_PROVIDER_SERVER_ERROR',
      HUB_UNKNOWN_ERROR: 'HUB_UNKNOWN_ERROR',
      HUB_PERMISSION_ERROR: 'HUB_PERMISSION_ERROR',
      HUB_INVALID_REQUEST: 'HUB_INVALID_REQUEST',
      HUB_MODEL_NOT_FOUND: 'HUB_MODEL_NOT_FOUND',
      HUB_RESOURCE_NOT_FOUND: 'HUB_RESOURCE_NOT_FOUND',
      HUB_TIMEOUT_ERROR: 'HUB_TIMEOUT_ERROR',
      HUB_NETWORK_ERROR: 'HUB_NETWORK_ERROR',
      HUB_PROVIDER_SERVER_ERROR: 'HUB_PROVIDER_SERVER_ERROR'
    };
  }

  /**
   * Parses the Retry-After header value into seconds.
   * Supports both integer seconds format (e.g. "120") and HTTP-date format (RFC 7231).
   * @param {string|number|null|undefined} value
   * @returns {number|null} Seconds to wait, or null if unparseable / absent
   */
  parseRetryAfter(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
      return !isNaN(value) && value >= 0 ? Math.ceil(value) : null;
    }
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    // 1. Integer seconds (e.g., "120", "5")
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      return !isNaN(parsed) && parsed >= 0 ? parsed : null;
    }

    // 2. HTTP-date format (e.g., "Wed, 21 Oct 2026 07:28:00 GMT")
    const dateMs = Date.parse(trimmed);
    if (!isNaN(dateMs)) {
      const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
      return diffSec > 0 ? diffSec : 0;
    }

    return null;
  }

  /**
   * Extracts Retry-After from diverse header containers (Headers instance, plain object, or string).
   * @param {any} headers
   * @returns {number|null}
   */
  _extractRetryAfter(headers) {
    if (!headers) return null;
    let val = null;
    if (typeof headers.get === 'function') {
      val = headers.get('retry-after') || headers.get('Retry-After');
    } else if (typeof headers === 'object') {
      val = headers['retry-after'] || headers['Retry-After'];
    } else if (typeof headers === 'string' || typeof headers === 'number') {
      val = headers;
    }
    return this.parseRetryAfter(val);
  }

  /**
   * Classifies error details and returns structured classification metadata.
   * @param {string} provider - 'google', 'deepseek', 'nvidia-nim', 'vertex-ai'
   * @param {any} error - Raw error object, HTTP response info, or Error instance
   * @param {Object} [options={}] - Additional context ({ modelId, headers, status, message, cause })
   */
  classify(provider = 'unknown', error = {}, options = {}) {
    const raw = error || {};
    const opt = options || {};

    const cause = opt.cause || (raw instanceof Error ? raw : null);
    const modelId = opt.modelId || raw.modelId || null;

    // Extract HTTP status code
    let status = opt.status !== undefined ? opt.status : (raw.status !== undefined ? raw.status : (raw.statusCode || null));
    if (typeof status === 'string' && /^\d+$/.test(status)) {
      status = parseInt(status, 10);
    }

    // Extract message
    let message = opt.message || raw.message || "";
    if (typeof message !== 'string') {
      try {
        message = JSON.stringify(message);
      } catch {
        message = String(message);
      }
    }

    // Extract provider code (e.g. from errorData.error.status or errorData.code)
    let providerCode = opt.providerCode || raw.providerCode || raw.code || null;
    const errContainer = opt.errorData || raw.errorData || opt.error || raw.error || raw;
    if (errContainer && typeof errContainer === 'object') {
      if (errContainer.error && typeof errContainer.error === 'object') {
        providerCode = providerCode || errContainer.error.status || errContainer.error.code || null;
        if (!message && errContainer.error.message) message = errContainer.error.message;
      }
      providerCode = providerCode || errContainer.status || errContainer.code || null;
      if (!message && errContainer.message) message = errContainer.message;
    }

    // Extract Retry-After
    const retryAfter = opt.retryAfter !== undefined
      ? this.parseRetryAfter(opt.retryAfter)
      : this._extractRetryAfter(opt.headers || raw.headers || (raw.response && raw.response.headers));

    // Inspect error name or code for network/timeout
    const errName = (cause && cause.name) || raw.name || "";
    const errCode = String(providerCode || (cause && cause.code) || "");
    const lowerMsg = message.toLowerCase();

    let type = this.ERROR_TYPES.UNKNOWN_ERROR;

    // ============================================================
    // Priority 1: Authoritative HTTP Status Codes
    // ============================================================
    if (status !== null && status !== undefined) {
      if (status === 500 || status === 502 || status === 503 || status === 504) {
        // Provider server and gateway failures (including 504 Gateway Timeout)
        type = this.ERROR_TYPES.PROVIDER_SERVER_ERROR;
      } else if (status === 401) {
        type = this.ERROR_TYPES.AUTH_ERROR;
      } else if (status === 403) {
        type = this.ERROR_TYPES.PERMISSION_ERROR;
      } else if (status === 429) {
        type = this.ERROR_TYPES.RATE_LIMIT_ERROR;
      } else if (status === 404) {
        // Distinguish specific Model Not Found vs generic URL / endpoint / resource not found
        const hasModelEvidence = (
          errCode === 'model_not_found' ||
          lowerMsg.includes('model not found') ||
          lowerMsg.includes('models/') ||
          (lowerMsg.includes('model') && (lowerMsg.includes('not found') || lowerMsg.includes('does not exist') || lowerMsg.includes('could not find')))
        );

        type = hasModelEvidence
          ? this.ERROR_TYPES.MODEL_NOT_FOUND
          : this.ERROR_TYPES.RESOURCE_NOT_FOUND;
      } else if (status === 400 || status === 422) {
        if (lowerMsg.includes('context') || lowerMsg.includes('token limit')) {
          type = this.ERROR_TYPES.HUB_CONTEXT_OVERFLOW;
        } else if (lowerMsg.includes('safety') || lowerMsg.includes('policy')) {
          type = this.ERROR_TYPES.HUB_POLICY_VIOLATION;
        } else {
          type = this.ERROR_TYPES.INVALID_REQUEST;
        }
      }
    }

    // ============================================================
    // Priority 2: Structured Provider Error Codes (when status is absent/generic)
    // ============================================================
    if (type === this.ERROR_TYPES.UNKNOWN_ERROR && errCode) {
      if (errCode === 'UNAUTHENTICATED' || errCode === 'invalid_api_key') {
        type = this.ERROR_TYPES.AUTH_ERROR;
      } else if (errCode === 'PERMISSION_DENIED') {
        type = this.ERROR_TYPES.PERMISSION_ERROR;
      } else if (errCode === 'RESOURCE_EXHAUSTED' || errCode === 'rate_limit_exceeded') {
        type = this.ERROR_TYPES.RATE_LIMIT_ERROR;
      } else if (errCode === 'model_not_found') {
        type = this.ERROR_TYPES.MODEL_NOT_FOUND;
      } else if (errCode === 'INVALID_ARGUMENT' || errCode === 'invalid_request_error') {
        type = this.ERROR_TYPES.INVALID_REQUEST;
      } else if (errCode === 'INTERNAL' || errCode === 'service_unavailable') {
        type = this.ERROR_TYPES.PROVIDER_SERVER_ERROR;
      }
    }

    // ============================================================
    // Priority 3: Client Transport & Network Exceptions (when status is absent)
    // ============================================================
    if (type === this.ERROR_TYPES.UNKNOWN_ERROR) {
      // Check if this error represents an internal cancellation (Racing lost, Task deadline, Caller cancelled)
      const isInternalAbort = Boolean(
        opt.isInternalAbort ||
        raw.isInternalAbort ||
        ['RACING_LOST', 'TASK_DEADLINE', 'CALLER_CANCELLED'].includes(opt.reason) ||
        ['RACING_LOST', 'TASK_DEADLINE', 'CALLER_CANCELLED'].includes(raw.reason) ||
        (cause && ['RACING_LOST', 'TASK_DEADLINE', 'CALLER_CANCELLED'].includes(cause.reason)) ||
        (errName === 'AbortError' && ['RACING_LOST', 'TASK_DEADLINE', 'CALLER_CANCELLED'].includes(message)) ||
        (lowerMsg.includes('racing_lost') || lowerMsg.includes('task_deadline') || lowerMsg.includes('caller_cancelled'))
      );

      if (isInternalAbort) {
        type = this.ERROR_TYPES.OPERATION_CANCELLED;
      } else if (
        errName === 'AbortError' ||
        errName === 'TimeoutError' ||
        errCode === 'ETIMEDOUT' ||
        errCode === 'ESOCKETTIMEDOUT' ||
        lowerMsg.includes('timed out') ||
        (lowerMsg.includes('timeout') && !lowerMsg.includes('gateway timeout'))
      ) {
        type = this.ERROR_TYPES.TIMEOUT_ERROR;
      } else if (
        errCode === 'ECONNREFUSED' ||
        errCode === 'ECONNRESET' ||
        errCode === 'ENOTFOUND' ||
        errCode === 'EAI_AGAIN' ||
        lowerMsg.includes('fetch failed') ||
        lowerMsg.includes('getaddrinfo') ||
        lowerMsg.includes('econnrefused') ||
        (lowerMsg.includes('network') && !lowerMsg.includes('neural network'))
      ) {
        type = this.ERROR_TYPES.NETWORK_ERROR;
      }
    }

    // ============================================================
    // Priority 4: Message Heuristics & Legacy Prefix Fallback
    // ============================================================
    if (type === this.ERROR_TYPES.UNKNOWN_ERROR) {
      if (message.startsWith('[HUB_')) {
        const match = message.match(/^\[(HUB_[A-Z_]+)\]/);
        if (match && this.ERROR_TYPES[match[1]]) {
          type = this.ERROR_TYPES[match[1]];
        }
      } else if (lowerMsg.includes('unauthorized') || lowerMsg.includes('invalid api key')) {
        type = this.ERROR_TYPES.AUTH_ERROR;
      } else if (lowerMsg.includes('forbidden') || lowerMsg.includes('permission_denied')) {
        type = this.ERROR_TYPES.PERMISSION_ERROR;
      } else if (lowerMsg.includes('rate limit') || lowerMsg.includes('resource exhausted')) {
        type = this.ERROR_TYPES.RATE_LIMIT_ERROR;
      } else if (lowerMsg.includes('internal server error') || lowerMsg.includes('service unavailable')) {
        type = this.ERROR_TYPES.PROVIDER_SERVER_ERROR;
      }
    }

    // Determine transient eligibility:
    // Transient errors: RATE_LIMIT_ERROR, TIMEOUT_ERROR, NETWORK_ERROR, PROVIDER_SERVER_ERROR
    // Fatal (non-transient) errors: AUTH_ERROR, PERMISSION_ERROR, INVALID_REQUEST, MODEL_NOT_FOUND, UNKNOWN_ERROR
    const isTransient = (
      type === this.ERROR_TYPES.RATE_LIMIT_ERROR ||
      type === this.ERROR_TYPES.TIMEOUT_ERROR ||
      type === this.ERROR_TYPES.NETWORK_ERROR ||
      type === this.ERROR_TYPES.PROVIDER_SERVER_ERROR
    );

    // Determine faultScope (Error Scope Resolver):
    let faultScope = opt.faultScope || raw.faultScope || null;
    if (!faultScope) {
      if (type === this.ERROR_TYPES.INVALID_REQUEST || type === this.ERROR_TYPES.OPERATION_CANCELLED) {
        faultScope = 'NONE';
      } else if (type === this.ERROR_TYPES.MODEL_NOT_FOUND) {
        faultScope = 'MODEL';
      } else if (type === this.ERROR_TYPES.AUTH_ERROR) {
        faultScope = 'CREDENTIAL';
      } else if (type === this.ERROR_TYPES.PERMISSION_ERROR) {
        faultScope = 'ACCOUNT';
      } else if (type === this.ERROR_TYPES.RATE_LIMIT_ERROR) {
        const lowerMsg = (message || '').toLowerCase();
        if (lowerMsg.includes('project') || lowerMsg.includes('account') || lowerMsg.includes('daily') || lowerMsg.includes('quota exceeded for project') || lowerMsg.includes('billing')) {
          faultScope = 'ACCOUNT';
        } else {
          faultScope = 'MODEL';
        }
      } else if (type === this.ERROR_TYPES.PROVIDER_SERVER_ERROR) {
        if (status === 502 || status === 504) {
          faultScope = 'PROVIDER';
        } else {
          faultScope = 'MODEL'; // 503 model overloaded
        }
      } else if (type === this.ERROR_TYPES.NETWORK_ERROR) {
        faultScope = 'PROVIDER';
      } else if (type === this.ERROR_TYPES.TIMEOUT_ERROR) {
        faultScope = 'MODEL';
      } else if (type === this.ERROR_TYPES.RESOURCE_NOT_FOUND) {
        faultScope = 'MODEL';
      } else {
        faultScope = 'UNKNOWN';
      }
    }

    return {
      type,
      provider,
      modelId,
      status,
      providerCode,
      message,
      retryAfter,
      isTransient,
      faultScope,
      cause
    };
  }

  /**
   * Creates a typed HubError instance.
   * @param {string} provider 
   * @param {Object} options 
   * @returns {HubError}
   */
  createError(provider, options = {}) {
    const classification = this.classify(provider, options, options);
    return new HubError(classification);
  }

  /**
   * Normalizes any error or exception into a HubError instance.
   * @param {any} error 
   * @param {Object} [context={}] 
   * @returns {HubError}
   */
  toHubError(error, context = {}) {
    if (error instanceof HubError) {
      if (context.modelId && !error.modelId) error.modelId = context.modelId;
      if (context.provider && error.provider === 'unknown') error.provider = context.provider;
      return error;
    }

    const provider = context.provider || (error && error.provider) || 'unknown';
    const classification = this.classify(provider, error, {
      ...context,
      cause: error instanceof Error ? error : (context.cause || null),
      message: (error && error.message) || String(error)
    });

    return new HubError(classification);
  }

  /**
   * Legacy mapping method returning the string error type.
   * Preserves full backward-compatibility with existing code.
   * @param {string} provider 
   * @param {Object} error 
   * @returns {string}
   */
  map(provider, error) {
    return this.classify(provider, error).type;
  }

  /**
   * Checks whether the error is transient and can be retried.
   * @param {HubError|Object|string} errorOrType 
   * @returns {boolean}
   */
  isTransient(errorOrType) {
    if (!errorOrType) return false;
    if (typeof errorOrType === 'object' && errorOrType.isTransient !== undefined) {
      return Boolean(errorOrType.isTransient);
    }
    const type = typeof errorOrType === 'string' ? errorOrType : errorOrType.type;
    return (
      type === this.ERROR_TYPES.RATE_LIMIT_ERROR ||
      type === this.ERROR_TYPES.TIMEOUT_ERROR ||
      type === this.ERROR_TYPES.NETWORK_ERROR ||
      type === this.ERROR_TYPES.PROVIDER_SERVER_ERROR
    );
  }

  /**
   * Checks whether in-place retry should be attempted.
   * Rejects AUTH_ERROR, PERMISSION_ERROR, INVALID_REQUEST, MODEL_NOT_FOUND, UNKNOWN_ERROR, OPERATION_CANCELLED.
   * @param {HubError|Object|string} errorOrType 
   * @returns {boolean}
   */
  shouldRetry(errorOrType) {
    if (errorOrType && (errorOrType.type === this.ERROR_TYPES.OPERATION_CANCELLED || errorOrType === this.ERROR_TYPES.OPERATION_CANCELLED)) {
      return false;
    }
    return this.isTransient(errorOrType);
  }

  /**
   * Creates a structured cascading error instance.
   * @param {Object} options
   * @returns {HubCascadingError}
   */
  createCascadingError(options = {}) {
    return new HubCascadingError(options);
  }
}

const defaultMapper = new UnifiedErrorMapper();
defaultMapper.HubError = HubError;
defaultMapper.HubCascadingError = HubCascadingError;

module.exports = defaultMapper;
module.exports.HubError = HubError;
module.exports.HubCascadingError = HubCascadingError;
