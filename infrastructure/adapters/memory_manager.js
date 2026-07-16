const crypto = require('crypto');

/**
 * MemoryManager
 * Phase 3 Vector Memory Layer.
 * Interacts with Qdrant vector database to store and retrieve successful issue-diff/task-result pairs.
 */
class MemoryManager {
  constructor() {
    this.qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    this.collectionName = 'global_shared_memory';
  }

  /**
   * Generates a 768-dimension embedding for the given text using Google AI Studio's gemini-embedding-001 model.
   * @param {string} text 
   * @returns {Promise<Array<number>>}
   */
  async getEmbedding(text) {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required for AI Studio embedding generation.");
    }

    let url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`;

    // Route through Headroom Proxy if enabled
    const useProxy = process.env.USE_HEADROOM_PROXY === 'true';
    const proxyUrl = process.env.HEADROOM_PROXY_URL || 'http://localhost:8787';
    let headers = {
      "Content-Type": "application/json"
    };

    if (useProxy) {
      const parsed = new URL(url);
      const originalBase = parsed.origin;
      url = `${proxyUrl.replace(/\/$/, '')}${parsed.pathname}${parsed.search}`;
      headers['x-headroom-base-url'] = originalBase;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: {
          parts: [{ text: text }]
        }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`AI Studio embedding generation failed: ${err}`);
    }

    const data = await response.json();
    if (!data.embedding || !data.embedding.values) {
      throw new Error(`Invalid AI Studio embedding response: ${JSON.stringify(data)}`);
    }

    return data.embedding.values;
  }

  /**
   * Initializes the 'global_shared_memory' collection in Qdrant if it doesn't already exist.
   */
  async initCollection() {
    try {
      const checkRes = await fetch(`${this.qdrantUrl}/collections/${this.collectionName}`);
      if (checkRes.ok) {
        return; // Already exists
      }
    } catch (e) {
      console.warn(`[MemoryManager] Qdrant connection check failed: ${e.message}`);
      return;
    }

    console.log(`🧠 [MemoryManager] Creating '${this.collectionName}' collection in Qdrant...`);
    try {
      const createRes = await fetch(`${this.qdrantUrl}/collections/${this.collectionName}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vectors: {
            size: 768,
            distance: 'Cosine'
          }
        })
      });
      if (createRes.ok) {
        console.log(`✅ [MemoryManager] Collection '${this.collectionName}' created successfully.`);
      } else {
        const txt = await createRes.text();
        console.error(`❌ [MemoryManager] Failed to create collection: ${txt}`);
      }
    } catch (e) {
      console.error(`❌ [MemoryManager] Error during collection initialization: ${e.message}`);
    }
  }

  /**
   * Searches Qdrant for a past execution of a similar task objective.
   * @param {string} objective - The task objective text.
   * @param {number} [threshold=0.95] - The similarity threshold (Cosine).
   * @returns {Promise<Object|null>} The cached task result, or null if miss.
   */
  async searchMemory(objective, threshold = 0.95) {
    await this.initCollection();

    try {
      const embedding = await this.getEmbedding(objective);
      const searchRes = await fetch(`${this.qdrantUrl}/collections/${this.collectionName}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vector: embedding,
          limit: 1,
          with_payload: true
        })
      });

      if (!searchRes.ok) {
        return null;
      }

      const searchData = await searchRes.json();
      const results = searchData.result || [];
      if (results.length > 0) {
        const match = results[0];
        if (match.score >= threshold) {
          // Check TTL expiration
          const ttlDays = parseInt(process.env.MEMORY_TTL_DAYS || '7');
          const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
          const ageMs = Date.now() - (match.payload.timestamp || 0);
          if (ageMs > ttlMs) {
            console.log(`ℹ️ [MemoryManager] Memory match found (score ${(match.score * 100).toFixed(1)}%), but expired (age: ${(ageMs / (24 * 60 * 60 * 1000)).toFixed(1)} days, limit: ${ttlDays} days)`);
            return null;
          }

          console.log(`🎯 [MemoryManager] Memory HIT! Found past successful execution with similarity ${(match.score * 100).toFixed(1)}%`);
          return {
            score: match.score,
            result: match.payload.result
          };
        } else {
          console.log(`ℹ️ [MemoryManager] Memory match found, but score ${(match.score * 100).toFixed(1)}% is below threshold ${(threshold * 100).toFixed(1)}%`);
        }
      }
    } catch (e) {
      console.warn(`⚠️ [MemoryManager] Search memory failed: ${e.message}`);
    }
    return null;
  }

  /**
   * Saves a successful task execution result in Qdrant memory.
   * @param {string} objective - The task objective.
   * @param {Object} result - The successful execution JSON output.
   */
  async saveMemory(objective, result) {
    await this.initCollection();

    try {
      const embedding = await this.getEmbedding(objective);
      const hash = crypto.createHash('md5').update(objective).digest('hex');
      // Format as MD5 UUID compatible string for Qdrant compatibility
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;

      const upsertRes = await fetch(`${this.qdrantUrl}/collections/${this.collectionName}/points`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: [
            {
              id,
              vector: embedding,
              payload: {
                objective,
                result,
                timestamp: Date.now()
              }
            }
          ]
        })
      });

      if (upsertRes.ok) {
        console.log(`💾 [MemoryManager] Cached successful task execution to Qdrant memory.`);
        // 非同步觸發主動代謝，不阻塞寫入主線程
        this.pruneExpiredMemory().catch(err => console.warn(`⚠️ [MemoryManager] Async prune error: ${err.message}`));
      } else {
        const txt = await upsertRes.text();
        console.warn(`⚠️ [MemoryManager] Failed to save memory to Qdrant: ${txt}`);
      }
    } catch (e) {
      console.warn(`⚠️ [MemoryManager] Save memory failed: ${e.message}`);
    }
  }

  /**
   * Active Pruning: Physcially deletes points from Qdrant where payload.timestamp is older than TTL.
   */
  async pruneExpiredMemory() {
    const ttlDays = parseInt(process.env.MEMORY_TTL_DAYS || '7', 10);
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    const expirationThreshold = Date.now() - ttlMs;

    console.log(`🧹 [MemoryManager] Running Qdrant Active Pruning (TTL: ${ttlDays} days)...`);
    try {
      const pruneRes = await fetch(`${this.qdrantUrl}/collections/${this.collectionName}/points/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter: {
            must: [
              {
                key: 'timestamp',
                range: {
                  lt: expirationThreshold
                }
              }
            ]
          }
        })
      });

      if (pruneRes.ok) {
        const resJson = await pruneRes.json();
        console.log(`✅ [MemoryManager] Qdrant Active Pruning completed. Result: ${JSON.stringify(resJson.result)}`);
      } else {
        const txt = await pruneRes.text();
        console.warn(`⚠️ [MemoryManager] Active Pruning failed: ${txt}`);
      }
    } catch (e) {
      console.warn(`⚠️ [MemoryManager] Active Pruning connection failed: ${e.message}`);
    }
  }
}

module.exports = new MemoryManager();
