/**
 * CallGraphEngine (P1-C2)
 * Comprehensive Graph Analysis, Cycle-Safe Traversal, Explainable Impact Assessment,
 * and Provenance Line Verification Engine for Agent OS.
 * 
 * Author: etrnya
 */
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const {
  validateSourceEvidence,
  validateAgentBlastRadius
} = require('../infrastructure/adapters/codegraph_schemas');

class CallGraphEngine {
  /**
   * @param {object} adapter - Hardened CodeGraphAdapter instance
   * @param {object} [options]
   * @param {string} [options.projectPath] - Absolute path to project root
   */
  constructor(adapter, options = {}) {
    if (!adapter) {
      throw new Error('CallGraphEngine requires an initialized CodeGraphAdapter');
    }
    this.adapter = adapter;
    this.projectPath = path.resolve(options.projectPath || adapter.projectPath);
  }

  /**
   * C2-A & C2-B: Builds a cycle-safe, deduplicated bidirectional call graph.
   * 
   * @param {string} symbol - Target symbol name
   * @param {object} [options]
   * @param {'incoming' | 'outgoing' | 'bidirectional'} [options.direction='bidirectional']
   * @param {number} [options.maxDepth=2] - Traversal depth (1 to 5)
   * @param {number} [options.limit=20] - Per-query limit
   * @param {string} [options.filePath] - Specific file to disambiguate
   * @returns {Promise<object>}
   */
  async buildCallGraph(symbol, options = {}) {
    const validSymbol = this.adapter.validateSymbol(symbol);
    const direction = options.direction || 'bidirectional';
    const maxDepth = Math.max(1, Math.min(options.maxDepth || 2, 5));
    const limit = Math.max(1, Math.min(options.limit || 20, 100));

    // Graph data stores
    const nodesMap = new Map(); // key -> Node
    const edgesList = [];
    const edgeSet = new Set();  // "from -> to" for edge deduplication
    const cyclesList = [];
    const activeStack = [];     // Call stack to detect cycles
    let hasCycles = false;
    let isComplete = true;

    // Disambiguation check
    let targetNodes = [];
    try {
      targetNodes = await this.adapter.querySymbols(validSymbol, { limit: 10 });
    } catch {
      isComplete = false;
    }

    let isAmbiguous = false;
    let primaryNode = null;

    if (targetNodes.length > 1) {
      // Check if they are from different files
      const distinctFiles = new Set(targetNodes.map(n => n.filePath));
      if (distinctFiles.size > 1) {
        isAmbiguous = true;
      }
    }

    if (options.filePath) {
      primaryNode = targetNodes.find(n => n.filePath.endsWith(options.filePath)) || targetNodes[0] || null;
    } else {
      primaryNode = targetNodes[0] || null;
    }

    const rootKey = primaryNode ? `${primaryNode.filePath}::${primaryNode.name}` : validSymbol;
    nodesMap.set(rootKey, {
      id: rootKey,
      name: validSymbol,
      qualifiedName: primaryNode ? primaryNode.qualifiedName : validSymbol,
      filePath: primaryNode ? primaryNode.filePath : 'UNKNOWN',
      startLine: primaryNode ? primaryNode.startLine : 1,
      endLine: primaryNode ? primaryNode.endLine : 1,
      kind: primaryNode ? primaryNode.kind : 'symbol',
      depth: 0,
      isRoot: true
    });

    /**
     * Recursive DFS Traversal for Callers (Incoming edges: caller -> current)
     */
    const traverseCallers = async (currSymbol, currDepth) => {
      if (currDepth >= maxDepth) return;

      activeStack.push(currSymbol);

      try {
        const callerRes = await this.adapter.findCallers(currSymbol, { limit });
        const callers = callerRes.callers || [];

        for (const caller of callers) {
          const callerName = caller.name || 'anonymous';
          const callerKey = caller.filePath ? `${caller.filePath}::${callerName}` : callerName;

          // 1. Edge deduplication
          const edgeId = `${callerKey} -> ${currSymbol}`;
          if (!edgeSet.has(edgeId)) {
            edgeSet.add(edgeId);
            edgesList.push({
              from: callerKey,
              to: currSymbol,
              direction: 'incoming',
              depth: currDepth + 1
            });
          }

          // 2. Node registration / deduplication
          if (!nodesMap.has(callerKey)) {
            nodesMap.set(callerKey, {
              id: callerKey,
              name: callerName,
              qualifiedName: caller.qualifiedName || callerName,
              filePath: caller.filePath || 'UNKNOWN',
              startLine: caller.startLine || 1,
              endLine: caller.endLine || caller.startLine || 1,
              kind: caller.kind || 'caller',
              depth: currDepth + 1
            });
          }

          // 3. Cycle Detection: Check if caller is already on activeStack
          if (activeStack.includes(callerName) || activeStack.includes(callerKey)) {
            hasCycles = true;
            const cyclePath = [...activeStack, callerKey];
            cyclesList.push(cyclePath);
            // Safe Pruning: Do NOT recurse into cycle
            continue;
          }

          // 4. Continue traversal if depth permits
          if (currDepth + 1 < maxDepth) {
            await traverseCallers(callerName, currDepth + 1);
          }
        }
      } catch (err) {
        isComplete = false;
      } finally {
        activeStack.pop();
      }
    };

    /**
     * Recursive DFS Traversal for Callees (Outgoing edges: current -> callee)
     */
    const traverseCallees = async (currSymbol, currDepth) => {
      if (currDepth >= maxDepth) return;

      activeStack.push(currSymbol);

      try {
        const calleeRes = await this.adapter.findCallees(currSymbol, { limit });
        const callees = calleeRes.callees || [];

        for (const callee of callees) {
          const calleeName = callee.name || 'anonymous';
          const calleeKey = callee.filePath ? `${callee.filePath}::${calleeName}` : calleeName;

          // 1. Edge deduplication
          const edgeId = `${currSymbol} -> ${calleeKey}`;
          if (!edgeSet.has(edgeId)) {
            edgeSet.add(edgeId);
            edgesList.push({
              from: currSymbol,
              to: calleeKey,
              direction: 'outgoing',
              depth: currDepth + 1
            });
          }

          // 2. Node registration
          if (!nodesMap.has(calleeKey)) {
            nodesMap.set(calleeKey, {
              id: calleeKey,
              name: calleeName,
              qualifiedName: callee.qualifiedName || calleeName,
              filePath: callee.filePath || 'UNKNOWN',
              startLine: callee.startLine || 1,
              endLine: callee.endLine || callee.startLine || 1,
              kind: callee.kind || 'callee',
              depth: currDepth + 1
            });
          }

          // 3. Cycle Detection
          if (activeStack.includes(calleeName) || activeStack.includes(calleeKey)) {
            hasCycles = true;
            const cyclePath = [...activeStack, calleeKey];
            cyclesList.push(cyclePath);
            continue;
          }

          // 4. Continue traversal
          if (currDepth + 1 < maxDepth) {
            await traverseCallees(calleeName, currDepth + 1);
          }
        }
      } catch (err) {
        isComplete = false;
      } finally {
        activeStack.pop();
      }
    };

    // Execute requested directions
    if (direction === 'incoming' || direction === 'bidirectional') {
      await traverseCallers(validSymbol, 0);
    }
    if (direction === 'outgoing' || direction === 'bidirectional') {
      await traverseCallees(validSymbol, 0);
    }

    return {
      targetSymbol: validSymbol,
      rootKey,
      direction,
      maxDepth,
      depthReached: Math.max(0, ...edgesList.map(e => e.depth), 0),
      isAmbiguous,
      candidates: isAmbiguous ? targetNodes.map(n => ({ filePath: n.filePath, line: n.startLine })) : [],
      nodes: Array.from(nodesMap.values()),
      edges: edgesList,
      hasCycles,
      cycles: cyclesList,
      isComplete
    };
  }

