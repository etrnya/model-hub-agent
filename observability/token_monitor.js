/**
 * TokenMonitor 2.0
 * Tracks usage per provider and monitors free tier quotas.
 */
class TokenMonitor {
  constructor() {
    this.history = [];
    this.totalSessionCost = 0;
    this.usageByProvider = {
      'nvidia-nim': { used: 0, saved: 0, limit: 1000000, cost: 0 },
      'google': { used: 0, saved: 0, limit: 1000000, cost: 0 },
      'vertex-ai': { used: 0, saved: 0, limit: 1000000, cost: 0 },
      'deepseek': { used: 0, saved: 0, limit: 500000, cost: 0 }
    };
  }

  /**
   * Records an execution event.
   * @param {Object|string} capability - Model capability object or provider string
   */
  record(capability, rawInputCount, actualInputCount, outputCount) {
    const isObj = capability && typeof capability === 'object';
    const provider = isObj ? capability.provider : capability;
    const providerKey = provider.toLowerCase();
    
    const saved = Math.max(0, rawInputCount - actualInputCount);
    const totalCurrentUsed = actualInputCount + outputCount;

    if (!this.usageByProvider[providerKey]) {
      this.usageByProvider[providerKey] = { used: 0, saved: 0, limit: 0, cost: 0 };
    }

    // 計算費用 (USD)
    let inputCostRate = 0;
    let outputCostRate = 0;
    if (isObj) {
      inputCostRate = capability.input_cost_per_1k || 0;
      outputCostRate = capability.output_cost_per_1k || 0;
    } else if (providerKey === 'memory-cache') {
      inputCostRate = 0;
      outputCostRate = 0;
    }

    const inputCost = (actualInputCount / 1000) * inputCostRate;
    const outputCost = (outputCount / 1000) * outputCostRate;
    const cost = inputCost + outputCost;

    this.usageByProvider[providerKey].used += totalCurrentUsed;
    this.usageByProvider[providerKey].saved += saved;
    this.usageByProvider[providerKey].cost += cost;
    this.totalSessionCost += cost;

    const limit = this.usageByProvider[providerKey].limit;
    const quotaUsedPercent = limit > 0 ? (this.usageByProvider[providerKey].used / limit * 100).toFixed(2) : '0.00';

    const event = {
      timestamp: new Date().toISOString(),
      provider: providerKey,
      model_id: isObj ? capability.model_id : providerKey,
      totalUsed: totalCurrentUsed,
      saved: saved,
      cost: cost,
      quotaUsed: quotaUsedPercent + '%'
    };

    this.history.push(event);

    // 預警機制
    if (limit > 0 && parseFloat(quotaUsedPercent) > 90) {
      console.warn(`\n🚨 [QUOTA ALERT] ${providerKey.toUpperCase()} 已使用 ${event.quotaUsed} 的額度，請注意！`);
    }

    // 發送即時觀測事件
    const globalEmitter = require('../shared/global_emitter');
    globalEmitter.emit('token-record', event);

    return event;
  }

  getSummary() {
    const summary = {};
    Object.keys(this.usageByProvider).forEach(p => {
      const limit = this.usageByProvider[p].limit;
      summary[p.toUpperCase()] = {
        "已用 Token": this.usageByProvider[p].used,
        "省下 Token": this.usageByProvider[p].saved,
        "花費 (USD)": `$${(this.usageByProvider[p].cost || 0).toFixed(6)}`,
        "額度使用率": limit > 0 ? ((this.usageByProvider[p].used / limit) * 100).toFixed(2) + '%' : '0.00%'
      };
    });
    return summary;
  }

  display() {
    console.log("\n📊 [各供應商使用量與費用監測儀表板]");
    console.table(this.getSummary());
    console.log(`💵 [Session 總花費]: $${this.totalSessionCost.toFixed(6)} USD`);
  }
}

module.exports = new TokenMonitor();
