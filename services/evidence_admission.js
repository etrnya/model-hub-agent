/**
 * EvidenceAdmissionEngine
 * Validates candidate evidence nodes against physical files, sandbox boundaries,
 * and CodeGraph AST line provenance without altering or mutating code snippets.
 * 
 * Part of Agent OS Phase 1-C3.2 (Engineering PRD v2.4 Compliant).
 * Author: etrnya
 */
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { AdmissionReceiptIssuer } = require('./isolation_boundary');

/**
 * Escapes characters for regular expressions.
 * @param {string} string
 * @returns {string}
 */
function escapeRegExp(string) {
  if (typeof string !== 'string') return '';
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strict integer parser rejecting floating point numbers, mixed strings, NaN, Infinity, etc.
 * @param {any} val
 * @returns {number|null} Safe integer or null if invalid
 */
function parseStrictInteger(val) {
  if (typeof val === 'number') {
    return Number.isSafeInteger(val) ? val : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      const num = Number(trimmed);
      return Number.isSafeInteger(num) ? num : null;
    }
  }
  return null;
}

/**
 * Safely matches a symbol against a code snippet using exact literal presence
 * and escaped boundary check, preventing regex injection and symbol substring false positives.
 * @param {string} snippet
 * @param {string} symbol
 * @returns {boolean}
 */
function matchSymbolInSnippet(snippet, symbol) {
  if (typeof snippet !== 'string' || typeof symbol !== 'string' || symbol.length === 0) {
    return false;
  }
  const cleanSymbol = symbol.split('::').pop();
  if (!cleanSymbol || cleanSymbol.length === 0) {
    return false;
  }
  // 1. Literal presence check (fail fast)
  if (!snippet.includes(cleanSymbol)) {
    return false;
  }
  // 2. Escaped boundary check with Unicode UAX #31 identifier continuation support
  const escaped = escapeRegExp(cleanSymbol);
  const pattern = new RegExp(`(^|[^\\p{ID_Continue}$])${escaped}([^\\p{ID_Continue}$]|$)`, 'u');
  return pattern.test(snippet);
}

