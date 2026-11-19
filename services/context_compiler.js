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
const {
  AdmissionReceiptIssuer,
  ProvenanceTokenIssuer,
  decidePublication,
  resolveDiagnosticConfidence,
  mapReceiptToMatrixInputs,
  isFdVerifiedEvidenceItem
} = require('./isolation_boundary');

class ContextCompilationError extends Error {
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`);
    this.name = 'ContextCompilationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * UTF-16 Code Unit Deterministic String Ordering
 * Cross-environment deterministic tie-breaker independent of OS locale.
 */
function compareStringsDeterministically(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Direct numerical comparison (No float epsilon).
 */
function compareNumbersDirectly(a, b) {
  if (a === b) return 0;
  return b > a ? 1 : -1;
}

/**
 * Computes Task Policy Rank (Higher Numeric Value = Higher Priority).
 * Tier 1 Task Policy Priority:
 * - SECURITY_AUDIT / REFACTOR: Trusted (SOURCE_MATCHED / CONTENT_VERIFIED) = 2, STALE = 1
 * - BUG_FIX: isCoreTarget && Trusted = 3, Trusted = 2, STALE / UNVERIFIED = 1
 * - FEATURE: Trusted = 3, STALE = 2, UNVERIFIED = 1
 * - DOCUMENTATION: All = 1
 */
function getTaskPolicyRank(item, taskAction) {
  const isTrusted = item.validationStatus === 'SOURCE_MATCHED' || item.validationStatus === 'CONTENT_VERIFIED';

  if (taskAction === 'SECURITY_AUDIT' || taskAction === 'REFACTOR') {
    return isTrusted ? 2 : 1;
  }

  if (taskAction === 'BUG_FIX') {
    if (item.isCoreTarget && isTrusted) return 3;
    if (isTrusted) return 2;
    return 1;
  }

  if (taskAction === 'FEATURE') {
    if (isTrusted) return 3;
    if (item.validationStatus === 'STALE') return 2;
    return 1;
  }

  // DOCUMENTATION: All items Policy Rank 1
  return 1;
}

/**
 * Preflight validation gate executed once prior to sorting.
 * Verifies non-empty collection, valid taskAction, authorized statuses,
 * strictly formatted and unique sourceEvidenceId, and finite relevanceScore in [0.0, 1.0].
 */
function validateEvidenceCollectionForSorting(items, taskAction) {
  const AUTHORIZED_TASK_ACTIONS = Object.freeze([
    'SECURITY_AUDIT',
    'REFACTOR',
    'BUG_FIX',
    'FEATURE',
    'DOCUMENTATION'
  ]);

  if (!AUTHORIZED_TASK_ACTIONS.includes(taskAction)) {
    throw new ContextCompilationError('INVALID_TASK_ACTION', `taskAction "${taskAction}" is unauthorized. Must be one of: ${AUTHORIZED_TASK_ACTIONS.join(', ')}`);
  }

  if (!Array.isArray(items)) {
    throw new ContextCompilationError('INVALID_INPUT', 'items must be an array');
  }

  const AUTHORIZED_STATUSES = Object.freeze(['SOURCE_MATCHED', 'CONTENT_VERIFIED', 'STALE', 'UNVERIFIED']);
  const seenIds = new Set();
  const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') {
      throw new ContextCompilationError('INVALID_EVIDENCE_ITEM', `Evidence item at index ${i} is not an object.`);
    }

    // 1. sourceEvidenceId format and uniqueness
    const id = item.sourceEvidenceId;
    if (typeof id !== 'string' || id.length === 0 || id !== id.trim() || !EVIDENCE_ID_PATTERN.test(id)) {
      throw new ContextCompilationError('INVALID_EVIDENCE_ID', `Item at index ${i} has invalid sourceEvidenceId: "${id}". Must be non-empty string matching /^[A-Za-z0-9_-]+$/ without whitespace.`);
    }
    if (seenIds.has(id)) {
      throw new ContextCompilationError('DUPLICATE_EVIDENCE_ID', `Duplicate sourceEvidenceId "${id}" detected in sorting collection.`);
    }
    seenIds.add(id);

    // 2. validationStatus preflight
    const status = item.validationStatus;
    if (status === 'MISMATCH' || status === 'OUT_OF_BOUNDS') {
      throw new ContextCompilationError('REJECTED_EVIDENCE_IN_SORT', `Rejected evidence with status "${status}" must not enter sorting pipeline.`);
    }
    if (!AUTHORIZED_STATUSES.includes(status)) {
      throw new ContextCompilationError('INVALID_EVIDENCE_STATUS', `Item "${id}" has unauthorized or unknown validationStatus: "${status}".`);
    }

    // 3. relevanceScore strict check (No fallback to 0)
    const score = item.relevanceScore;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0.0 || score > 1.0) {
      throw new ContextCompilationError('INVALID_RELEVANCE_SCORE', `Item "${id}" has invalid relevanceScore: ${score}. Must be a finite float in [0.0, 1.0].`);
    }

    // 4. isCoreTarget boolean check
    if (typeof item.isCoreTarget !== 'boolean') {
      throw new ContextCompilationError('INVALID_CORE_TARGET', `Item "${id}" isCoreTarget must be a boolean.`);
    }
  }
}

/**
 * Validates token estimation against publishing gate invariants.
 */
function assertEnvelopePublishable(estimate, contextText) {
  const HARD_CAP_LIMIT = 3000;
  const AUTHORIZED_PUBLISH_METHODS = Object.freeze([
    'EXACT_TOKENIZER',
    'BYTE_LEVEL_BPE_THEORETICAL_UPPER_BOUND'
  ]);

  if (!estimate || typeof estimate !== 'object') {
    throw new ContextCompilationError('TOKEN_BUDGET_UNVERIFIABLE', 'Token estimation returned non-object result.');
  }

  // 1. verifiable must be true
  if (estimate.verifiable !== true) {
    const code = estimate.errorCode || 'TOKEN_BUDGET_UNVERIFIABLE';
    const msg = estimate.error || estimate.reason || 'Token estimation could not be verified by authorized profile.';
    throw new ContextCompilationError(code, `[FAIL-CLOSED] ${msg}`);
  }

  // 2. tokens must be non-negative integer
  const tokens = estimate.tokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || !Number.isInteger(tokens) || tokens < 0) {
    throw new ContextCompilationError('TOKEN_BUDGET_UNVERIFIABLE', `Token count is not a valid non-negative integer: ${tokens}`);
  }

  // 3. Authorized methods restriction
  if (!AUTHORIZED_PUBLISH_METHODS.includes(estimate.method)) {
    throw new ContextCompilationError(
      'TOKEN_BUDGET_UNVERIFIABLE',
      `Method "${estimate.method}" is not authorized for hard cap context publication. Only Mode A (EXACT_TOKENIZER) or Mode B (BYTE_LEVEL_BPE_THEORETICAL_UPPER_BOUND) are permitted.`
    );
  }

  // 4. Hard cap limit check
  if (tokens > HARD_CAP_LIMIT) {
    return { publishable: false, tokens, needPruning: true };
  }

  return { publishable: true, tokens, needPruning: false };
}
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
   * 5-Tier Deterministic Sorting Algorithm (Phase A Compliant)
   * Tier 1: Task Policy Rank (getTaskPolicyRank: 3 > 2 > 1, higher = higher priority)
   * Tier 2: validationStatus (SOURCE_MATCHED: 4 > CONTENT_VERIFIED: 3 > STALE: 2 > UNVERIFIED: 1)
   * Tier 3: isCoreTarget (true = 1 > false = 0)
   * Tier 4: relevanceScore (direct numerical comparison, no float epsilon)
   * Tier 5: sourceEvidenceId (UTF-16 Code Unit Deterministic Ordering)
   */
  sortEvidenceItems(items, taskAction = 'FEATURE') {
    // 1. Run Preflight Validation Gate
    validateEvidenceCollectionForSorting(items, taskAction);

    // 2. Discrete Validation Status Rank
    const statusRank = {
      'SOURCE_MATCHED': 4,
      'CONTENT_VERIFIED': 3,
      'STALE': 2,
      'UNVERIFIED': 1
    };

    return [...items].sort((a, b) => {
      // Tier 1: Task Policy Rank
      const policyRankA = getTaskPolicyRank(a, taskAction);
      const policyRankB = getTaskPolicyRank(b, taskAction);
      if (policyRankA !== policyRankB) {
        return policyRankB - policyRankA;
      }

      // Tier 2: validationStatus
      const statusRankA = statusRank[a.validationStatus];
      const statusRankB = statusRank[b.validationStatus];
      if (statusRankA !== statusRankB) {
        return statusRankB - statusRankA;
      }

      // Tier 3: isCoreTarget
      const coreA = a.isCoreTarget ? 1 : 0;
      const coreB = b.isCoreTarget ? 1 : 0;
      if (coreA !== coreB) {
        return coreB - coreA;
      }

      // Tier 4: relevanceScore
      const scoreComp = compareNumbersDirectly(a.relevanceScore, b.relevanceScore);
      if (scoreComp !== 0) {
        return scoreComp;
      }

      // Tier 5: sourceEvidenceId UTF-16 Code Unit ordering
      return compareStringsDeterministically(a.sourceEvidenceId, b.sourceEvidenceId);
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
   * Serializes full envelope including headers, warnings, and XML evidence blocks.
   * 
   * @param {Array<object>} items 
   * @param {string|null} degradedSnapshotWarning 
   * @param {string} taskAction 
   * @returns {string} Serialized envelope text
   */
  serializeFullEnvelope(items, degradedSnapshotWarning = null, taskAction = 'FEATURE') {
    const serializedBlocks = [];

    // Header warnings if applicable
    if (degradedSnapshotWarning) {
      serializedBlocks.push(degradedSnapshotWarning);
    }

    if (taskAction === 'SECURITY_AUDIT') {
      const hasStaleOrUnverified = items.some(i => i.validationStatus !== 'SOURCE_MATCHED' && i.validationStatus !== 'CONTENT_VERIFIED');
      if (hasStaleOrUnverified) {
        serializedBlocks.push('⚠️ [SECURITY AUDIT INCONCLUSIVE: Target includes non-verified or stale code snippets. Current version cannot be certified secure.]');
      }
    }

    for (const item of items) {
      serializedBlocks.push(this.serializeEvidenceItem(item));
    }

    return serializedBlocks.join('\n\n');
  }

  /**
   * Assembles the immutable, certified compilation result.
   * Guaranteed: contextText is 100% identical to the measured context string.
   */
  assembleSuccessResult(finalContextText, verifiedEstimate, compiledItems, sessionSnapshotId, dlpRedactedCount, rejectedItems) {
    return {
      contextText: finalContextText,
      measuredTokens: verifiedEstimate.tokens,
      compiledItems,
      rejectedItems: rejectedItems || [],
      metadata: {
        snapshotId: sessionSnapshotId,
        totalItems: compiledItems.length,
        dlpRedactedCount: dlpRedactedCount || 0,
        rejectedCount: (rejectedItems || []).length,
        hardCapLimit: 3000,
        tokenAudit: {
          measuredTokens: verifiedEstimate.tokens,
          measurementMode: verifiedEstimate.method,
          verifiable: verifiedEstimate.verifiable === true
        }
      }
    };
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
    const sortedItems = this.sortEvidenceItems(sanitizedItems, taskAction);

    // 7. Token Budget Enforcement (Pruning on Sanitized Snippets)
    if (!this.tokenBudgetGuard || typeof this.tokenBudgetGuard.enforceBudget !== 'function') {
      throw new ContextCompilationError('TOKEN_BUDGET_UNVERIFIABLE', '[FAIL-CLOSED] TokenBudgetGuard does not implement enforceBudget method.');
    }

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

    // Preserve unforgeable WeakSet-branded fdProofToken across TokenBudgetGuard's structuredClone boundary
    // ONLY when all 6 evidence identity fields match the original admitted item.
    const fdProofByEvidenceId = new Map();
    for (const orig of (admissionResult.admittedEvidence || [])) {
      if (orig && orig.sourceEvidenceId && orig.fdProofToken) {
        fdProofByEvidenceId.set(orig.sourceEvidenceId, {
          token: orig.fdProofToken,
          filePath: orig.filePath,
          symbol: orig.symbol,
          startLine: Array.isArray(orig.lineRange) ? orig.lineRange[0] : null,
          endLine: Array.isArray(orig.lineRange) ? orig.lineRange[1] : null,
          fileSha256: orig.sourceFileSha256,
          snippetSha256: orig.sourceSnippetSha256
        });
      }
    }

    const compiledItems = budgetResult.retainedItems.map(item => {
      const finalSnippet = item.snippet !== undefined ? item.snippet : (item.sanitizedSnippet || item.rawSnippet || '');
      const emittedHash = crypto.createHash('sha256').update(finalSnippet, 'utf8').digest('hex');
      const proofEntry = fdProofByEvidenceId.get(item.sourceEvidenceId);
      const identityMatches = Boolean(
        proofEntry &&
        proofEntry.filePath === item.filePath &&
        proofEntry.symbol === item.symbol &&
        proofEntry.fileSha256 === item.sourceFileSha256 &&
        proofEntry.snippetSha256 === item.sourceSnippetSha256 &&
        emittedHash === proofEntry.snippetSha256 &&
        Array.isArray(item.lineRange) &&
        proofEntry.startLine === item.lineRange[0] &&
        proofEntry.endLine === item.lineRange[1]
      );
      const preservedToken = identityMatches ? proofEntry.token : undefined;
      return {
        ...item,
        fdProofToken: preservedToken,
        finalSnippet,
        emittedContentSha256: emittedHash
      };
    });

    // 8. Faithful Packaging & Initial Serialization
    const initialContextText = this.serializeFullEnvelope(compiledItems, degradedSnapshotWarning, taskAction);

    // 9. Final Token Audit on Whole Envelope (Phase A Remediation Pipeline - No Fallback)
    if (!this.tokenBudgetGuard || typeof this.tokenBudgetGuard.estimateTokens !== 'function') {
      throw new ContextCompilationError('TOKEN_BUDGET_UNVERIFIABLE', '[FAIL-CLOSED] TokenBudgetGuard does not implement authorized estimateTokens method.');
    }

    let firstEstimate;
    try {
      firstEstimate = this.tokenBudgetGuard.estimateTokens(initialContextText);
    } catch (err) {
      throw new ContextCompilationError('TOKEN_BUDGET_UNVERIFIABLE', `[FAIL-CLOSED] Token estimation threw error: ${err.message}`);
    }

    const firstDecision = assertEnvelopePublishable(firstEstimate, initialContextText);

    if (firstDecision.publishable) {
      // 初次計量通過 -> 直接不可變同源發布初次序列化字串
      const contextText = initialContextText;
      return this.assembleSuccessResult(contextText, firstEstimate, compiledItems, sessionSnapshotId, dlpRedactedCount, admissionResult.rejectedEvidence);
    }

    // 超額處置分流
    if (!firstDecision.needPruning) {
      throw new ContextCompilationError('CORE_EVIDENCE_OVER_BUDGET', 'Context exceeds hard cap limit.');
    }

    const hasPeripheral = compiledItems.some(i => !i.isCoreTarget && i.contentCompleteness !== 'OMITTED');
    if (!hasPeripheral) {
      // 核心目標超額，無外圍可裁剪 -> 拋出 CORE_EVIDENCE_OVER_BUDGET
      throw new ContextCompilationError('CORE_EVIDENCE_OVER_BUDGET', `Core evidence alone (${firstEstimate.tokens} tokens) strictly exceeds hard cap limit of ${hardCapLimit}.`);
    }

    // 執行 Emergency Pruning (非核心證據降級為最小 OMITTED 標籤)
    for (const item of compiledItems) {
      if (!item.isCoreTarget) {
        item.contentCompleteness = 'OMITTED';
        item.isTruncated = true;
        item.finalSnippet = '// [OMITTED: Pruned during emergency budget enforcement]';
        item.emittedContentSha256 = crypto.createHash('sha256').update(item.finalSnippet, 'utf8').digest('hex');
      }
    }

    // 【必須重新序列化完整 Envelope】
    const reSerializedContextText = this.serializeFullEnvelope(compiledItems, degradedSnapshotWarning, taskAction);

    // 【必須二次計量】(ZERO Fallback, FAIL-CLOSED)
    let secondEstimate;
    try {
      secondEstimate = this.tokenBudgetGuard.estimateTokens(reSerializedContextText);
    } catch (err) {
      throw new ContextCompilationError('TOKEN_BUDGET_UNVERIFIABLE', `[FAIL-CLOSED] Second token estimation threw error: ${err.message}`);
    }
    const secondDecision = assertEnvelopePublishable(secondEstimate, reSerializedContextText);

    if (!secondDecision.publishable) {
      // 二次計量超額 -> 拋出 CORE_EVIDENCE_OVER_BUDGET
      throw new ContextCompilationError('CORE_EVIDENCE_OVER_BUDGET', `Pruned context (${secondEstimate.tokens} tokens) strictly exceeds hard cap limit.`);
    }

    // 【不可變同源發布】：保證 contextText === reSerializedContextText 100% 同源！
    const contextText = reSerializedContextText;
    return this.assembleSuccessResult(contextText, secondEstimate, compiledItems, sessionSnapshotId, dlpRedactedCount, admissionResult.rejectedEvidence);
  }

  /**
   * Phase 1-C3.3 Adapter: Compiles and evaluates candidate context through the Four-Tier
   * Isolation Boundary, issuing branded 13-Field TLV AdmissionReceipt & SourceProvenanceToken,
   * and enforcing the authoritative 90-row policy matrix via `decidePublication`.
   *
   * @param {object} retrievalPlan
   * @param {object} taskContext - { taskId, tenantId, taskType }
   * @param {object} [options] - { targetSymbol, snapshotFreshness, retrievalStatus, diagnosticReason, processTreeStatus }
   * @returns {Promise<object>} { decision, envelope, admissionReceipt, provenanceToken }
   */
  async compileIsolatedEnvelope(retrievalPlan, taskContext, options = {}) {
    const c32ActionMap = {
      SECURITY_AUDIT: 'SECURITY_AUDIT',
      REFACTOR: 'REFACTOR',
      FEATURE_DEV: 'FEATURE',
      DOCS_UPDATE: 'DOCUMENTATION'
    };
    const taskType = taskContext.taskType || 'FEATURE_DEV';
    const taskAction = c32ActionMap[taskType] || 'FEATURE';
    const targetSymbol = options.targetSymbol || (retrievalPlan && retrievalPlan.targetSymbol) || 'TargetSymbol';
    const processTreeStatus = options.processTreeStatus || 'NOT_STARTED';

    const compResult = await this.compile(retrievalPlan, { action: taskAction });
    const compiledItems = compResult.compiledItems || [];
    const snapshotId = options.snapshotId || compResult.metadata.snapshotId || 'snap-default';

    // Compute aggregate evidence status using Conservative Monotonic Precedence (Iron Law 1)
    let aggregateEvidenceStatus = 'NONE';
    if (this.admissionEngine && typeof this.admissionEngine.computeAggregateEvidenceStatus === 'function') {
      aggregateEvidenceStatus = this.admissionEngine.computeAggregateEvidenceStatus(compiledItems);
    } else if (compiledItems.length > 0) {
      aggregateEvidenceStatus = compiledItems[0].validationStatus || 'SOURCE_MATCHED';
    }
    if (options.aggregateEvidenceStatus) {
      aggregateEvidenceStatus = options.aggregateEvidenceStatus;
    }

    const evaluatedItemsHash = (this.admissionEngine && typeof this.admissionEngine.computeEvaluatedItemsHash === 'function')
      ? this.admissionEngine.computeEvaluatedItemsHash(compiledItems)
      : crypto.createHash('sha256').update(JSON.stringify(compiledItems.map(i => i.sourceEvidenceId)), 'utf-8').digest('hex');

    const anyTruncated = compiledItems.some(i => i.isTruncated || i.contentCompleteness !== 'FULL');
    const completenessStatus = options.completenessStatus || (anyTruncated ? 'TRUNCATED' : 'FULL');
    const snapshotFreshness = options.snapshotFreshness || 'OPTIMAL';
    const retrievalStatus = options.retrievalStatus || (compiledItems.length > 0 ? (anyTruncated ? 'PARTIAL' : 'COMPLETE') : 'COMPLETE');
    const diagnosticReason = options.diagnosticReason !== undefined
      ? options.diagnosticReason
      : (compiledItems.length === 0 ? 'TARGET_NOT_FOUND' : null);

    const drift = snapshotFreshness === 'DRIFT_DETECTED' ? 'DRIFT_DETECTED' : 'INDEX_SNAPSHOT_MATCHED';
    const router = snapshotFreshness === 'DEGRADED' ? 'DEGRADED' : (diagnosticReason === 'ROUTER_UNAVAILABLE' ? 'UNAVAILABLE' : 'OPTIMAL');
    const degrad = (retrievalStatus === 'COMPLETE' && completenessStatus === 'FULL') ? 'COMPLETE' : (retrievalStatus === 'PARTIAL' ? 'PARTIAL' : 'INCOMPLETE');

    const diagnosticConfidence = options.diagnosticConfidence || (
      aggregateEvidenceStatus === 'NONE'
        ? resolveDiagnosticConfidence(drift, router, degrad, diagnosticReason)
        : 'HIGH'
    );

    const isDiagnosticChannel = aggregateEvidenceStatus === 'NONE';
    const contextText = isDiagnosticChannel ? '' : compResult.contextText;
    const contextTextHash = crypto.createHash('sha256').update(contextText, 'utf-8').digest('hex');

    const pureParams = {
      schemaVersion: '1.0',
      taskId: taskContext.taskId,
      tenantId: taskContext.tenantId,
      taskType,
      snapshotId,
      snapshotFreshness,
      policyVersion: '2.3.3',
      aggregateEvidenceStatus,
      retrievalStatus,
      completenessStatus,
      evaluatedItemsHash,
      diagnosticReason,
      diagnosticConfidence
    };

    const admissionReceipt = AdmissionReceiptIssuer.issueReceipt(pureParams, contextTextHash);
    const provenanceToken = ProvenanceTokenIssuer.issueToken({
      schemaVersion: '1.0',
      tokenBrand: 'ANTIGRAVITY_PROVENANCE_v233',
      source: isDiagnosticChannel ? 'DIAGNOSTIC_SYNTHESIS' : 'FRESH_LIVE_COMPILATION',
      targetSymbol,
      taskId: taskContext.taskId,
      tenantId: taskContext.tenantId,
      snapshotId,
      envelopeSha256: contextTextHash
    });

    // Unforgeable WeakSet brand check: NEVER trust caller-supplied options.fdSnapshotVerified
    const allItemsFdVerified = compiledItems.length > 0 && compiledItems.every(i => isFdVerifiedEvidenceItem(i));
    const derivedIsolationTier = allItemsFdVerified
      ? 'TIER_4_VERIFIED_FD'
      : 'TIER_2_JS_ISOLATED';

    const candidateEnvelope = isDiagnosticChannel
      ? Object.freeze({
          schemaVersion: '1.0',
          envelopeId: `diag-${taskContext.taskId}`,
          taskId: taskContext.taskId,
          tenantId: taskContext.tenantId,
          targetSymbol,
          snapshotId,
          isolationTier: derivedIsolationTier,
          diagnosticConfidence,
          diagnosticReason: diagnosticReason || 'TARGET_NOT_FOUND',
          partialSymbolIndex: options.partialSymbolIndex || [],
          admissionReceipt
        })
      : Object.freeze({
          schemaVersion: '1.0',
          envelopeId: `ctx-${taskContext.taskId}`,
          taskId: taskContext.taskId,
          tenantId: taskContext.tenantId,
          targetSymbol,
          snapshotId,
          isolationTier: derivedIsolationTier,
          contextText,
          measuredTokens: compResult.measuredTokens,
          tokenEstimationMethod: (compResult.metadata && compResult.metadata.tokenAudit && compResult.metadata.tokenAudit.method) || 'verified_estimator',
          compiledItems,
          rejectedItems: compResult.rejectedItems || [],
          metadata: compResult.metadata || {},
          aggregateEvidenceStatus,
          retrievalStatus,
          provenanceToken,
          admissionReceipt,
          processTreeStatus
        });

    const decision = decidePublication(
      taskContext,
      candidateEnvelope,
      provenanceToken,
      admissionReceipt,
      processTreeStatus
    );

    return {
      decision,
      envelope: candidateEnvelope,
      admissionReceipt,
      provenanceToken
    };
  }
}

module.exports = {
  ContextCompiler,
  ContextCompilationError,
  escapeXmlAttribute,
  scanWithWatchdog,
  assertEnvelopePublishable,
  validateEvidenceCollectionForSorting,
  getTaskPolicyRank,
  compareStringsDeterministically,
  compareNumbersDirectly
};
