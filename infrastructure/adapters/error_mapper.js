/**
 * UnifiedErrorMapper
 * Maps provider-specific error codes (NVIDIA, Google, DeepSeek) to standard internal exceptions.
 */
class UnifiedErrorMapper {
  constructor() {
    this.ERROR_TYPES = {
      HUB_RATE_LIMIT: 'HUB_RATE_LIMIT',
      HUB_POLICY_VIOLATION: 'HUB_POLICY_VIOLATION',
      HUB_CONTEXT_OVERFLOW: 'HUB_CONTEXT_OVERFLOW',
      HUB_AUTH_ERROR: 'HUB_AUTH_ERROR',
      HUB_INTERNAL_ERROR: 'HUB_INTERNAL_ERROR',
      HUB_UNKNOWN_ERROR: 'HUB_UNKNOWN_ERROR'
    };
  }

  /**
   * Normalizes an error from an external provider.
   * @param {string} provider - 'google', 'deepseek', 'nvidia-nim'
   * @param {Object} error - The original error object or response.
   */
  map(provider, error) {
    const status = error.status || error.code;
    const message = error.message || "";

    switch (provider) {
      case 'google':
        if (status === 429) return this.ERROR_TYPES.HUB_RATE_LIMIT;
        if (message.includes("safety")) return this.ERROR_TYPES.HUB_POLICY_VIOLATION;
        break;

      case 'deepseek':
        if (status === 429) return this.ERROR_TYPES.HUB_RATE_LIMIT;
        if (status === 400 && message.includes("context")) return this.ERROR_TYPES.HUB_CONTEXT_OVERFLOW;
        break;

      case 'nvidia-nim':
        if (status === 429) return this.ERROR_TYPES.HUB_RATE_LIMIT;
        if (status === 401) return this.ERROR_TYPES.HUB_AUTH_ERROR;
        break;
    }

    return this.ERROR_TYPES.HUB_UNKNOWN_ERROR;
  }
}

module.exports = new UnifiedErrorMapper();
