/**
 * Token Budget Guard
 * 
 * Part of Phase 1-C3.1: Core Planning & Budgeting
 * Implements deterministic token budgeting, conservative estimation,
 * four-stage pruning ladder, and fail-closed safety invariants.
 * 
 * Author: etrnya
 */

const {
  validateTokenBudgetResult,
  ContextValidationError
} = require('./context_schemas');

class TokenBudgetError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'TokenBudgetError';
    this.code = code;
    this.details = details;
  }
}

class TokenBudgetGuard {
  /**
   * @param {Object} [options]
   * @param {number} [options.hardCapLimit=3000]
   * @param {Object} [options.tokenizerAdapter=null]
   * @param {'auto'|'exact'|'conservative'} [options.mode='auto']
   * @param {Object} [options.windowProfile]
   */
  constructor(options = {}) {
    this.hardCapLimit = options.hardCapLimit || 3000;
    this.tokenizerAdapter = options.tokenizerAdapter || null;
    this.mode = options.mode || 'auto';
    this.windowProfile = options.windowProfile || {
      totalWindow: 32000,
      codeContextBudget: 3000,
      systemRoleBudget: 2000,
      userTaskBudget: 2000,
      outputReserve: 4000
    };
  }

  /**
   * Verifies if a string contains malformed surrogate pairs.
   * @param {string} str 
   * @returns {boolean}
   */
  hasMalformedSurrogates(str) {
    // Lone high surrogate or lone low surrogate
    return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(str);
  }

  /**
   * Computes a provably conservative upper-bound token count.
   * Accounts for Traditional Chinese (CJK), English, symbols, JSON, and hex hashes.
   * In any byte-level BPE tokenizer, token count <= UTF-8 byte length.
   * 
   * @param {string} text 
   * @returns {{ verifiable: boolean, tokens?: number, byteLength?: number, reason?: string, method?: string }}
   */
  conservativeEstimate(text) {
    if (typeof text !== 'string') {
      return { verifiable: false, reason: 'INPUT_NOT_A_STRING' };
    }
    if (this.hasMalformedSurrogates(text)) {
      return { verifiable: false, reason: 'MALFORMED_UTF16_SURROGATE' };
    }
    if (text.length === 0) {
      return { verifiable: true, tokens: 0, byteLength: 0, method: 'CONSERVATIVE_UPPER_BOUND' };
    }

    const byteLen = Buffer.byteLength(text, 'utf8');

    // 1. CJK characters (Chinese, Japanese, Korean)
    const cjkMatches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;

    // 2. 4-byte astral characters (Emoji, rare CJK)
    const astralMatches = text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g);
    const astralCount = astralMatches ? astralMatches.length : 0;

    // 3. ASCII Punctuation and Special Symbols
    const symbolMatches = text.match(/[^a-zA-Z0-9\s\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af\uD800-\uDFFF]/g);
    const symbolCount = symbolMatches ? symbolMatches.length : 0;

    // 4. Digits and Hex Characters (0-9)
    const digitMatches = text.match(/[0-9]/g);
    const digitCount = digitMatches ? digitMatches.length : 0;

    // 5. English / ASCII Words
    const wordMatches = text.match(/[a-zA-Z]+/g) || [];
    let wordTokens = 0;
    for (const w of wordMatches) {
      wordTokens += Math.max(1, Math.ceil(w.length / 2.0));
    }

    // 6. Whitespace runs
    const wsMatches = text.match(/\s+/g) || [];
    let wsTokens = 0;
    for (const s of wsMatches) {
      wsTokens += Math.max(1, Math.ceil(s.length / 2.0));
    }

    // Conservative sum with category multipliers
    const estimatedTokens = Math.ceil(
      cjkCount * 2.5 +
      astralCount * 4.0 +
      symbolCount * 1.25 +
      digitCount * 1.0 +
      wordTokens +
      wsTokens
    );

    // Apply 15% safety factor + baseline safety floor
    const conservativeWithSafety = Math.ceil(estimatedTokens * 1.15) + 2;

    // Mathematical upper bound: cannot exceed byteLen (in byte-level BPE)
    const finalTokens = Math.min(conservativeWithSafety, byteLen);

