/**
 * ContextCompiler (Pipeline Orchestrator)
 * Coordinates Evidence Admission, Structured DLP, Token Budget Enforcement,
 * 5-Tier Ranking, and Faithful XML Serialization.
 * 
 * Part of Agent OS Phase 1-C3.2 (Engineering PRD v2.4 Compliant).
 * Author: etrnya
 */
const crypto = require('crypto');
const { TokenBudgetGuard } = require('./token_budget_guard');

class ContextCompilationError extends Error {
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`);
    this.name = 'ContextCompilationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Escapes characters for XML attributes.
 */
function escapeXmlAttribute(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Scans payload with 2000ms watchdog and drops late-arriving Promise results.
 */
async function scanWithWatchdog(guardrailManager, payload, timeoutMs = 2000) {
  const sessionToken = { isCancelled: false };
  let timerId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      sessionToken.isCancelled = true;
      reject(new ContextCompilationError('DLP_TIMEOUT', `DLP scan exceeded watchdog threshold of ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  const scanPromise = (async () => {
    try {
      const res = await guardrailManager.scan(payload);
      if (sessionToken.isCancelled) {
        // Late-arriving Promise: silently discard
        return null;
      }
      return res;
    } catch (err) {
      if (sessionToken.isCancelled) return null;
      throw new ContextCompilationError('DLP_ERROR', `DLP scan execution failed: ${err.message}`);
    }
  })();

  try {
    const result = await Promise.race([scanPromise, timeoutPromise]);
    return result;
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

class ContextCompiler {
  /**
   * @param {object} dependencies
   * @param {object} dependencies.admissionEngine - EvidenceAdmissionEngine instance
   * @param {object} dependencies.tokenBudgetGuard - TokenBudgetGuard instance or class
   * @param {object} dependencies.guardrailManager - P0-B GuardrailManager instance
   * @param {object} dependencies.codeGraphAdapter - P1-C1 CodeGraphAdapter instance
   * @param {object} [dependencies.callGraphEngine] - P1-C2 CallGraphEngine instance
   */
  constructor(dependencies = {}) {
    if (!dependencies.admissionEngine) {
      throw new ContextCompilationError('MISSING_DEPENDENCY', 'admissionEngine is required');
    }
    if (!dependencies.tokenBudgetGuard) {
      throw new ContextCompilationError('MISSING_DEPENDENCY', 'tokenBudgetGuard is required');
    }
    if (!dependencies.guardrailManager) {
      throw new ContextCompilationError('MISSING_DEPENDENCY', 'guardrailManager is required');
    }
    if (!dependencies.codeGraphAdapter) {
      throw new ContextCompilationError('MISSING_DEPENDENCY', 'codeGraphAdapter is required');
    }

    this.admissionEngine = dependencies.admissionEngine;

    // Handle tokenBudgetGuard as instance, class, or module export
    if (dependencies.tokenBudgetGuard instanceof TokenBudgetGuard) {
      this.tokenBudgetGuard = dependencies.tokenBudgetGuard;
    } else if (typeof dependencies.tokenBudgetGuard === 'function') {
      this.tokenBudgetGuard = new dependencies.tokenBudgetGuard({ hardCapLimit: 3000 });
    } else if (dependencies.tokenBudgetGuard && dependencies.tokenBudgetGuard.TokenBudgetGuard) {
      this.tokenBudgetGuard = new dependencies.tokenBudgetGuard.TokenBudgetGuard({ hardCapLimit: 3000 });
    } else {
      this.tokenBudgetGuard = dependencies.tokenBudgetGuard;
    }

    this.guardrailManager = dependencies.guardrailManager;
    this.codeGraphAdapter = dependencies.codeGraphAdapter;
    this.callGraphEngine = dependencies.callGraphEngine || null;
  }

  /**
   * 5-Tier Deterministic Sorting Algorithm
   * 1. Task Policy Priority (presumed admitted)
   * 2. validationStatus: VERIFIED (3) > STALE (2) > UNVERIFIED (1)
   * 3. isCoreTarget: true (1) > false (0) (within same validationStatus only)
   * 4. relevanceScore: descending (1.0 to 0.0)
   * 5. sourceEvidenceId: ascending string localeCompare (tie-breaker)
   */
  sortEvidenceItems(items) {
    const statusWeight = {
      'VERIFIED': 3,
      'STALE': 2,
      'UNVERIFIED': 1
    };

    return [...items].sort((a, b) => {
      // Tier 2: validationStatus
      const weightA = statusWeight[a.validationStatus] || 0;
      const weightB = statusWeight[b.validationStatus] || 0;
      if (weightA !== weightB) {
        return weightB - weightA;
      }

      // Tier 3: isCoreTarget (only within same validationStatus)
      const coreA = a.isCoreTarget ? 1 : 0;
      const coreB = b.isCoreTarget ? 1 : 0;
      if (coreA !== coreB) {
        return coreB - coreA;
      }

      // Tier 4: relevanceScore
      const scoreA = typeof a.relevanceScore === 'number' ? a.relevanceScore : 0;
      const scoreB = typeof b.relevanceScore === 'number' ? b.relevanceScore : 0;
      if (Math.abs(scoreA - scoreB) > 0.0001) {
        return scoreB - scoreA;
      }

      // Tier 5: sourceEvidenceId tie-breaker
      return String(a.sourceEvidenceId).localeCompare(String(b.sourceEvidenceId));
    });
  }

  /**
   * Serializes a single compiled evidence item to standard XML envelope.
   */
  serializeEvidenceItem(item) {
    const id = escapeXmlAttribute(item.sourceEvidenceId);
    const source = escapeXmlAttribute(item.filePath);
    const lines = escapeXmlAttribute(`${item.lineRange[0]}-${item.lineRange[1]}`);
    const encoding = escapeXmlAttribute(item.encoding || 'text');
    const sourceHash = escapeXmlAttribute(item.sourceSnippetSha256);
    const emittedHash = escapeXmlAttribute(item.emittedContentSha256 || item.sourceSnippetSha256);
    const validity = escapeXmlAttribute(item.validationStatus);
    const completeness = escapeXmlAttribute(item.contentCompleteness || 'FULL');
    const dlpRedacted = escapeXmlAttribute(String(Boolean(item.dlpRedacted)));

    let attributes = `id="${id}" source="${source}" lines="${lines}" encoding="${encoding}" sourceHash="${sourceHash}" emittedHash="${emittedHash}" validity="${validity}" completeness="${completeness}" dlpRedacted="${dlpRedacted}"`;

    if (item.warning) {
      attributes += ` warning="${escapeXmlAttribute(item.warning)}"`;
    }

    if (item.encoding === 'base64') {
      attributes += ` rawByteLength="${item.rawByteLength || 0}"`;
      return [
        `<untrusted_code_context ${attributes}>`,
        item.finalSnippet || item.sanitizedSnippet || item.rawSnippet,
        `</untrusted_code_context>`
      ].join('\n');
    }

    // Text CDATA Mode: split any internal ]]> sequences safely
    const content = item.finalSnippet !== undefined ? item.finalSnippet : (item.sanitizedSnippet || item.rawSnippet);
    // Standard CDATA split: ]]> becomes ]]]]><![CDATA[>
    const safeCdataContent = content.replace(/\]\]>/g, ']]]]><![CDATA[>');

    return [
      `<untrusted_code_context ${attributes}>`,
      `<![CDATA[`,
      safeCdataContent,
      `]]>`,
      `</untrusted_code_context>`
    ].join('\n');
  }

