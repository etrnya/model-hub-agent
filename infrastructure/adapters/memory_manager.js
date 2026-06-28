const crypto = require('crypto');

/**
 * MemoryManager
 * Phase 3 Vector Memory Layer.
 * Interacts with Qdrant vector database to store and retrieve successful issue-diff/task-result pairs.
 */
class MemoryManager {
  constructor() {
    this.qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
  }

  /**
   * Generates a 768-dimension embedding for the given text using Google's text-embedding-004 model.
   * @param {string} text 
   * @returns {Promise<Array<number>>}
   */
  async getEmbedding(text) {
    const fs = require('fs');
    const gcpKeyPath = process.env.GCP_KEY_PATH;

    if (!gcpKeyPath) {
      throw new Error("GCP_KEY_PATH is required for Vertex AI embedding generation.");
    }

    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
      keyFile: gcpKeyPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse.token;

    const keyData = JSON.parse(fs.readFileSync(gcpKeyPath, 'utf8'));
    const projectId = keyData.project_id;
    const location = 'us-central1';

    let url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/text-embedding-004:predict`;

    // Route through Headroom Proxy if enabled
    const useProxy = process.env.USE_HEADROOM_PROXY === 'true';
    const proxyUrl = process.env.HEADROOM_PROXY_URL || 'http://localhost:8787';
    let headers = {
      "Authorization": `Bearer ${token}`,
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
        instances: [
          { content: text }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Vertex AI embedding generation failed: ${err}`);
    }

    const data = await response.json();
    if (!data.predictions || data.predictions.length === 0 || !data.predictions[0].embeddings) {
      throw new Error(`Invalid Vertex AI embedding response: ${JSON.stringify(data)}`);
    }

    return data.predictions[0].embeddings.values;
  }

  /**
   * Initializes the 'task_memory' collection in Qdrant if it doesn't already exist.
   */
  async initCollection() {
    try {
      const checkRes = await fetch(`${this.qdrantUrl}/collections/task_memory`);
      if (checkRes.ok) {
        return; // Already exists
      }
    } catch (e) {
      console.warn(`[MemoryManager] Qdrant connection check failed: ${e.message}`);
      return;
    }

    console.log(`🧠 [MemoryManager] Creating 'task_memory' collection in Qdrant...`);
    try {
      const createRes = await fetch(`${this.qdrantUrl}/collections/task_memory`, {
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
        console.log(`✅ [MemoryManager] Collection 'task_memory' created successfully.`);
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
      const searchRes = await fetch(`${this.qdrantUrl}/collections/task_memory/points/search`, {
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
          console.log(`🎯 [MemoryManager] Memory HIT! Found past successful execution with similarity ${(match.score * 100).toFixed(1)}%`);
          return match.payload.result;
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

      const upsertRes = await fetch(`${this.qdrantUrl}/collections/task_memory/points`, {
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
      } else {
        const txt = await upsertRes.text();
        console.warn(`⚠️ [MemoryManager] Failed to save memory to Qdrant: ${txt}`);
      }
    } catch (e) {
      console.warn(`⚠️ [MemoryManager] Save memory failed: ${e.message}`);
    }
  }
}

module.exports = new MemoryManager();