class EvidenceAdmissionError extends Error {
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`);
    this.name = 'EvidenceAdmissionError';
    this.code = code;
    this.details = details;
  }
}

class EvidenceAdmissionEngine {
  /**
   * @param {object} dependencies
   * @param {object} dependencies.codeGraphAdapter - P1-C1 CodeGraphAdapter instance
   * @param {object} [dependencies.callGraphEngine] - P1-C2 CallGraphEngine instance
   * @param {string} [dependencies.workspaceRoot] - Absolute workspace path
   */
  constructor(dependencies = {}) {
    if (!dependencies.codeGraphAdapter) {
      throw new EvidenceAdmissionError('MISSING_DEPENDENCY', 'CodeGraphAdapter dependency is required');
    }
    this.codeGraphAdapter = dependencies.codeGraphAdapter;
    this.callGraphEngine = dependencies.callGraphEngine || null;
    this.workspaceRoot = path.resolve(dependencies.workspaceRoot || dependencies.codeGraphAdapter.projectPath || process.cwd());
  }

  /**
   * Resolves and verifies that a relative file path is strictly within the workspace root,
   * delegating directly to CodeGraphAdapter's proven symlink and path traversal protection.
   * @param {string} filePath
   * @returns {Promise<string>} Validated real absolute path
   */
  async resolveSafePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      throw new EvidenceAdmissionError('INVALID_PATH', 'File path must be a non-empty string');
    }
    return await this.codeGraphAdapter.resolveAndValidatePath(filePath);
  }

  /**
   * Evaluates a collection of candidate evidence nodes against physical files,
   * sandbox boundaries, and CodeGraph index snapshots without altering code snippets.
   * Phase A Compliant: VERIFIED is strictly disabled; highest status is SOURCE_MATCHED.
   * Single-read immutable evidence snapshot architecture.
   * 
   * @param {Array<object>} rawNodes - Raw candidate nodes from planner/graph
   * @param {string} indexSnapshotId - The locked snapshot ID for this compilation session
   * @param {string} [taskAction='FEATURE'] - 'BUG_FIX' | 'REFACTOR' | 'SECURITY_AUDIT' | 'DOCUMENTATION' | 'FEATURE'
   * @returns {Promise<object>} EvidenceAdmissionResult
   */
  async evaluateAdmission(rawNodes = [], indexSnapshotId = '', taskAction = 'FEATURE') {
    const admittedEvidence = [];
    const rejectedEvidence = [];

    const summary = {
      totalEvaluated: 0,
      sourceMatchedCount: 0,
      contentVerifiedCount: 0,
      staleCount: 0,
      unverifiedCount: 0,
      rejectedMismatchCount: 0,
      rejectedOutOfBoundsCount: 0,
      rejectedSandboxCount: 0,
      rejectedDisallowedCount: 0
    };

    if (!Array.isArray(rawNodes)) {
      throw new EvidenceAdmissionError('INVALID_INPUT', 'rawNodes must be an array');
    }

    for (let i = 0; i < rawNodes.length; i++) {
      const node = rawNodes[i];
      summary.totalEvaluated++;

      const evidenceId = node.id || node.sourceEvidenceId || `ev-${String(i + 1).padStart(2, '0')}`;
      const symbol = node.symbol || node.name || 'anonymous';
      const filePath = node.filePath || '';
      
      const isCoreTarget = Boolean(node.isCoreTarget);

      // Relevance Score Strict Validation (BLOCKER SORT-R: Zero silent fallback for invalid scores)
      let relevanceScore;
      if (node.relevanceScore === undefined) {
        relevanceScore = isCoreTarget ? 1.0 : 0.5;
      } else if (
        typeof node.relevanceScore === 'number' &&
        Number.isFinite(node.relevanceScore) &&
        node.relevanceScore >= 0.0 &&
        node.relevanceScore <= 1.0
      ) {
        relevanceScore = node.relevanceScore;
      } else {
        summary.rejectedOutOfBoundsCount++;
        rejectedEvidence.push({
          sourceEvidenceId: evidenceId,
          symbol,
          filePath,
          rejectionReason: 'OUT_OF_BOUNDS',
          category: 'INVALID_RELEVANCE_SCORE',
          details: `Invalid relevanceScore: ${node.relevanceScore}. Must be undefined or a finite float in [0.0, 1.0].`
        });
        continue;
      }

      const isBinaryExpected = Boolean(node.forceBinary || node.evidenceType === 'BINARY' || filePath.endsWith('.bin') || filePath.endsWith('.png') || filePath.endsWith('.wasm'));

      // 1. Path Sandbox & Blacklist Check
      let realPath = null;
      try {
        realPath = await this.resolveSafePath(filePath);
      } catch (err) {
        summary.rejectedSandboxCount++;
        rejectedEvidence.push({
          sourceEvidenceId: evidenceId,
          symbol,
          filePath,
          rejectionReason: 'OUT_OF_BOUNDS',
          category: 'SANDBOX_VIOLATION',
          details: `Sandbox violation or inaccessible file: ${err.message}`
        });
        continue;
      }

      // 2. Line Number Strict Integer Bounds Check
      const parsedStart = parseStrictInteger(node.startLine);
      const parsedEnd = parseStrictInteger(node.endLine !== undefined ? node.endLine : node.startLine);

      if (parsedStart === null || parsedEnd === null || parsedStart < 1 || parsedEnd < parsedStart) {
        summary.rejectedOutOfBoundsCount++;
        rejectedEvidence.push({
          sourceEvidenceId: evidenceId,
          symbol,
          filePath,
          rejectionReason: 'OUT_OF_BOUNDS',
          category: 'COORDINATE_OVERFLOW',
          details: `Invalid line coordinates: startLine (${node.startLine}) and endLine (${node.endLine}) must be valid safe integers with startLine >= 1 and startLine <= endLine.`
        });
        continue;
      }

      const startLine = parsedStart;
      const endLine = parsedEnd;

      // 3. Single-Read Immutable Evidence Snapshot (Single I/O)
      let rawBuffer = null;
      let fileSha256 = '';
      try {
        rawBuffer = await fs.readFile(realPath);
        fileSha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');
      } catch (readErr) {
        summary.unverifiedCount++;
        rejectedEvidence.push({
          sourceEvidenceId: evidenceId,
          symbol,
          filePath,
          rejectionReason: 'FILE_READ_ERROR',
          category: 'IO_ERROR',
          details: `Failed to read physical file: ${readErr.message}`
        });
        continue;
      }

      // 4. Binary vs Text Discrimination & Strict UTF-8 Decoding
      let evidenceType = 'TEXT';
      let encoding = 'text';
      let decodedText = null;
      let rawSnippet = '';
      let snippetSha256 = '';
      let isStrictUtf8 = false;

      const hasNullByte = rawBuffer.includes(0x00);
      if (!hasNullByte && !isBinaryExpected) {
        try {
          const strictDecoder = new TextDecoder('utf-8', { fatal: true });
          decodedText = strictDecoder.decode(rawBuffer);
          isStrictUtf8 = true;
        } catch {
          isStrictUtf8 = false;
        }
      }

      const hasIllegalXmlChars = isStrictUtf8 && /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(decodedText);

      if (isBinaryExpected || hasNullByte || !isStrictUtf8 || hasIllegalXmlChars) {
        evidenceType = 'BINARY';
        encoding = 'base64';
        rawSnippet = rawBuffer.toString('base64');
        snippetSha256 = fileSha256;
      } else {
        // Text slicing and line boundary check
        const lines = decodedText.split(/\r?\n/);
        if (endLine > lines.length) {
          summary.rejectedOutOfBoundsCount++;
          rejectedEvidence.push({
            sourceEvidenceId: evidenceId,
            symbol,
            filePath,
            rejectionReason: 'OUT_OF_BOUNDS',
            category: 'COORDINATE_OVERFLOW',
            details: `Coordinates [${startLine}, ${endLine}] exceed physical file bounds (1 to ${lines.length} lines)`
          });
          continue;
        }

        const slicedLines = lines.slice(startLine - 1, endLine);
        rawSnippet = slicedLines.join('\n'); // Normalized to LF
        snippetSha256 = crypto.createHash('sha256').update(rawSnippet, 'utf8').digest('hex');

        // Symbol Feature Check (Word boundary match with escape protection)
        const cleanSymbol = symbol.split('::').pop();
        if (!matchSymbolInSnippet(rawSnippet, cleanSymbol)) {
          summary.rejectedMismatchCount++;
          rejectedEvidence.push({
            sourceEvidenceId: evidenceId,
            symbol,
            filePath,
            rejectionReason: 'MISMATCH',
            category: 'SYMBOL_DRIFT',
            details: `Target symbol "${cleanSymbol}" was NOT found in code lines [${startLine}, ${endLine}].`
          });
          continue;
        }
      }

      // 5. Index Snapshot Freshness Check (Sole Route B - Zero verifyLineProvenance calls)
      let mappedStatus = 'UNVERIFIED';
      let confidence = 'LOW';
      let warning = null;

      const snapshot = await this.codeGraphAdapter.getFileIndexSnapshot(filePath);

      if (!snapshot || !snapshot.contentHash) {
        mappedStatus = 'UNVERIFIED';
        confidence = 'LOW';
        warning = 'INDEX_RECORD_ABSENT';
      } else if (snapshot.contentHash !== fileSha256) {
        mappedStatus = 'STALE';
        confidence = 'MEDIUM';
        warning = 'CONTENT_MODIFIED_SINCE_INDEX';
      } else {
        // Physical Hash matches snapshot contentHash!
        // In Phase A, VERIFIED is strictly disabled; highest attainable state is SOURCE_MATCHED (text only).
        // Binary evidence cannot perform AST verification; strictly granted CONTENT_VERIFIED.
        if (evidenceType === 'BINARY') {
          mappedStatus = 'CONTENT_VERIFIED';
          confidence = 'HIGH';
        } else {
          mappedStatus = 'SOURCE_MATCHED';
          confidence = 'HIGH';
        }
      }

      // 6. Admission Gate Task-Specific Policy Filtering
      if (taskAction === 'SECURITY_AUDIT') {
        if (mappedStatus === 'UNVERIFIED') {
          summary.rejectedDisallowedCount++;
          rejectedEvidence.push({
            sourceEvidenceId: evidenceId,
            symbol,
            filePath,
            rejectionReason: 'TASK_ACTION_DISALLOWED',
            category: 'SECURITY_AUDIT_UNVERIFIED_DENIED',
            details: 'UNVERIFIED code snippets are strictly disallowed from admission during SECURITY_AUDIT tasks.'
          });
          continue;
        }
        if (mappedStatus === 'STALE') {
          warning = 'HISTORICAL_ONLY_CANNOT_CERTIFY_SECURITY';
        }
      } else if (taskAction === 'REFACTOR') {
        if (mappedStatus === 'UNVERIFIED') {
          summary.rejectedDisallowedCount++;
          rejectedEvidence.push({
            sourceEvidenceId: evidenceId,
            symbol,
            filePath,
            rejectionReason: 'TASK_ACTION_DISALLOWED',
            category: 'REFACTOR_UNVERIFIED_DENIED',
            details: 'UNVERIFIED code snippets cannot support refactoring operations.'
          });
          continue;
        }
      }

      // Update counters cleanly (No duplicate increments)
      if (mappedStatus === 'SOURCE_MATCHED') summary.sourceMatchedCount++;
      else if (mappedStatus === 'CONTENT_VERIFIED') summary.contentVerifiedCount++;
      else if (mappedStatus === 'STALE') summary.staleCount++;
      else summary.unverifiedCount++;

      admittedEvidence.push({
        sourceEvidenceId: evidenceId,
        symbol,
        filePath,
        lineRange: [startLine, endLine],
        evidenceType,
        encoding,
        rawSnippet,
        snippet: rawSnippet, // For downstream TokenBudgetGuard compatibility
        rawBuffer: rawBuffer,
        rawByteLength: rawBuffer.length,
        validationStatus: mappedStatus,
        confidence,
        analysisCompleteness: mappedStatus === 'SOURCE_MATCHED' ? 'COMPLETE' : 'PARTIAL',
        contentCompleteness: 'FULL',
        isTruncated: false,
        isCoreTarget,
        relevanceScore,
        warning,
        sourceFileSha256: fileSha256,
        sourceSnippetSha256: snippetSha256
      });
    }

    return {
      admittedEvidence,
      rejectedEvidence,
      summary,
      aggregateEvidenceStatus: this.computeAggregateEvidenceStatus(admittedEvidence),
      evaluatedItemsHash: this.computeEvaluatedItemsHash(admittedEvidence)
    };
  }

  /**
   * Phase 1-C3.3 Iron Law 1: Conservative Monotonic Precedence for Aggregate Evidence Status.
   * Precedence: UNVERIFIED > STALE > CONTENT_VERIFIED > SOURCE_MATCHED (or NONE if empty).
   * @param {Array<object>} items
   * @returns {'SOURCE_MATCHED'|'CONTENT_VERIFIED'|'STALE'|'UNVERIFIED'|'NONE'}
   */
  computeAggregateEvidenceStatus(items = []) {
    if (!Array.isArray(items) || items.length === 0) {
      return 'NONE';
    }
    let hasUnverified = false;
    let hasStale = false;
    let hasContentVerified = false;
    let hasSourceMatched = false;

    for (const item of items) {
      const status = item && item.validationStatus;
      if (status === 'UNVERIFIED') hasUnverified = true;
      else if (status === 'STALE') hasStale = true;
      else if (status === 'CONTENT_VERIFIED') hasContentVerified = true;
      else if (status === 'SOURCE_MATCHED') hasSourceMatched = true;
    }

    if (hasUnverified) return 'UNVERIFIED';
    if (hasStale) return 'STALE';
    if (hasContentVerified) return 'CONTENT_VERIFIED';
    if (hasSourceMatched) return 'SOURCE_MATCHED';
    return 'NONE';
  }

  /**
   * Computes deterministic 64-char hex SHA-256 over evaluated items' IDs and statuses.
   * @param {Array<object>} items
   * @returns {string}
   */
  computeEvaluatedItemsHash(items = []) {
    if (!Array.isArray(items) || items.length === 0) {
      return crypto.createHash('sha256').update('EMPTY_EVIDENCE_SET', 'utf-8').digest('hex');
    }
    const canonicalEntries = items.map(item => {
      const id = item.sourceEvidenceId || item.id || '';
      const status = item.validationStatus || 'UNVERIFIED';
      const hash = item.emittedContentSha256 || item.sourceSnippetSha256 || '';
      return `${id}:${status}:${hash}`;
    });
    return crypto.createHash('sha256').update(canonicalEntries.join('|'), 'utf-8').digest('hex');
  }

  /**
   * Phase 1-C3.3 (R1, R4, R6): Issues a branded, frozen 13-Field TLV AdmissionReceipt
   * from discrete primitive parameters in the trusted synchronous frame.
   * @param {object} pureParams - PureAdmissionParams (13 primitive fields)
   * @param {string} contextTextHash - 64-char hex SHA-256 of candidate contextText
   * @returns {Readonly<object>} Branded AdmissionReceipt
   */
  issueAdmissionReceipt(pureParams, contextTextHash) {
    return AdmissionReceiptIssuer.issueReceipt(pureParams, contextTextHash);
  }
}

module.exports = {
  EvidenceAdmissionEngine,
  EvidenceAdmissionError,
  escapeRegExp,
  parseStrictInteger,
  matchSymbolInSnippet
};
