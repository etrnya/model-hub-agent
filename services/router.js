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
  route(requirements = {}) {
    const { modalities = ["text"], minContext = 0, preferredTier = "high" } = requirements;

    // 1. Filter by mandatory capabilities
    let candidates = modelRegistry.getModelsByCapability(modalities)
      .filter(m => m.context_window >= minContext);

    if (candidates.length === 0) {
      throw new Error("[Router] No model found matching the required capabilities.");
    }

    // 2. Filter by Quota Availability & Heartbeat Status
    const heartbeatRegistry = require('../registry/heartbeat_registry');
    
    candidates = candidates.filter(m => {
      const quotaOk = quotaGuard.canProceed(m.provider, m.limits);
      const status = heartbeatRegistry.getStatus(m.provider);
      // Avoid providers that are explicitly degraded if we have other options
      return quotaOk && status !== 'degraded';
    });

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
    console.log(`[Router] Task routed to: ${selected.model_id} (${selected.provider})`);
    return selected;
  }

  /**
   * Returns a sorted list of candidate models for a task.
   * Useful for CascadingExecutor to handle failovers.
   */
  getCandidates(requirements = {}) {
    const { modalities = ["text"], minContext = 0, preferredTier = "high" } = requirements;
    const heartbeatRegistry = require('../registry/heartbeat_registry');

    // 1. All capable models
    let candidates = modelRegistry.getModelsByCapability(modalities)
      .filter(m => m.context_window >= minContext);

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