  /**
   * C2-C: Explainable Agent OS Blast Radius Assessment Engine.
   * Distinct from raw CLI impact output, applies multi-dimensional heuristic rules.
   * 
   * @param {string} symbol
   * @param {object} [options]
   * @param {number} [options.depth=2]
   * @returns {Promise<object>} Validated AgentBlastRadius payload
   */
  async assessBlastRadius(symbol, options = {}) {
    const validSymbol = this.adapter.validateSymbol(symbol);
    const depth = options.depth || 2;

    // 1. Fetch raw CLI impact
    let rawCli = null;
    let isComplete = true;
    try {
      rawCli = await this.adapter.analyzeImpact(validSymbol, depth);
    } catch {
      isComplete = false;
      rawCli = { symbol: validSymbol, blastRadius: 'LOW', nodeCount: 0, edgeCount: 0, affected: [] };
    }

    // 2. Fetch call graph structure to analyze graph topology
    const graph = await this.buildCallGraph(validSymbol, { maxDepth: depth, direction: 'bidirectional' });

    // 3. Extract Affected Components
    const affected = rawCli.affected || [];
    const affectedFiles = new Set(affected.map(a => a.filePath).filter(Boolean));
    // Include graph nodes
    for (const node of graph.nodes) {
      if (node.filePath && node.filePath !== 'UNKNOWN') {
        affectedFiles.add(node.filePath);
      }
    }

    const allFiles = Array.from(affectedFiles);
    const entrypoints = allFiles.filter(f => /^(server|main|cli|app|index)\.(js|ts|mjs)$/i.test(path.basename(f)));
    const tests = allFiles.filter(f => /tests?[\\/]/.test(f) || /test_.*\.js$/i.test(f));
    const modules = allFiles.filter(f => !entrypoints.includes(f) && !tests.includes(f));

    // 4. Multi-Factor Risk Assessment
    const riskFactors = [];

    // Factor: Callers count (incoming edges to target)
    const incomingEdges = graph.edges.filter(e => e.to === validSymbol || e.to.endsWith(`::${validSymbol}`));
    const isIsolated = incomingEdges.length === 0 && (affected.length === 0 || (affected.length === 1 && affected[0].name === validSymbol));

    if (isIsolated) {
      riskFactors.push('ISOLATED_SYMBOL_NO_CALLERS');
    }

    if (entrypoints.length > 0) {
      riskFactors.push(`PRODUCTION_ENTRYPOINT_AFFECTED:${entrypoints.join(',')}`);
    }

    if (tests.length >= 2) {
      riskFactors.push(`MULTIPLE_TEST_SUITES_AFFECTED:${tests.length}_suites`);
    } else if (tests.length === 1) {
      riskFactors.push('TEST_SUITE_AFFECTED');
    }

    // Module directory diversity check
    const moduleDirs = new Set(allFiles.map(f => path.dirname(f)).filter(d => d && d !== '.'));
    if (moduleDirs.size >= 2) {
      riskFactors.push(`CROSS_MODULE_IMPACT:${moduleDirs.size}_directories`);
    }

    if (graph.hasCycles) {
      riskFactors.push(`RECURSIVE_OR_CYCLIC_DEPENDENCY_DETECTED:${graph.cycles.length}_cycles`);
    }

    if (!isComplete || !graph.isComplete) {
      riskFactors.push('INCOMPLETE_STATIC_ANALYSIS');
    }

    // 5. Deterministic Explainable Classification
    let assessedBlastRadius = 'LOW';
    let rationale = '';

    if (isIsolated) {
      assessedBlastRadius = 'ISOLATED';
      rationale = `Symbol "${validSymbol}" has 0 incoming callers and does not affect external components. Changes are safely localized.`;
    } else if (entrypoints.length > 0 && moduleDirs.size >= 2) {
      assessedBlastRadius = 'CRITICAL';
      rationale = `Critical blast radius: Changing "${validSymbol}" directly impacts runtime entrypoint (${entrypoints.join(', ')}) across ${moduleDirs.size} architectural modules.`;
    } else if (entrypoints.length > 0 || allFiles.length > 10 || graph.hasCycles) {
      assessedBlastRadius = 'HIGH';
      rationale = `High blast radius: Modifying "${validSymbol}" affects ${allFiles.length} components including ${entrypoints.length > 0 ? 'entrypoint ' + entrypoints.join(', ') : 'multiple downstream consumers'}.`;
    } else if (moduleDirs.size >= 2 || tests.length >= 2 || allFiles.length > 2) {
      assessedBlastRadius = 'MEDIUM';
      rationale = `Medium blast radius: Affects ${allFiles.length} components across ${moduleDirs.size} modules and ${tests.length} test suites. Requires regression verification.`;
    } else {
      assessedBlastRadius = 'LOW';
      rationale = `Low blast radius: Changes to "${validSymbol}" affect strictly ${allFiles.length} localized component(s) without cross-module impact.`;
    }

    // 6. Confidence Assessment
    let confidence = 'HIGH';
    if (!isComplete || !graph.isComplete) {
      confidence = 'INCOMPLETE';
      rationale += ' [Warning: Static graph contains unresolved dependencies or dynamic calls; analysis is incomplete.]';
    } else if (graph.isAmbiguous) {
      confidence = 'MEDIUM';
      rationale += ' [Notice: Symbol name is shared across multiple files; assessment aggregated candidates.]';
    }

    const assessmentResult = {
      symbol: validSymbol,
      assessedBlastRadius,
      confidence,
      riskFactors,
      rationale,
      affectedSummary: {
        totalAffected: allFiles.length,
        entrypoints,
        tests,
        modules
      },
      rawCliImpact: {
        cliBlastRadius: rawCli.blastRadius,
        cliNodeCount: rawCli.nodeCount,
        cliEdgeCount: rawCli.edgeCount
      }
    };

    validateAgentBlastRadius(assessmentResult, true);
    return assessmentResult;
  }

