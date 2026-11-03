const modelRegistry = require('../registry/model_registry');
const quotaGuard = require('../infrastructure/adapters/quota_guard');

/**
 * CapabilityAwareRouter
 * Intelligently routes tasks to the best model based on requirements and real-time status.
 */
class CapabilityAwareRouter {
  /**
   * Routes a task to a model.
   * @param {Object} requirements - { modalities: [], minContext: number, preferredTier: string }
   * @returns {Object} Selected ModelCapabilitySchema
   */
  /**
   * Calculates a task complexity score to determine optimal model tier.
   * @param {Object} context 
   * @returns {string} 'low' | 'medium' | 'high' | 'ultra'
   */
  calculateComplexityScore(context = {}) {
    const text = ((context.objective || '') + ' ' + (context.constraints || []).join(' ')).toLowerCase();
    const len = text.length;

    const highComplexityKeywords = ['architecture', 'refactor', 'security', 'audit', 'database', 'qdrant', 'compiler', 'benchmark', 'ast', 'concurrency', 'deadlock'];
    const lowComplexityKeywords = ['greeting', 'format', 'schema', 'hello', 'cleanup', 'simple', 'trim', 'parse', 'ping'];

    const hasHighKeywords = highComplexityKeywords.some(k => text.includes(k));
    const hasLowKeywords = lowComplexityKeywords.some(k => text.includes(k));

    if (hasHighKeywords || len > 1500) {
      console.log(`[Router] 🧠 Adaptive Routing: High Complexity Task detected (len: ${len}, keywords match). Routing to High/Ultra tier.`);
      return 'high';
    } else if (hasLowKeywords && len < 300) {
      console.log(`[Router] ⚡ Adaptive Routing: Low Complexity Task detected (len: ${len}). Routing to Fast/Low tier.`);
      return 'medium';
    }

    return 'high';
  }

  /**
   * Internal helper to determine candidate eligibility across Quota and Health Registry.
   * Pure read query: does NOT consume quota or mutate state.
   * @private
   */
  _isEligibleCandidate(m, heartbeatRegistry) {
    const quotaOk = quotaGuard.canProceed(m.provider, m.limits);
    const healthOk = typeof heartbeatRegistry.isCandidateEligible === 'function'
      ? heartbeatRegistry.isCandidateEligible(m.provider, m.model_id)
      : heartbeatRegistry.isHealthy(m.provider, m.model_id);
    return quotaOk && healthOk;
  }

  /**
   * Routes a task to a model.
   * @param {Object} requirements - { modalities: [], minContext: number, preferredTier: string, context: Object }
   * @returns {Object} Selected ModelCapabilitySchema
   */
  route(requirements = {}) {
    let { modalities = ["text"], minContext = 0, preferredTier, context } = requirements;

    // Apply Adaptive Effort Routing if preferredTier not explicitly set
    if (!preferredTier && context) {
      preferredTier = this.calculateComplexityScore(context);
    } else if (!preferredTier) {
      preferredTier = 'high';
    }

    // 1. Filter by mandatory capabilities
    let candidates = modelRegistry.getModelsByCapability(modalities)
      .filter(m => m.context_window >= minContext);

    if (candidates.length === 0) {
      throw new Error("[Router] No model found matching the required capabilities.");
    }

    // 2. Filter by Quota Availability & Heartbeat Status
    const heartbeatRegistry = require('../registry/heartbeat_registry');
    
    candidates = candidates.filter(m => this._isEligibleCandidate(m, heartbeatRegistry));

    // If all are degraded, try to use them anyway as a last resort (Level 1 Fallback)
    if (candidates.length === 0) {
      console.warn("[Router] All primary models are degraded or rate-limited. Retrying with full registry...");
      candidates = modelRegistry.getModelsByCapability(modalities)
        .filter(m => quotaGuard.canProceed(m.provider, m.limits));
    }

    if (candidates.length === 0) {
      throw new Error("[Router] Critical Error: No healthy or quota-available models found.");
    }

    // 3. Score candidates (Tier match + Latency consideration)
    candidates.sort((a, b) => {
      const tiers = { ultra: 4, high: 3, medium: 2, low: 1 };
      
      // First priority: Tier match
      if (a.performance_tier === preferredTier && b.performance_tier !== preferredTier) return -1;
      if (b.performance_tier === preferredTier && a.performance_tier !== preferredTier) return 1;
      
      // Second priority: Performance Tier comparison
      const tierDiff = tiers[b.performance_tier] - tiers[a.performance_tier];
      if (tierDiff !== 0) return tierDiff;
      
      // Third priority: Average Latency (Lower is better)
      return heartbeatRegistry.getAverageLatency(a.provider) - heartbeatRegistry.getAverageLatency(b.provider);
    });

    const selected = candidates[0];
    console.log(`[Router] Task routed to: ${selected.model_id} (${selected.provider}, Tier: ${selected.performance_tier})`);
    return selected;
  }

  /**
   * Returns a sorted list of candidate models for a task.
   * Useful for CascadingExecutor to handle failovers.
   */
  getCandidates(requirements = {}) {
    const { modalities = ["text"], minContext = 0, preferredTier = "high" } = requirements;
    const heartbeatRegistry = require('../registry/heartbeat_registry');

    // 1. All capable models filtered by candidate eligibility (Quota + Health)
    let candidates = modelRegistry.getModelsByCapability(modalities)
      .filter(m => m.context_window >= minContext)
      .filter(m => this._isEligibleCandidate(m, heartbeatRegistry));

    // Fallback: If all primary candidates are degraded, allow capable models with available quota as fallback
    if (candidates.length === 0) {
      candidates = modelRegistry.getModelsByCapability(modalities)
        .filter(m => m.context_window >= minContext)
        .filter(m => quotaGuard.canProceed(m.provider, m.limits));
    }

    // 2. Sort them (Tier match -> Tier level -> Latency)
    candidates.sort((a, b) => {
      const tiers = { ultra: 4, high: 3, medium: 2, low: 1 };
      
      // Tier match
      if (a.performance_tier === preferredTier && b.performance_tier !== preferredTier) return -1;
      if (b.performance_tier === preferredTier && a.performance_tier !== preferredTier) return 1;
      
      // Tier level
      const tierDiff = tiers[b.performance_tier] - tiers[a.performance_tier];
      if (tierDiff !== 0) return tierDiff;
      
      // Latency
      return heartbeatRegistry.getAverageLatency(a.provider) - heartbeatRegistry.getAverageLatency(b.provider);
    });

    return candidates;
  }
}

module.exports = new CapabilityAwareRouter();