    return {
      verifiable: true,
      tokens: finalTokens,
      byteLength: byteLen,
      method: 'CONSERVATIVE_UPPER_BOUND'
    };
  }

  /**
   * Estimates tokens for a given string based on mode and available adapter.
   * 
   * @param {string} text 
   * @returns {{ verifiable: boolean, tokens: number, method: string, error?: string }}
   */
  estimateTokens(text) {
    if (typeof text !== 'string') {
      return { verifiable: false, tokens: 0, method: 'INVALID_INPUT', error: 'Input must be a string' };
    }

    // Exact Tokenizer Mode
    if (this.mode === 'exact' || (this.mode === 'auto' && this.tokenizerAdapter)) {
      if (!this.tokenizerAdapter || typeof this.tokenizerAdapter.countTokens !== 'function') {
        return {
          verifiable: false,
          tokens: 0,
          method: 'EXACT_TOKENIZER',
          error: 'TOKEN_BUDGET_UNVERIFIABLE: Exact tokenizer requested but adapter is missing or invalid'
        };
      }
      try {
        const count = this.tokenizerAdapter.countTokens(text);
        if (typeof count !== 'number' || isNaN(count) || count < 0) {
          return {
            verifiable: false,
            tokens: 0,
            method: 'EXACT_TOKENIZER',
            error: 'TOKEN_BUDGET_UNVERIFIABLE: Exact tokenizer returned non-numeric or negative count'
          };
        }
        return { verifiable: true, tokens: Math.ceil(count), method: 'EXACT_TOKENIZER' };
      } catch (err) {
        return {
          verifiable: false,
          tokens: 0,
          method: 'EXACT_TOKENIZER',
          error: `TOKEN_BUDGET_UNVERIFIABLE: Exact tokenizer threw error: ${err.message}`
        };
      }
    }

    // Conservative Estimator Mode
    const result = this.conservativeEstimate(text);
    if (!result.verifiable) {
      return {
        verifiable: false,
        tokens: 0,
        method: 'CONSERVATIVE_UPPER_BOUND',
        error: `TOKEN_BUDGET_UNVERIFIABLE: Conservative estimation failed (${result.reason})`
      };
    }

    return {
      verifiable: true,
      tokens: result.tokens,
      method: result.method
    };
  }

  /**
   * Helper to serialize an evidence item with full packaging to measure true token cost.
   * @param {Object} item 
   * @returns {string}
   */
  serializeEvidenceItem(item) {
    const header = `### [EVIDENCE: ${item.symbol || 'unknown'}] (${item.filePath || 'unknown'}:${item.lineStart || 1}-${item.lineEnd || 1})\n`;
    const meta = `- Hash: ${item.snippetSha256 || '00000000'} | Validity: ${item.evidenceValidity || 'UNVERIFIED'}\n`;
    const body = `\`\`\`javascript\n${item.snippet || ''}\n\`\`\`\n\n`;
    return header + meta + body;
  }

  /**
   * Serializes full context envelope to verify final budget.
   * @param {Array<Object>} items 
   * @param {Array<string>} notices 
   * @param {Object} metadata 
   * @returns {string}
   */
  serializeFullContext(items, notices = [], metadata = {}) {
    let out = `## CodeGraph Verified Context\n<!-- METADATA: ${JSON.stringify(metadata)} -->\n\n`;
    if (notices.length > 0) {
      out += `> ⚠️ **Context Notices**:\n`;
      for (const notice of notices) {
        out += `> - ${notice}\n`;
      }
      out += `\n---\n\n`;
    }
    for (const item of items) {
      out += this.serializeEvidenceItem(item);
    }
    return out;
  }

  /**
   * Enforces the hard token budget against admitted evidence using the 4-stage pruning ladder.
   * Fails closed if core evidence exceeds budget or token estimation is unverifiable.
   * 
   * @param {Array<Object>} admittedEvidence 
   * @param {number} [maxBudget]
   * @param {Object} [metadata={}]
   * @returns {Object} TokenBudgetResult
   */
  enforceBudget(admittedEvidence = [], maxBudget, metadata = {}) {
    const hardLimit = typeof maxBudget === 'number' && maxBudget > 0
      ? Math.min(maxBudget, this.hardCapLimit)
      : this.hardCapLimit;

    if (!Array.isArray(admittedEvidence)) {
      throw new ContextValidationError('admittedEvidence must be an array');
    }

    // Step 1: Identify Core Target Evidence vs Peripheral Evidence
    const coreItems = admittedEvidence.filter(e => e.isCoreTarget);
    const peripheralItems = admittedEvidence.filter(e => !e.isCoreTarget);

    // Step 2: Core Evidence Over-Budget Check (Fail-Closed)
    const coreSerialized = this.serializeFullContext(coreItems, [], metadata);
    const coreEstimate = this.estimateTokens(coreSerialized);

    if (!coreEstimate.verifiable) {
      return {
        success: false,
        totalTokens: 0,
        hardCapLimit: hardLimit,
        retainedItems: [],
        truncatedItems: [],
        notices: [`Critical: Token estimation failed for core evidence (${coreEstimate.error})`],
        errorCode: 'TOKEN_BUDGET_UNVERIFIABLE'
      };
    }

    if (coreEstimate.tokens > hardLimit) {
      const targetSymbol = coreItems.length > 0 ? coreItems[0].symbol : 'Unknown';
      return {
        success: false,
        totalTokens: coreEstimate.tokens,
        hardCapLimit: hardLimit,
        retainedItems: [],
        truncatedItems: [],
        notices: [
          `Fail-Closed: Core target symbol "${targetSymbol}" requires ${coreEstimate.tokens} tokens, exceeding hard limit of ${hardLimit} tokens.`
        ],
        errorCode: 'CORE_EVIDENCE_OVER_BUDGET'
      };
    }

    // Step 3: Four-Stage Pruning Ladder for Peripheral Evidence
    let retainedItems = structuredClone(admittedEvidence);
    const truncatedItems = [];
    const notices = [];

    // Initial Full Check
    let currentSerialized = this.serializeFullContext(retainedItems, notices, metadata);
    let currentEstimate = this.estimateTokens(currentSerialized);

    if (!currentEstimate.verifiable) {
      return {
        success: false,
        totalTokens: 0,
        hardCapLimit: hardLimit,
        retainedItems: [],
        truncatedItems: [],
        notices: [`Critical: ${currentEstimate.error}`],
        errorCode: 'TOKEN_BUDGET_UNVERIFIABLE'
      };
    }

    // If already within budget, return immediately
    if (currentEstimate.tokens <= hardLimit) {
      const result = {
        success: true,
        totalTokens: currentEstimate.tokens,
        hardCapLimit: hardLimit,
        retainedItems,
        truncatedItems,
        notices
      };
      validateTokenBudgetResult(result);
      return result;
    }

    // --- Ladder Level 1: Remove snippets of distant leaf nodes (depth >= 2) ---
    for (let i = 0; i < retainedItems.length; i++) {
      const item = retainedItems[i];
      if (!item.isCoreTarget && (item.depth || 0) >= 2 && item.snippet) {
        const originalLines = (item.snippet.match(/\n/g) || []).length + 1;
        const savedSnippet = item.snippet;
        item.snippet = `// [Leaf node snippet stripped: ${originalLines} lines]`;
        
        const testSerialized = this.serializeFullContext(retainedItems, notices, metadata);
        const testEstimate = this.estimateTokens(testSerialized);
        const tokensSaved = Math.max(0, currentEstimate.tokens - testEstimate.tokens);

        truncatedItems.push({
          symbol: item.symbol,
          filePath: item.filePath,
          originalLines,
          pruningAction: 'STRIPPED_SNIPPET',
          tokensSaved
        });
        currentEstimate = testEstimate;

        if (currentEstimate.tokens <= hardLimit) break;
      }
    }

    if (currentEstimate.tokens > hardLimit) {
      // --- Ladder Level 2: Fold secondary callers (depth === 1) implementation ---
      for (let i = 0; i < retainedItems.length; i++) {
        const item = retainedItems[i];
        if (!item.isCoreTarget && (item.depth || 0) === 1 && item.snippet && !item.snippet.startsWith('// [Implementation folded')) {
          const originalLines = (item.snippet.match(/\n/g) || []).length + 1;
          const lines = item.snippet.split('\n');
          const signature = lines.slice(0, 3).join('\n');
          item.snippet = `${signature}\n  // [Implementation folded: ${originalLines} lines]`;

          const testSerialized = this.serializeFullContext(retainedItems, notices, metadata);
          const testEstimate = this.estimateTokens(testSerialized);
          const tokensSaved = Math.max(0, currentEstimate.tokens - testEstimate.tokens);

          truncatedItems.push({
            symbol: item.symbol,
            filePath: item.filePath,
            originalLines,
            pruningAction: 'FOLDED',
            tokensSaved
          });
          currentEstimate = testEstimate;

          if (currentEstimate.tokens <= hardLimit) break;
        }
      }
    }

    if (currentEstimate.tokens > hardLimit) {
      // --- Ladder Level 3: Truncate long remaining peripheral snippets (head 25 + tail 10 lines) ---
      for (let i = 0; i < retainedItems.length; i++) {
        const item = retainedItems[i];
        if (!item.isCoreTarget && item.snippet) {
          const lines = item.snippet.split('\n');
          if (lines.length > 35) {
            const head = lines.slice(0, 25).join('\n');
            const tail = lines.slice(-10).join('\n');
            const originalLines = lines.length;
            item.snippet = `${head}\n  // ... [Truncated ${originalLines - 35} lines due to budget] ...\n${tail}`;

            const testSerialized = this.serializeFullContext(retainedItems, notices, metadata);
            const testEstimate = this.estimateTokens(testSerialized);
            const tokensSaved = Math.max(0, currentEstimate.tokens - testEstimate.tokens);

            truncatedItems.push({
              symbol: item.symbol,
              filePath: item.filePath,
              originalLines,
              pruningAction: 'STRIPPED_SNIPPET',
              tokensSaved
            });
            currentEstimate = testEstimate;

            if (currentEstimate.tokens <= hardLimit) break;
          }
        }
      }
    }

    if (currentEstimate.tokens > hardLimit) {
      // --- Ladder Level 4: Freeze to Core Target Only, Omit All Peripheral Items ---
      for (const p of peripheralItems) {
        truncatedItems.push({
          symbol: p.symbol,
          filePath: p.filePath,
          originalLines: (p.snippet ? p.snippet.split('\n').length : 0),
          pruningAction: 'OMITTED',
          tokensSaved: 0
        });
      }
      retainedItems = structuredClone(coreItems);
      notices.push(`⚠️ [Context Notice]: ${peripheralItems.length} peripheral code snippets were omitted due to hard token budget constraint.`);

      const testSerialized = this.serializeFullContext(retainedItems, notices, metadata);
      currentEstimate = this.estimateTokens(testSerialized);
    }

    // Step 4: Final Serialized Context Budget Verification
    const finalSerialized = this.serializeFullContext(retainedItems, notices, metadata);
    const finalEstimate = this.estimateTokens(finalSerialized);

    if (!finalEstimate.verifiable) {
      return {
        success: false,
        totalTokens: 0,
        hardCapLimit: hardLimit,
        retainedItems: [],
        truncatedItems,
        notices: [`Critical: ${finalEstimate.error}`],
        errorCode: 'TOKEN_BUDGET_UNVERIFIABLE'
      };
    }

    if (finalEstimate.tokens > hardLimit) {
      return {
        success: false,
        totalTokens: finalEstimate.tokens,
        hardCapLimit: hardLimit,
        retainedItems: [],
        truncatedItems,
        notices: [
          `Fail-Closed: Final serialized context (${finalEstimate.tokens} tokens) exceeds hard cap (${hardLimit} tokens) even after Level 4 pruning.`
        ],
        errorCode: 'FINAL_SERIALIZED_CONTEXT_OVER_BUDGET'
      };
    }

    const finalResult = {
      success: true,
      totalTokens: finalEstimate.tokens,
      hardCapLimit: hardLimit,
      retainedItems,
      truncatedItems,
      notices
    };

    validateTokenBudgetResult(finalResult);
    return finalResult;
  }
}

module.exports = {
  TokenBudgetGuard,
  TokenBudgetError
};