  /**
   * C2-D: Line Provenance Verification with Real File Cross-Checking.
   * Strict integrity gate: Rejects or flags invalid, stale, or out-of-bounds line coordinates.
   * 
   * @param {object|string} nodeOrSymbol - CodeGraphNode or Symbol string
   * @param {object} [options]
   * @param {string} [options.filePath]
   * @param {number} [options.startLine]
   * @param {number} [options.endLine]
   * @param {number} [options.indexTimestamp] - Timestamp when index was created
   * @returns {Promise<object>} Validated SourceEvidence object
   */
  async verifyLineProvenance(nodeOrSymbol, options = {}) {
    let symbol = '';
    let filePath = options.filePath || '';
    let startLine = options.startLine || 1;
    let endLine = options.endLine || 1;
    let indexTimestamp = options.indexTimestamp || null;

    if (typeof nodeOrSymbol === 'object' && nodeOrSymbol !== null) {
      symbol = nodeOrSymbol.name || nodeOrSymbol.qualifiedName || '';
      filePath = filePath || nodeOrSymbol.filePath;
      startLine = startLine !== 1 ? startLine : (nodeOrSymbol.startLine || 1);
      endLine = endLine !== 1 ? endLine : (nodeOrSymbol.endLine || startLine);
      indexTimestamp = indexTimestamp || nodeOrSymbol.updatedAt || null;
    } else if (typeof nodeOrSymbol === 'string') {
      symbol = nodeOrSymbol;
      if (!filePath) {
        // Query node from AST
        const nodes = await this.adapter.querySymbols(symbol, { limit: 5 });
        if (nodes.length === 0) {
          // Symbol not found in index
          const emptyHash = crypto.createHash('sha256').update('').digest('hex');
          const unverifiedEvidence = {
            symbol,
            filePath: filePath || 'UNKNOWN',
            lineRange: [startLine, endLine],
            fileSha256: emptyHash,
            snippetSha256: emptyHash,
            verifiedInIndex: false,
            validationStatus: 'UNVERIFIED',
            reason: `Symbol "${symbol}" was not found in CodeGraph AST index`,
            confidence: 'LOW'
          };
          validateSourceEvidence(unverifiedEvidence, true);
          return unverifiedEvidence;
        }

        if (nodes.length > 1) {
          // Ambiguous candidates
          const target = nodes[0];
          filePath = target.filePath;
          startLine = target.startLine;
          endLine = target.endLine;
        } else {
          filePath = nodes[0].filePath;
          startLine = nodes[0].startLine;
          endLine = nodes[0].endLine;
        }
      }
    }

    const validSymbol = this.adapter.validateSymbol(symbol);

    // 1. Resolve and validate real path
    let realPath = null;
    try {
      realPath = await this.adapter.resolveAndValidatePath(filePath);
    } catch (e) {
      const emptyHash = crypto.createHash('sha256').update('').digest('hex');
      const unverifiedEvidence = {
        symbol: validSymbol,
        filePath,
        lineRange: [startLine, endLine],
        fileSha256: emptyHash,
        snippetSha256: emptyHash,
        verifiedInIndex: false,
        validationStatus: 'UNVERIFIED',
        reason: `File path inaccessible: ${e.message}`,
        confidence: 'LOW'
      };
      validateSourceEvidence(unverifiedEvidence, true);
      return unverifiedEvidence;
    }

    // 2. Check physical file existence and line bounds
    const stat = await fs.stat(realPath);
    const fullContent = await fs.readFile(realPath, 'utf8');
    const lines = fullContent.split(/\r?\n/);
    const totalLines = lines.length;

    const fileSha256 = crypto.createHash('sha256').update(fullContent).digest('hex');

    // Bounds checking
    if (startLine < 1 || endLine > totalLines || startLine > endLine) {
      const outOfBoundsEvidence = {
        symbol: validSymbol,
        filePath,
        lineRange: [startLine, endLine],
        fileSha256,
        snippetSha256: crypto.createHash('sha256').update('').digest('hex'),
        verifiedInIndex: true,
        validationStatus: 'OUT_OF_BOUNDS',
        reason: `Coordinates [${startLine}, ${endLine}] exceed physical file bounds (1 to ${totalLines} lines)`,
        confidence: 'LOW'
      };
      validateSourceEvidence(outOfBoundsEvidence, true);
      return outOfBoundsEvidence;
    }

    // 3. Extract snippet and compute hash
    const sliced = lines.slice(startLine - 1, endLine);
    const snippetContent = sliced.join('\n');
    const snippetSha256 = crypto.createHash('sha256').update(snippetContent).digest('hex');

    // 4. Feature Verification: Does snippet actually contain the symbol?
    // Matches exact symbol or declaration pattern
    const symbolClean = validSymbol.split('::').pop();
    const symbolRegex = new RegExp(`\\b${symbolClean}\\b`);
    const symbolMatches = symbolRegex.test(snippetContent);

    if (!symbolMatches) {
      const mismatchEvidence = {
        symbol: validSymbol,
        filePath,
        lineRange: [startLine, endLine],
        fileSha256,
        snippetSha256,
        verifiedInIndex: true,
        validationStatus: 'MISMATCH',
        reason: `Target symbol "${validSymbol}" was NOT found in code lines [${startLine}, ${endLine}]. Code has drifted.`,
        confidence: 'LOW'
      };
      validateSourceEvidence(mismatchEvidence, true);
      return mismatchEvidence;
    }

    // 5. Stale / Timestamp Drift Check
    let validationStatus = 'VERIFIED';
    let reason = 'Code snippet strictly matches AST node and physical line coordinates.';
    let confidence = 'HIGH';

    if (indexTimestamp && stat.mtimeMs > indexTimestamp + 2000) { // 2s tolerance
      validationStatus = 'STALE';
      reason = `File was modified on disk (${new Date(stat.mtimeMs).toISOString()}) after index was created (${new Date(indexTimestamp).toISOString()}). Snippet verified but index may be stale.`;
      confidence = 'MEDIUM';
    }

    const verifiedEvidence = {
      symbol: validSymbol,
      filePath,
      lineRange: [startLine, endLine],
      fileSha256,
      snippetSha256,
      verifiedInIndex: true,
      indexGeneratedAt: indexTimestamp ? new Date(indexTimestamp).toISOString() : new Date().toISOString(),
      validationStatus,
      reason,
      confidence
    };

    validateSourceEvidence(verifiedEvidence, true);
    return verifiedEvidence;
  }
}

module.exports = CallGraphEngine;

