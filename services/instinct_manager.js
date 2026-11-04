const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Helper to compute cosine similarity between two vectors.
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * InstinctManager 2.0
 * ECC-inspired Continuous Learning & Global Instincts Evolution.
 * Stores insights globally at ~/.claude/global_instincts.json with vector search deduplication.
 */
class InstinctManager {
  constructor() {
    this.instinctsFilePath = path.join(os.homedir(), '.claude', 'global_instincts.json');
    this.maxInstincts = 50;
  }

  /**
   * Loads all instincts from global_instincts.json.
   * @returns {Array} List of instincts.
   */
  loadInstincts() {
    try {
      if (!fs.existsSync(this.instinctsFilePath)) {
        return [];
      }
      const raw = fs.readFileSync(this.instinctsFilePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.warn(`⚠️ [InstinctManager] Failed to load instincts: ${e.message}`);
      return [];
    }
  }

  /**
   * Saves instincts to global_instincts.json.
   * @param {Array} instincts 
   */
  saveInstinctsList(instincts) {
    try {
      const dir = path.dirname(this.instinctsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Strip vectors from saved list if it exceeds 10MB to save space, but 50 items is fine
      fs.writeFileSync(this.instinctsFilePath, JSON.stringify(instincts, null, 2), 'utf8');
    } catch (e) {
      console.warn(`⚠️ [InstinctManager] Failed to save instincts list: ${e.message}`);
    }
  }

  /**
   * Extracts and saves a new instinct with semantic vector deduplication.
   * @param {string} objective - The task objective.
   * @param {Object} failedOutput - The raw failed output before correction.
   * @param {string} errorReason - The error message or audit violation reason.
   * @param {Object} correctedOutput - The final successful output.
   */
  async saveInstinct(objective, failedOutput, errorReason, correctedOutput) {
    console.log(`💡 [InstinctManager] Generating embedding for new Instinct...`);
    const instincts = this.loadInstincts();

    let vector = null;
    try {
      const memoryManager = require('../infrastructure/adapters/memory_manager');
      vector = await memoryManager.getEmbedding(objective);
    } catch (err) {
      console.warn(`⚠️ [InstinctManager] Embedding generation failed for instinct: ${err.message}`);
    }

    // Semantic Deduplication
    let duplicateIndex = -1;
    if (vector) {
      for (let i = 0; i < instincts.length; i++) {
        if (instincts[i].vector) {
          const sim = cosineSimilarity(vector, instincts[i].vector);
          if (sim >= 0.92) {
            duplicateIndex = i;
            break;
          }
        }
      }
    } else {
      // Fallback to text similarity check
      duplicateIndex = instincts.findIndex(inst => 
        inst.errorReason === errorReason && 
        inst.objective.toLowerCase().slice(0, 30) === objective.toLowerCase().slice(0, 30)
      );
    }

    const newInstinct = {
      objective,
      failedOutput,
      errorReason,
      correctedOutput,
      vector,
      timestamp: Date.now()
    };

    if (duplicateIndex !== -1) {
      console.log(`ℹ️ [InstinctManager] Semantic duplicate found at index ${duplicateIndex}. Overwriting with latest lessons.`);
      instincts.splice(duplicateIndex, 1); // remove old duplicate
    }

    // Insert at beginning and keep size limited
    instincts.unshift(newInstinct);
    if (instincts.length > this.maxInstincts) {
      instincts.pop();
    }

    this.saveInstinctsList(instincts);
    console.log(`💾 [InstinctManager] Saved global Instinct! (Total: ${instincts.length}/${this.maxInstincts})`);
  }

  /**
   * Injects relevant instincts based on vector Cosine Similarity.
   * @param {Object} context - The processed context payload.
   */
  async injectRelevantInstincts(context) {
    if (!context || !context.objective) return;

    const instincts = this.loadInstincts();
    if (instincts.length === 0) return;

    console.log(`🧠 [InstinctManager] Querying global instincts for task relevance...`);
    let queryVector = null;
    try {
      const memoryManager = require('../infrastructure/adapters/memory_manager');
      queryVector = await memoryManager.getEmbedding(context.objective);
    } catch (err) {
      console.warn(`⚠️ [InstinctManager] Could not generate query embedding: ${err.message}`);
    }

    let relevant = [];
    if (queryVector) {
      // Vector Cosine Similarity Search
      relevant = instincts
        .map(inst => {
          const sim = inst.vector ? cosineSimilarity(queryVector, inst.vector) : 0;
          return { inst, score: sim };
        })
        .filter(item => item.score >= 0.80) // 語意相似度閾值 80%
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(item => item.inst);
    } else {
      // Fallback to keyword overlap
      const stopWords = new Set(['the', 'and', 'for', 'with', 'using', 'please', 'write', 'function', 'node', 'code', 'error']);
      const currentWords = context.objective.toLowerCase().split(/[^a-zA-Z0-9]+/).filter(w => w.length > 2 && !stopWords.has(w));
      if (currentWords.length > 0) {
        relevant = instincts
          .map(inst => {
            const instWords = inst.objective.toLowerCase().split(/[^a-zA-Z0-9]+/).filter(w => w.length > 2 && !stopWords.has(w));
            const overlap = instWords.filter(w => currentWords.includes(w)).length;
            return { inst, score: overlap };
          })
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map(item => item.inst);
      }
    }

    if (relevant.length > 0) {
      console.log(`🧠 [InstinctManager] Injected ${relevant.length} relevant past failure Instincts into task context.`);
      
      context.constraints = context.constraints || [];
      
      const promptBlock = relevant.map((inst, index) => {
        return `[PITFALL AVOIDANCE #${index + 1}]
- Objective Context: "${inst.objective}"
- What went wrong: "${inst.errorReason}"
- Do NOT output this incorrect pattern:
${JSON.stringify(inst.failedOutput, null, 2)}
- DO follow this correct/corrected pattern:
${JSON.stringify(inst.correctedOutput, null, 2)}`;
      }).join('\n\n');

      context.constraints.push(`\nCRITICAL: Review these past mistakes in similar tasks and DO NOT repeat them:\n${promptBlock}`);
    }
  }
}

module.exports = new InstinctManager();
