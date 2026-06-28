/**
 * ContextCompressor
 * Handles token-aware context reduction when switching models.
 */
class ContextCompressor {
  constructor(options = {}) {
    this.tokenEstimator = options.tokenEstimator || ((text) => text.length / 4); // Rough estimate
  }

  /**
   * Compresses context to fit within the target model's limits.
   * @param {Object} state - Current GlobalState
   * @param {Object} targetCapability - Target model's ModelCapabilitySchema
   */
  async compress(state, targetCapability) {
    const limit = targetCapability.context_window;
    const stateString = JSON.stringify(state);
    const currentTokens = this.tokenEstimator(stateString);

    if (currentTokens <= limit * 0.85) {
      return state; // No compression needed (with 15% safety margin)
    }

    console.log(`\n🗜️  [ContextCompressor] State size (${currentTokens}) exceeds limit (${limit}). Starting Key-Insight Anchoring...`);

    // 1. Key-Insight Anchoring: Identify immutable fields
    const anchors = {
      objective: state.objective,
      constraints: state.constraints,
      task_id: state.task_id,
      version: state.version,
      code_context: state.code_context
    };

    // 2. Identify flexible data to be compressed/summarized
    const flexibleData = { ...state };
    Object.keys(anchors).forEach(key => delete flexibleData[key]);

    // 3. Strategic Pruning & Summarization
    const compressedFlexible = this._applyCompressionStrategy(flexibleData, limit - this.tokenEstimator(JSON.stringify(anchors)));

    // 4. Reconstruct state
    let result = {
      ...anchors,
      ...compressedFlexible,
      compression_metadata: {
        original_size: currentTokens,
        compressed_at: new Date().toISOString(),
        strategy: "Key-Insight Anchoring"
      }
    };

    // 5. Hard Truncation Fallback: If still over limit, drop everything except anchors
    const finalSize = this.tokenEstimator(JSON.stringify(result));
    if (finalSize > limit) {
      console.warn(`⚠️  [ContextCompressor] Still over limit (${finalSize} > ${limit}). Activating Hard Truncation.`);
      result = {
        ...anchors,
        compression_metadata: {
          original_size: currentTokens,
          compressed_at: new Date().toISOString(),
          strategy: "Hard Truncation (Anchors Only)"
        },
        _warning: "Non-critical data lost due to severe context overflow."
      };
    }

    console.log(`✅ [ContextCompressor] Compression complete. New size: ${this.tokenEstimator(JSON.stringify(result))} tokens.`);
    
    // Record to monitor
    const tokenMonitor = require('../../observability/token_monitor');
    const provider = (targetCapability && targetCapability.provider) || 'system';
    tokenMonitor.record(provider, currentTokens, this.tokenEstimator(JSON.stringify(result)), 0); 

    return result;
  }

  /**
   * Applies tiered compression strategies to flexible data.
   */
  _applyCompressionStrategy(data, remainingBudget) {
    const processed = { ...data };

    // Strategy A: Summarize Change Log (Historical Steps)
    if (processed.change_log && processed.change_log.length > 2) {
      console.log(`   [Strategy] Summarizing change_log (${processed.change_log.length} steps -> 2 steps + Summary)`);
      const keyInsights = processed.change_log.map(step => {
        return `Version ${step.version}: Changed [${step.changedFields?.join(', ') || 'N/A'}]`;
      });
      
      processed.historical_insights = keyInsights.slice(0, -2); // Archive older steps
      processed.change_log = processed.change_log.slice(-2);     // Keep only the 2 most recent steps
    }

    // Strategy B: Truncate large data fields (e.g., debug logs, large raw outputs)
    const largeFieldThreshold = 1000; // chars
    Object.keys(processed).forEach(key => {
      if (typeof processed[key] === 'string' && processed[key].length > largeFieldThreshold) {
        if (key !== 'python_code' && key !== 'result') { // Don't truncate code or results
           console.log(`   [Strategy] Truncating large field: ${key}`);
           processed[key] = processed[key].substring(0, largeFieldThreshold) + "... [Truncated by Compressor]";
        }
      }
    });

    // Strategy C: Drop non-essential metadata
    delete processed.internal_trace;
    delete processed.raw_provider_response;

    return processed;
  }
}

module.exports = ContextCompressor;
