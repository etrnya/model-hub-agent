/**
 * TokenMonitor 2.0
 * Tracks usage per provider and monitors free tier quotas.
 */
class TokenMonitor {
  constructor() {
    this.history = [];
    this.usageByProvider = {
      'nvidia': { used: 0, saved: 0, limit: 1000000 }, // 假設 1M tokens 免費額度
      'google': { used: 0, saved: 0, limit: 1000000 },
      'deepseek': { used: 0, saved: 0, limit: 500000 }
    };
  }

  /**
   * Records an execution event.
   */
  record(provider, rawInputCount, actualInputCount, outputCount) {
    const providerKey = provider.toLowerCase();
    const saved = Math.max(0, rawInputCount - actualInputCount);
    const totalCurrentUsed = actualInputCount + outputCount;

    if (!this.usageByProvider[providerKey]) {
      this.usageByProvider[providerKey] = { used: 0, saved: 0, limit: 0 };
    }

    this.usageByProvider[providerKey].used += totalCurrentUsed;
    this.usageByProvider[providerKey].saved += saved;

    const limit = this.usageByProvider[providerKey].limit;
    const quotaUsedPercent = limit > 0 ? (this.usageByProvider[providerKey].used / limit * 100).toFixed(2) : '0.00';

    const event = {
      timestamp: new Date().toISOString(),
      provider: providerKey,
      totalUsed: totalCurrentUsed,
      saved: saved,
      quotaUsed: quotaUsedPercent + '%'
    };

    this.history.push(event);

    // 預警機制
    if (limit > 0 && parseFloat(quotaUsedPercent) > 90) {
      console.warn(`\n🚨 [QUOTA ALERT] ${providerKey.toUpperCase()} 已使用 ${event.quotaUsed} 的額度，請注意！`);
    }

    return event;
  }

  getSummary() {
    const summary = {};
    Object.keys(this.usageByProvider).forEach(p => {
      const limit = this.usageByProvider[p].limit;
      summary[p.toUpperCase()] = {
        "已用 Token": this.usageByProvider[p].used,
        "省下 Token": this.usageByProvider[p].saved,
        "額度使用率": limit > 0 ? ((this.usageByProvider[p].used / limit) * 100).toFixed(2) + '%' : '0.00%'
      };
    });
    return summary;
  }

  display() {
    console.log("\n📊 [各供應商使用量監測儀表板]");
    console.table(this.getSummary());
  }
}

module.exports = new TokenMonitor();
