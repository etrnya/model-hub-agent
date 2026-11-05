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
   * AST line provenance, and task-specific admission policies.
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
      verifiedCount: 0,
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
      const startLine = Number(node.startLine || 1);
      const endLine = Number(node.endLine || startLine);
      const isCoreTarget = Boolean(node.isCoreTarget);
      const relevanceScore = typeof node.relevanceScore === 'number' ? node.relevanceScore : (isCoreTarget ? 1.0 : 0.5);
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

      // 2. Line Provenance & Hash Verification
      let provenanceResult = null;
      try {
        if (!isBinaryExpected && this.callGraphEngine && typeof this.callGraphEngine.verifyLineProvenance === 'function') {
          provenanceResult = await this.callGraphEngine.verifyLineProvenance(
            { symbol, name: symbol, filePath, startLine, endLine },
            {
              filePath,
              startLine,
              endLine,
              indexSnapshotId,
              indexedFileSha256: node.indexedFileSha256 || null
            }
          );
        } else {
          // Direct fallback or Binary Asset evaluation (no AST symbol regex search for binary files)
          const snapshot = await this.codeGraphAdapter.getFileIndexSnapshot(filePath);
          const rawBuffer = await fs.readFile(realPath);
          const fileSha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');

          if (isBinaryExpected) {
            provenanceResult = {
              validationStatus: 'VERIFIED',
              fileSha256,
              snippetSha256: fileSha256,
              confidence: 'HIGH',
              reason: 'Binary asset verified from filesystem'
            };
          } else {
            const fullContent = rawBuffer.toString('utf8');
            const lines = fullContent.split(/\r?\n/);

            if (startLine < 1 || endLine > lines.length || startLine > endLine) {
              provenanceResult = { validationStatus: 'OUT_OF_BOUNDS', fileSha256, snippetSha256: '', reason: 'Lines out of bounds' };
            } else {
              const sliced = lines.slice(startLine - 1, endLine).join('\n');
              const snippetSha256 = crypto.createHash('sha256').update(sliced, 'utf8').digest('hex');
              const cleanSymbol = symbol.split('::').pop();
              const symbolRegex = new RegExp(`\\b${cleanSymbol}\\b`);

              if (!symbolRegex.test(sliced)) {
                provenanceResult = { validationStatus: 'MISMATCH', fileSha256, snippetSha256, reason: 'Symbol drifted' };
              } else if (!snapshot || !snapshot.contentHash) {
                provenanceResult = { validationStatus: 'UNVERIFIED', fileSha256, snippetSha256, reason: 'Index snapshot absent' };
              } else if (snapshot.contentHash !== fileSha256) {
                provenanceResult = { validationStatus: 'STALE', fileSha256, snippetSha256, reason: 'File modified since index' };
              } else {
                provenanceResult = { validationStatus: 'VERIFIED', fileSha256, snippetSha256, reason: 'Verified with index snapshot' };
              }
            }
          }
        }
      } catch (provErr) {
        summary.unverifiedCount++;
        provenanceResult = {
          validationStatus: 'UNVERIFIED',
          fileSha256: crypto.createHash('sha256').update('').digest('hex'),
          snippetSha256: crypto.createHash('sha256').update('').digest('hex'),
          confidence: 'LOW',
          reason: `Verification failed: ${provErr.message}`
        };
      }

      // 3. Status Mapping & Strict Rejection of MISMATCH / OUT_OF_BOUNDS
      const rawStatus = provenanceResult.validationStatus;
      if (rawStatus === 'OUT_OF_BOUNDS') {
        summary.rejectedOutOfBoundsCount++;
        rejectedEvidence.push({
          sourceEvidenceId: evidenceId,
          symbol,
          filePath,
          rejectionReason: 'OUT_OF_BOUNDS',
          category: 'COORDINATE_OVERFLOW',
          details: provenanceResult.reason || 'Line range exceeds physical file lines.'
        });
        continue;
      }

      if (rawStatus === 'MISMATCH') {
        summary.rejectedMismatchCount++;
        rejectedEvidence.push({
          sourceEvidenceId: evidenceId,
          symbol,
          filePath,
          rejectionReason: 'MISMATCH',
          category: 'SYMBOL_DRIFT',
          details: provenanceResult.reason || `Target symbol "${symbol}" missing from specified lines.`
        });
        continue;
      }

      // Map to Admission Status
      let mappedStatus = 'UNVERIFIED';
      let confidence = provenanceResult.confidence || 'LOW';
      let warning = null;

      if (rawStatus === 'VERIFIED') {
        mappedStatus = 'VERIFIED';
        confidence = 'HIGH';
      } else if (rawStatus === 'STALE') {
        mappedStatus = 'STALE';
        confidence = 'MEDIUM';
        warning = 'CONTENT_MODIFIED_SINCE_INDEX';
      } else {
        mappedStatus = 'UNVERIFIED';
        confidence = 'LOW';
        warning = 'INDEX_RECORD_ABSENT';
      }

      // 4. Task-Specific Admission Policies
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

      // 5. Physical Reading & Binary Detection (D1 Contract)
      let evidenceType = 'TEXT';
      let encoding = 'text';
      let rawSnippet = '';
      let rawBuffer = null;
      let rawByteLength = 0;
      let sourceFileSha256 = provenanceResult.fileSha256;
      let sourceSnippetSha256 = provenanceResult.snippetSha256;

      try {
        const fileStat = await fs.stat(realPath);
        const fd = await fs.open(realPath, 'r');
        try {
          const probeSize = Math.min(fileStat.size, 8000);
          const probeBuf = Buffer.alloc(probeSize);
          await fd.read(probeBuf, 0, probeSize, 0);

          const hasNullByte = probeBuf.includes(0x00);
          const hasIllegalControl = /[\x01-\x08\x0B\x0C\x0E-\x1F]/.test(probeBuf.toString('binary'));

          if (isBinaryExpected || hasNullByte || hasIllegalControl) {
            evidenceType = 'BINARY';
            encoding = 'base64';
            rawBuffer = await fs.readFile(realPath);
            rawByteLength = rawBuffer.length;
            sourceFileSha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');
            sourceSnippetSha256 = sourceFileSha256;
            rawSnippet = rawBuffer.toString('base64');
          } else {
            evidenceType = 'TEXT';
            encoding = 'text';
            const fullContent = await fs.readFile(realPath, 'utf8');
            sourceFileSha256 = crypto.createHash('sha256').update(fullContent, 'utf8').digest('hex');
            const lines = fullContent.split(/\r?\n/);
            const sliced = lines.slice(startLine - 1, endLine).join('\n');
            rawSnippet = sliced;
            rawByteLength = Buffer.byteLength(sliced, 'utf8');
            sourceSnippetSha256 = crypto.createHash('sha256').update(sliced, 'utf8').digest('hex');
          }
        } finally {
          await fd.close();
        }
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

      // Update counters
      if (mappedStatus === 'VERIFIED') summary.verifiedCount++;
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
        snippet: rawSnippet, // For downstream token budget compatibility
        rawBuffer: rawBuffer || undefined,
        rawByteLength,
        validationStatus: mappedStatus,
        confidence,
        analysisCompleteness: mappedStatus === 'VERIFIED' ? 'COMPLETE' : 'PARTIAL',
        contentCompleteness: 'FULL',
        isTruncated: false,
        isCoreTarget,
        relevanceScore,
        warning,
        sourceFileSha256,
        sourceSnippetSha256
      });
    }

    return {
      admittedEvidence,
      rejectedEvidence,
      summary
    };
  }
}

module.exports = {
  EvidenceAdmissionEngine,
  EvidenceAdmissionError
};
