/**
 * QuotaGuard
 * Real-time monitoring of API rate limits (RPM/TPM) to prevent cascading failures.
 */
class QuotaGuard {
  constructor() {
    this.usage = new Map(); // Map<provider, { windowStart, requests, tokens }>
  }

  /**
   * Checks if the provider has enough remaining quota.
   * @param {string} provider 
   * @param {Object} limits - { rpm, tpm } from ModelCapabilitySchema
   * @returns {boolean}
   */
  canProceed(provider, limits) {
    const now = Date.now();
    const stats = this.usage.get(provider) || this._resetWindow(provider, now);

    // Reset window if 1 minute has passed
    if (now - stats.windowStart > 60000) {
      this._resetWindow(provider, now);
      return true;
    }

    if (stats.requests >= limits.rpm) {
      console.warn(`[QuotaGuard] RPM limit reached for ${provider}.`);
      return false;
    }

    return true;
  }

  /**
   * Records usage after a successful API call.
   * @param {string} provider 
   * @param {number} tokensUsed 
   */
  recordUsage(provider, tokensUsed) {
    const stats = this.usage.get(provider);
    if (stats) {
      stats.requests += 1;
      stats.tokens += tokensUsed;
    }
  }

  _resetWindow(provider, now) {
    const newStats = { windowStart: now, requests: 0, tokens: 0 };
    this.usage.set(provider, newStats);
    return newStats;
  }
}

module.exports = new QuotaGuard(); // Singleton for system-wide tracking