  /**
   * Compiles retrieval plan into structured, sanitized, budget-compliant context.
   * 
   * @param {object} retrievalPlan - RetrievalPlan from RoleAwareContextPlanner
   * @param {object} taskPayload - Original task payload
   * @returns {Promise<object>} CompiledContextResult
   */
  async compile(retrievalPlan, taskPayload = {}) {
    const taskAction = taskPayload.action || (retrievalPlan && retrievalPlan.taskPolicy && retrievalPlan.taskPolicy.taskAction) || 'FEATURE';
    const hardCapLimit = 3000;
    const modelProfile = (retrievalPlan && retrievalPlan.modelProfile) || 'TIKTOKEN_CL100K';

    // 1. Snapshot Ingestion & Pinning
    const status = await this.codeGraphAdapter.getStatus();
    let sessionSnapshotId = status.snapshotId || `snap-${status.lastSyncedAt || Date.now()}`;

    // 2. Obtain candidate raw nodes
    let rawNodes = [];
    if (Array.isArray(retrievalPlan.nodes) && retrievalPlan.nodes.length > 0) {
      rawNodes = retrievalPlan.nodes;
    } else if (Array.isArray(retrievalPlan.targetSymbols) && retrievalPlan.targetSymbols.length > 0) {
      rawNodes = retrievalPlan.targetSymbols.map((sym, idx) => ({
        id: `ev-${String(idx + 1).padStart(2, '0')}`,
        symbol: typeof sym === 'string' ? sym : (sym.symbol || sym.name),
        filePath: sym.filePath || '',
        startLine: sym.startLine || 1,
        endLine: sym.endLine || 10,
        isCoreTarget: sym.isCoreTarget !== undefined ? sym.isCoreTarget : (idx === 0),
        relevanceScore: sym.relevanceScore !== undefined ? sym.relevanceScore : (idx === 0 ? 1.0 : 0.6)
      }));
    }

    // 3. Admission Evaluation
    let admissionResult = await this.admissionEngine.evaluateAdmission(rawNodes, sessionSnapshotId, taskAction);

    // 4. Snapshot Race Detection & Whole-Batch Retry
    let degradedSnapshotWarning = null;
    const latestStatus = await this.codeGraphAdapter.getStatus();
    const latestSnapshotId = latestStatus.snapshotId || sessionSnapshotId;

    if (latestSnapshotId !== sessionSnapshotId || (retrievalPlan && retrievalPlan.simulateSnapshotRace)) {
      // Optimistic Concurrency Invalidation: Retry whole batch exactly once
      sessionSnapshotId = latestSnapshotId;
      admissionResult = await this.admissionEngine.evaluateAdmission(rawNodes, sessionSnapshotId, taskAction);

      // Verify again after retry
      const postRetryStatus = await this.codeGraphAdapter.getStatus();
      if ((postRetryStatus.snapshotId && postRetryStatus.snapshotId !== sessionSnapshotId) || (retrievalPlan && retrievalPlan.simulateContinuousRace)) {
        // Continuous drift detected -> Degrade gracefully
        degradedSnapshotWarning = '⚠️ [INDEX_SNAPSHOT_UNSTABLE: CodeGraph index is undergoing concurrent updates. Emitted evidence may not reflect atomic snapshot.]';
        for (const item of admissionResult.admittedEvidence) {
          item.validationStatus = 'UNVERIFIED';
          item.warning = 'INDEX_SNAPSHOT_UNSTABLE';
        }
      }
    }

    // 5. Structured DLP Scan on Each Admitted Item
    const sanitizedItems = [];
    let dlpRedactedCount = 0;

    for (const item of admissionResult.admittedEvidence) {
      const payloadToScan = {
        evidenceId: item.sourceEvidenceId,
        symbol: item.symbol,
        filePath: item.filePath,
        snippet: item.rawSnippet
      };

      const scanResult = await scanWithWatchdog(this.guardrailManager, payloadToScan, 2000);

      // 6-State Deterministic Handling
      if (!scanResult || typeof scanResult !== 'object' || typeof scanResult.safe !== 'boolean') {
        throw new ContextCompilationError('DLP_INVALID_RETURN', 'Guardrail scan returned malformed result.');
      }

      if (scanResult.safe === false) {
        throw new ContextCompilationError('DLP_SECURITY_VIOLATION', `Security violation detected: ${scanResult.reason}`);
      }

      let sanitizedSnippet = item.rawSnippet;
      let sanitizedFilePath = item.filePath;
      let dlpRedacted = false;

      if (scanResult.reason === 'Sanitized') {
        const payload = scanResult.sanitizedPayload;
        sanitizedSnippet = typeof payload === 'object' && payload !== null && payload.snippet ? String(payload.snippet) : String(payload);
        if (typeof payload === 'object' && payload !== null && payload.filePath) {
          sanitizedFilePath = String(payload.filePath);
        }
        dlpRedacted = true;
        dlpRedactedCount++;
      } else if (scanResult.reason === 'Clean') {
        sanitizedSnippet = item.rawSnippet;
        dlpRedacted = false;
      } else {
        // Unknown reason defensive check
        const modified = JSON.stringify(scanResult.sanitizedPayload) !== JSON.stringify(payloadToScan);
        if (modified) {
          const payload = scanResult.sanitizedPayload;
          sanitizedSnippet = typeof payload === 'object' && payload !== null && payload.snippet ? String(payload.snippet) : String(payload);
          dlpRedacted = true;
          dlpRedactedCount++;
        }
      }

      sanitizedItems.push({
        ...item,
        filePath: sanitizedFilePath,
        sanitizedSnippet,
        snippet: sanitizedSnippet, // For TokenBudgetGuard compatibility
        dlpRedacted,
        emittedContentSha256: crypto.createHash('sha256').update(sanitizedSnippet, 'utf8').digest('hex')
      });
    }

    // 6. 5-Tier Deterministic Ranking
    const sortedItems = this.sortEvidenceItems(sanitizedItems);

    // 7. Token Budget Enforcement (Pruning on Sanitized Snippets)
    const budgetInput = sortedItems.map(item => ({
      ...item,
      snippet: item.sanitizedSnippet || item.rawSnippet || '',
      sourceSnippetSha256: item.sourceSnippetSha256
    }));

    const budgetResult = this.tokenBudgetGuard.enforceBudget(budgetInput, hardCapLimit, {
      tokenizerMode: retrievalPlan.tokenizerMode || 'byte_level_bpe_upper_bound',
      tokenizerProfile: modelProfile
    });

    if (!budgetResult.success) {
      if (budgetResult.errorCode === 'CORE_EVIDENCE_OVER_BUDGET') {
        throw new ContextCompilationError('CORE_EVIDENCE_OVER_BUDGET', (budgetResult.notices && budgetResult.notices[0]) || 'Core target evidence exceeds budget');
      }
      throw new ContextCompilationError(budgetResult.errorCode || 'TOKEN_BUDGET_EXCEEDED', (budgetResult.notices && budgetResult.notices[0]) || 'Budget exceeded');
    }

    const compiledItems = budgetResult.retainedItems.map(item => {
      const finalSnippet = item.snippet !== undefined ? item.snippet : (item.sanitizedSnippet || item.rawSnippet || '');
      const emittedHash = crypto.createHash('sha256').update(finalSnippet, 'utf8').digest('hex');
      return {
        ...item,
        finalSnippet,
        emittedContentSha256: emittedHash
      };
    });

    // 8. Faithful Packaging & Serialization
    const serializedBlocks = [];

    // Header warnings if applicable
    if (degradedSnapshotWarning) {
      serializedBlocks.push(degradedSnapshotWarning);
    }

    if (taskAction === 'SECURITY_AUDIT') {
      const hasStaleOrUnverified = compiledItems.some(i => i.validationStatus !== 'VERIFIED');
      if (hasStaleOrUnverified) {
        serializedBlocks.push('⚠️ [SECURITY AUDIT INCONCLUSIVE: Target includes non-verified or stale code snippets. Current version cannot be certified secure.]');
      }
    }

    for (const item of compiledItems) {
      serializedBlocks.push(this.serializeEvidenceItem(item));
    }

    let finalSerializedContext = serializedBlocks.join('\n\n');

    // 9. Final Token Audit on Whole Envelope
    const wholeEnvelopeEstimate = this.tokenBudgetGuard.estimateTokens ?
      this.tokenBudgetGuard.estimateTokens(finalSerializedContext) :
      { verifiable: true, tokens: Buffer.byteLength(finalSerializedContext, 'utf8') };

    let finalMeasuredTokens = wholeEnvelopeEstimate.tokens || Buffer.byteLength(finalSerializedContext, 'utf8');

    if (finalMeasuredTokens > hardCapLimit) {
      // Attempt emergency pruning on peripheral items
      const hasPeripheral = compiledItems.some(i => !i.isCoreTarget && i.contentCompleteness !== 'OMITTED');
      if (hasPeripheral) {
        // Strip non-core items
        const prunedBlocks = [];
        if (degradedSnapshotWarning) prunedBlocks.push(degradedSnapshotWarning);
        if (taskAction === 'SECURITY_AUDIT' && compiledItems.some(i => i.validationStatus !== 'VERIFIED')) {
          prunedBlocks.push('⚠️ [SECURITY AUDIT INCONCLUSIVE: Target includes non-verified or stale code snippets. Current version cannot be certified secure.]');
        }

        for (const item of compiledItems) {
          if (!item.isCoreTarget) {
            item.contentCompleteness = 'OMITTED';
            item.isTruncated = true;
            item.finalSnippet = '// [OMITTED: Pruned during final envelope budget compliance]';
            item.emittedContentSha256 = crypto.createHash('sha256').update(item.finalSnippet, 'utf8').digest('hex');
          }
          prunedBlocks.push(this.serializeEvidenceItem(item));
        }

        finalSerializedContext = prunedBlocks.join('\n\n');
        const recheck = this.tokenBudgetGuard.estimateTokens ?
          this.tokenBudgetGuard.estimateTokens(finalSerializedContext) :
          { tokens: Buffer.byteLength(finalSerializedContext, 'utf8') };
        finalMeasuredTokens = recheck.tokens;
      }

      if (finalMeasuredTokens > hardCapLimit) {
        throw new ContextCompilationError('CORE_EVIDENCE_OVER_BUDGET', `Final serialized context (${finalMeasuredTokens} tokens) exceeds hard cap limit of ${hardCapLimit} tokens.`);
      }
    }

    return {
      contextText: finalSerializedContext,
      measuredTokens: finalMeasuredTokens,
      compiledItems,
      rejectedItems: admissionResult.rejectedEvidence,
      metadata: {
        snapshotId: sessionSnapshotId,
        totalItems: compiledItems.length,
        dlpRedactedCount,
        rejectedCount: admissionResult.rejectedEvidence.length,
        hardCapLimit
      }
    };
  }
}

module.exports = {
  ContextCompiler,
  ContextCompilationError,
  escapeXmlAttribute,
  scanWithWatchdog
};
