const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * SemanticCache
 * Zero-Token LLM Bypass Engine.
 * Caches model outputs based on deterministic payload hashing and semantic similarity.
 */
class SemanticCache {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir || path.join(__dirname, '../.cache');
    this.cacheFile = path.join(this.cacheDir, 'semantic_cache.json');
    this.cache = new Map();
    this.maxEntries = options.maxEntries || 500;
    this._loadCache();
  }

  _loadCache() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      if (fs.existsSync(this.cacheFile)) {
        const raw = fs.readFileSync(this.cacheFile, 'utf-8');
        const entries = JSON.parse(raw);
        for (const [key, value] of entries) {
          this.cache.set(key, value);
        }
      }
    } catch (e) {
      console.warn('[SemanticCache] Failed to load disk cache:', e.message);
    }
  }

  _saveCache() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      const entries = Array.from(this.cache.entries()).slice(-this.maxEntries);
      fs.writeFileSync(this.cacheFile, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[SemanticCache] Failed to persist cache:', e.message);
    }
  }

  generateKey(payload, outputSchema) {
    const normPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const normSchema = typeof outputSchema === 'string' ? outputSchema : JSON.stringify(outputSchema || {});
    return crypto.createHash('sha256').update(normPayload + '::' + normSchema).digest('hex');
  }

  get(payload, outputSchema) {
    const key = this.generateKey(payload, outputSchema);
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      console.log(`[SemanticCache] ⚡ 100% LLM BYPASS HIT! Key: ${key.slice(0, 8)}... (0 Tokens / Instant)`);
      return {
        hit: true,
        data: entry.data,
        savedTokens: entry.savedTokens || 1000,
        timestamp: entry.timestamp
      };
    }

    // Secondary Check: Similarity Match on Payload Text
    const normPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const [ckey, entry] of this.cache.entries()) {
      if (entry.normPayload && this._calculateSimilarity(normPayload, entry.normPayload) >= 0.995) {
        console.log(`[SemanticCache] ⚡ SEMANTIC MATCH LLM BYPASS HIT (99.5%+ Similarity)! Key: ${ckey.slice(0, 8)}...`);
        return {
          hit: true,
          data: entry.data,
          savedTokens: entry.savedTokens || 1000,
          timestamp: entry.timestamp
        };
      }
    }

    return { hit: false };
  }

  set(payload, outputSchema, data) {
    const key = this.generateKey(payload, outputSchema);
    const normPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const estimatedTokens = Math.ceil((normPayload.length + JSON.stringify(data).length) / 4);

    const entry = {
      data,
      normPayload,
      savedTokens: estimatedTokens,
      timestamp: Date.now()
    };

    this.cache.set(key, entry);
    if (this.cache.size > this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this._saveCache();
  }

  _calculateSimilarity(str1, str2) {
    if (str1 === str2) return 1.0;
    const len1 = str1.length;
    const len2 = str2.length;
    if (Math.abs(len1 - len2) / Math.max(len1, len2) > 0.05) return 0;
    
    // Jaccard similarity of 3-gram character sets
    const set1 = new Set();
    const set2 = new Set();
    for (let i = 0; i < str1.length - 2; i += 2) set1.add(str1.slice(i, i + 3));
    for (let i = 0; i < str2.length - 2; i += 2) set2.add(str2.slice(i, i + 3));
    
    let intersection = 0;
    for (const elem of set1) {
      if (set2.has(elem)) intersection++;
    }
    const union = set1.size + set2.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}

module.exports = SemanticCache;
