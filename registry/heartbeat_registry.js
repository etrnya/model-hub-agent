/**
 * HeartbeatRegistry
 * Monitors the health and performance of API endpoints in real-time.
 * Tracks response time (latency) and success/failure rates.
 */
class HeartbeatRegistry {
  constructor() {
    this.history = new Map(); // Map<provider, { latency: number[], lastStatus: string, lastSeen: number }>
    this.MAX_HISTORY = 10;
  }

  /**
   * Records a heartbeat for a specific provider.
   * @param {string} provider 
   * @param {number} latency - Response time in ms.
   * @param {boolean} success 
   */
  record(provider, latency, success) {
    const stats = this.history.get(provider) || { latency: [], lastStatus: 'unknown', lastSeen: 0 };
    
    stats.latency.push(latency);
    if (stats.latency.length > this.MAX_HISTORY) {
      stats.latency.shift();
    }
    
    stats.lastStatus = success ? 'healthy' : 'degraded';
    stats.lastSeen = Date.now();
    
    this.history.set(provider, stats);
  }

  /**
   * Returns the average latency for a provider.
   * @param {string} provider 
   */
  getAverageLatency(provider) {
    const stats = this.history.get(provider);
    if (!stats || stats.latency.length === 0) return 0;
    const sum = stats.latency.reduce((a, b) => a + b, 0);
    return sum / stats.latency.length;
  }

  /**
   * Returns the health status of a provider.
   * @param {string} provider 
   */
  getStatus(provider) {
    const stats = this.history.get(provider);
    if (!stats) return 'unknown';
    
    // If not seen for more than 5 minutes, consider it unknown
    if (Date.now() - stats.lastSeen > 300000) {
      return 'stale';
    }
    
    return stats.lastStatus;
  }

  /**
   * Returns all provider stats for the router.
   */
  getAllStats() {
    const all = {};
    for (const [provider, stats] of this.history.entries()) {
      all[provider] = {
        status: this.getStatus(provider),
        avgLatency: this.getAverageLatency(provider)
      };
    }
    return all;
  }
}

module.exports = new HeartbeatRegistry();
