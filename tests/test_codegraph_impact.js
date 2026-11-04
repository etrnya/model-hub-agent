/**
 * P1-C2 Test Suite: Call Graph, Impact Engine & Line Provenance
 * (tests/test_codegraph_impact.js)
 * 
 * Validates:
 * - Group A: Call Graph (Multilayer, Callers, Callees, Cycles, Duplicate Edges, Ambiguities, Depths)
 * - Group B: Explainable Blast Radius Impact Engine (Orthogonal Completeness, Priority Ladder, Isolated Boundary)
 * - Group C: Line Provenance Verification (Verified, Out-of-Bounds, Mismatch, Stale, Unverified)
 * - Group D: Real TaskManager Assessment
 * 
 * Author: etrnya
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

const { CodeGraphAdapter } = require('../infrastructure/adapters/codegraph_adapter');
const CallGraphEngine = require('../services/call_graph_engine');

let passedCount = 0;
let failedCount = 0;

async function runTestCase(testId, description, fn) {
  try {
    await fn();
    console.log(`  ✅ [${testId}] PASS: ${description}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ [${testId}] FAIL: ${description}`);
    console.error(`     Error: ${err.message}`);
    failedCount++;
  }
}

async function runAll() {
  console.log("\n==================================================");
  console.log("🕸️  [P1-C2 Test Suite] Call Graph & Explainable Impact Engine");
  console.log("==================================================\n");

  const projectRoot = path.resolve(__dirname, '..');
  const tempDir = path.resolve(projectRoot, '.test_tmp_p1c2');

  if (fsSync.existsSync(tempDir)) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  await fs.mkdir(tempDir, { recursive: true });

  try {
    // ========================================================
    // Group A: Call Graph (Bidirectional, Cycles, Disambiguation)
    // ========================================================
    console.log("--- Group A: Call Graph Traversal, Cycles & Dedup ---");

    await runTestCase('C2-A1', 'A calls B, B calls C (Multilayer Callers & Callees)', async () => {
      const mockRunner = async (args) => {
        const cmd = args[0];
        const sym = args[1];

        if (cmd === 'query') {
          return JSON.stringify([
            { node: { name: sym, filePath: `src/${sym.toLowerCase()}.js`, startLine: 10, endLine: 30 } }
          ]);
        }
        if (cmd === 'callers') {
          if (sym === 'C') return JSON.stringify({ symbol: 'C', callers: [{ name: 'B', filePath: 'src/b.js', startLine: 15 }] });
          if (sym === 'B') return JSON.stringify({ symbol: 'B', callers: [{ name: 'A', filePath: 'src/a.js', startLine: 5 }] });
          return JSON.stringify({ symbol: sym, callers: [] });
        }
        if (cmd === 'callees') {
          if (sym === 'A') return JSON.stringify({ symbol: 'A', callees: [{ name: 'B', filePath: 'src/b.js', startLine: 20 }] });
          if (sym === 'B') return JSON.stringify({ symbol: 'B', callees: [{ name: 'C', filePath: 'src/c.js', startLine: 25 }] });
          return JSON.stringify({ symbol: sym, callees: [] });
        }
        return JSON.stringify({});
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const engine = new CallGraphEngine(adapter);

      // 1. C reverse search Callers
      const cCallers = await engine.buildCallGraph('C', { direction: 'incoming', maxDepth: 3 });
      assert.strictEqual(cCallers.nodes.length, 3); // C, B, A
      assert.strictEqual(cCallers.edges.length, 2);
      assert.strictEqual(cCallers.edges.some(e => e.from.includes('B') && e.to === 'C'), true);
      assert.strictEqual(cCallers.edges.some(e => e.from.includes('A') && e.to === 'B'), true);

      // 2. A forward search Callees
      const aCallees = await engine.buildCallGraph('A', { direction: 'outgoing', maxDepth: 3 });
      assert.strictEqual(aCallees.nodes.length, 3); // A, B, C
      assert.strictEqual(aCallees.edges.length, 2);
      assert.strictEqual(aCallees.edges.some(e => e.from === 'A' && e.to.includes('B')), true);
      assert.strictEqual(aCallees.edges.some(e => e.from.includes('B') && e.to.includes('C')), true);
    });

    await runTestCase('C2-A2', 'Cycle Detection & Safe Pruning (A -> B -> C -> A)', async () => {
      const mockRunner = async (args) => {
        const cmd = args[0];
        const sym = args[1];
        if (cmd === 'query') {
          return JSON.stringify([{ node: { name: sym, filePath: `src/${sym.toLowerCase()}.js`, startLine: 1, endLine: 10 } }]);
        }
        if (cmd === 'callees') {
          if (sym === 'A') return JSON.stringify({ symbol: 'A', callees: [{ name: 'B', filePath: 'src/b.js', startLine: 2 }] });
          if (sym === 'B') return JSON.stringify({ symbol: 'B', callees: [{ name: 'C', filePath: 'src/c.js', startLine: 3 }] });
          if (sym === 'C') return JSON.stringify({ symbol: 'C', callees: [{ name: 'A', filePath: 'src/a.js', startLine: 4 }] });
        }
        return JSON.stringify({ symbol: sym, callers: [], callees: [] });
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const engine = new CallGraphEngine(adapter);

      const graph = await engine.buildCallGraph('A', { direction: 'outgoing', maxDepth: 5 });
      assert.strictEqual(graph.hasCycles, true, 'Must detect cycle');
      assert.strictEqual(graph.cycles.length > 0, true);
      assert.strictEqual(graph.nodes.length <= 4, true);
    });

    await runTestCase('C2-A3', 'Disambiguation of same symbol across different files', async () => {
      const mockRunner = async (args) => {
        const cmd = args[0];
        const sym = args[1];
        if (cmd === 'query' && sym === 'validate') {
          return JSON.stringify([
            { node: { name: 'validate', qualifiedName: 'SchemaValidator::validate', filePath: 'src/schema.js', startLine: 10, endLine: 20 } },
            { node: { name: 'validate', qualifiedName: 'TokenValidator::validate', filePath: 'src/auth.js', startLine: 30, endLine: 40 } }
          ]);
        }
        return JSON.stringify({ symbol: sym, callers: [], callees: [] });
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const engine = new CallGraphEngine(adapter);

      const result = await engine.buildCallGraph('validate');
      assert.strictEqual(result.isAmbiguous, true);
      assert.strictEqual(result.candidates.length, 2);

      const disambiguated = await engine.buildCallGraph('validate', { filePath: 'auth.js' });
      assert.strictEqual(disambiguated.rootKey.includes('auth.js'), true);
    });

    await runTestCase('C2-A4', 'Depth limits and edge deduplication', async () => {
      const mockRunner = async (args) => {
        const cmd = args[0];
        const sym = args[1];
        if (cmd === 'query') {
          return JSON.stringify([{ node: { name: sym, filePath: `src/${sym}.js`, startLine: 1, endLine: 10 } }]);
        }
        if (cmd === 'callees') {
          if (sym === 'A') {
            return JSON.stringify({
              symbol: 'A',
              callees: [
                { name: 'B', filePath: 'src/B.js', startLine: 1 },
                { name: 'B', filePath: 'src/B.js', startLine: 1 }
              ]
            });
          }
          if (sym === 'B') {
            return JSON.stringify({
              symbol: 'B',
              callees: [{ name: 'C', filePath: 'src/C.js', startLine: 1 }]
            });
          }
        }
        return JSON.stringify({ symbol: sym, callers: [], callees: [] });
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const engine = new CallGraphEngine(adapter);

      const depth1 = await engine.buildCallGraph('A', { direction: 'outgoing', maxDepth: 1 });
      assert.strictEqual(depth1.nodes.some(n => n.name === 'C'), false, 'C should not be reached at depth 1');
      assert.strictEqual(depth1.edges.length, 1, 'Duplicate edge to B must be deduplicated');
    });

    // ========================================================
    // Group B: Explainable Blast Radius Impact Engine
    // ========================================================
    console.log("\n--- Group B: Explainable Blast Radius Assessment ---");

    await runTestCase('C2-B1', 'Isolated Leaf Node evaluates to ISOLATED with static boundary caveat', async () => {
      const mockRunner = async (args) => {
        const cmd = args[0];
        if (cmd === 'query') return JSON.stringify([{ node: { name: 'leafHelper', filePath: 'src/utils/leaf.js', startLine: 1, endLine: 5 } }]);
        if (cmd === 'impact') {
          return JSON.stringify({
            symbol: 'leafHelper',
            blastRadius: 'LOW',
            affected: [{ name: 'leafHelper', kind: 'function', filePath: 'src/utils/leaf.js', startLine: 1 }]
          });
        }
        return JSON.stringify({ symbol: args[1], callers: [], callees: [] });
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const engine = new CallGraphEngine(adapter);

      const assessment = await engine.assessBlastRadius('leafHelper');
      assert.strictEqual(assessment.assessedBlastRadius, 'ISOLATED');
      assert.strictEqual(assessment.confidence, 'HIGH');
      assert.strictEqual(assessment.analysisCompleteness, 'COMPLETE');
      assert.strictEqual(assessment.riskFactors.includes('OBSERVED_ISOLATED_IN_STATIC_GRAPH'), true);
      assert.strictEqual(assessment.rationale.includes('observable static call graph'), true);
    });

    await runTestCase('C2-B2', 'Intermediate Module Component evaluates to MEDIUM risk', async () => {
      const mockRunner = async (args) => {
        const cmd = args[0];
        const sym = args[1];
        if (cmd === 'query') return JSON.stringify([{ node: { name: 'formatResponse', filePath: 'services/formatter.js', startLine: 1, endLine: 20 } }]);
        if (cmd === 'impact') {
          return JSON.stringify({
            symbol: 'formatResponse',
            blastRadius: 'LOW',
            affected: [
              { name: 'formatResponse', kind: 'function', filePath: 'services/formatter.js', startLine: 1 },
              { name: 'helper', kind: 'function', filePath: 'services/helper.js', startLine: 5 },
              { name: 'test_formatter', kind: 'file', filePath: 'tests/test_formatter.js', startLine: 1 },
              { name: 'test_helper', kind: 'file', filePath: 'tests/test_helper.js', startLine: 1 }
            ]
          });
        }
        if (cmd === 'callers') {
          if (sym === 'formatResponse') {
            return JSON.stringify({
              symbol: 'formatResponse',
              callers: [{ name: 'helper', filePath: 'services/helper.js', startLine: 5 }]
            });
          }
          return JSON.stringify({ symbol: sym, callers: [] });
        }
        return JSON.stringify({ symbol: sym, callers: [], callees: [] });
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const engine = new CallGraphEngine(adapter);

      const assessment = await engine.assessBlastRadius('formatResponse');
      assert.strictEqual(assessment.assessedBlastRadius, 'MEDIUM');
      assert.strictEqual(assessment.analysisCompleteness, 'COMPLETE');
      assert.strictEqual(assessment.riskFactors.some(f => f.startsWith('MULTIPLE_TEST_SUITES_AFFECTED')), true);
    });

    await runTestCase('C2-B3', 'Hub node affecting Server Entrypoint & Cross-Module evaluates to CRITICAL', async () => {
      const mockRunner = async (args) => {
        const cmd = args[0];
        if (cmd === 'query') return JSON.stringify([{ node: { name: 'GlobalCore', filePath: 'core/global.js', startLine: 1, endLine: 50 } }]);
        if (cmd === 'impact') {
          return JSON.stringify({
            symbol: 'GlobalCore',
            blastRadius: 'HIGH',
            affected: [
              { name: 'GlobalCore', kind: 'class', filePath: 'core/global.js', startLine: 1 },
              { name: 'server.js', kind: 'file', filePath: 'server.js', startLine: 1 },
              { name: 'task_manager.js', kind: 'file', filePath: 'services/task_manager.js', startLine: 1 },
              { name: 'test_all.js', kind: 'file', filePath: 'tests/test_all.js', startLine: 1 }
            ]
          });
        }
        if (cmd === 'callers') {
          return JSON.stringify({
            symbol: 'GlobalCore',
            callers: [{ name: 'server.js', filePath: 'server.js', startLine: 10 }]
          });
        }
        return JSON.stringify({ symbol: args[1], callers: [], callees: [] });
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const engine = new CallGraphEngine(adapter);

      const assessment = await engine.assessBlastRadius('GlobalCore');
      assert.strictEqual(assessment.assessedBlastRadius, 'CRITICAL');
      assert.strictEqual(assessment.riskFactors.some(f => f.startsWith('PRODUCTION_ENTRYPOINT_AFFECTED')), true);
      assert.strictEqual(assessment.riskFactors.some(f => f.startsWith('CROSS_MODULE_IMPACT')), true);
      assert.strictEqual(assessment.affectedSummary.entrypoints.includes('server.js'), true);
    });

    await runTestCase('C2-B4', 'Incomplete dynamic calls set analysisCompleteness to INCOMPLETE orthogonally', async () => {
      const mockRunner = async (args) => {
        const cmd = args[0];
        if (cmd === 'impact') {
          throw new Error('Graph traversal truncated due to dynamic eval()');
        }
        return JSON.stringify({ symbol: args[1], callers: [], callees: [] });
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const engine = new CallGraphEngine(adapter);

      const assessment = await engine.assessBlastRadius('dynamicFunction');
      // Incomplete analysis is strictly separated into analysisCompleteness
      assert.strictEqual(assessment.analysisCompleteness, 'INCOMPLETE');
      assert.strictEqual(assessment.confidence, 'LOW');
      assert.strictEqual(assessment.riskFactors.includes('INCOMPLETE_STATIC_ANALYSIS'), true);
      assert.strictEqual(typeof assessment.assessedBlastRadius, 'string');
    });

    // ========================================================
    // Group C: Line Provenance Verification
    // ========================================================
    console.log("\n--- Group C: Line Provenance Verification ---");

    const sampleFile = path.join(tempDir, 'sample_module.js');
    await fs.writeFile(
      sampleFile,
      [
        '// Header comment',
        'const config = { active: true };',
        '',
        'class ServiceWorker {',
        '  constructor() {',
        '    this.ready = true;',
        '  }',
        '  start() {',
        '    return true;',
        '  }',
        '}',
        '',
        'module.exports = ServiceWorker;'
      ].join('\n'),
      'utf8'
    );
    const relSampleFile = path.relative(projectRoot, sampleFile);

    await runTestCase('C2-C1', 'Accurate line coordinates verify with status VERIFIED', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const engine = new CallGraphEngine(adapter);

      const evidence = await engine.verifyLineProvenance({
        name: 'ServiceWorker',
        filePath: relSampleFile,
        startLine: 4,
        endLine: 11
      });

      assert.strictEqual(evidence.validationStatus, 'VERIFIED');
      assert.strictEqual(evidence.confidence, 'HIGH');
      assert.strictEqual(evidence.analysisCompleteness, 'COMPLETE');
      assert.strictEqual(evidence.verifiedInIndex, true);
      assert.strictEqual(typeof evidence.fileSha256, 'string');
      assert.strictEqual(evidence.fileSha256.length, 64);
      assert.strictEqual(typeof evidence.snippetSha256, 'string');
      assert.strictEqual(evidence.snippetSha256.length, 64);
    });

    await runTestCase('C2-C2', 'Line coordinates exceeding physical file bounds flag OUT_OF_BOUNDS', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const engine = new CallGraphEngine(adapter);

      const evidence = await engine.verifyLineProvenance({
        name: 'ServiceWorker',
        filePath: relSampleFile,
        startLine: 1,
        endLine: 999
      });

      assert.strictEqual(evidence.validationStatus, 'OUT_OF_BOUNDS');
      assert.notStrictEqual(evidence.validationStatus, 'VERIFIED');
      assert.strictEqual(evidence.confidence, 'LOW');
    });

    await runTestCase('C2-C3', 'Coordinates missing target symbol flag MISMATCH (code drift)', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const engine = new CallGraphEngine(adapter);

      const evidence = await engine.verifyLineProvenance({
        name: 'ServiceWorker',
        filePath: relSampleFile,
        startLine: 1,
        endLine: 2
      });

      assert.strictEqual(evidence.validationStatus, 'MISMATCH');
      assert.notStrictEqual(evidence.validationStatus, 'VERIFIED');
      assert.strictEqual(evidence.reason.includes('Code has drifted'), true);
    });

    await runTestCase('C2-C4', 'File modification after index creation flags STALE', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const engine = new CallGraphEngine(adapter);

      const pastIndexTimestamp = Date.now() - 3600 * 1000;

      const evidence = await engine.verifyLineProvenance(
        {
          name: 'ServiceWorker',
          filePath: relSampleFile,
          startLine: 4,
          endLine: 11
        },
        { indexTimestamp: pastIndexTimestamp }
      );

      assert.strictEqual(evidence.validationStatus, 'STALE');
      assert.strictEqual(evidence.confidence, 'MEDIUM');
      assert.strictEqual(evidence.reason.includes('File was modified on disk'), true);
    });

    await runTestCase('C2-C5', 'Non-existent symbol or file flags UNVERIFIED', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const engine = new CallGraphEngine(adapter);

      const evidence = await engine.verifyLineProvenance({
        name: 'GhostSymbol',
        filePath: 'non/existent/path.js',
        startLine: 1,
        endLine: 10
      });

      assert.strictEqual(evidence.validationStatus, 'UNVERIFIED');
      assert.strictEqual(evidence.verifiedInIndex, false);
      assert.strictEqual(evidence.confidence, 'LOW');
    });

    // ========================================================
    // Group D: Real TaskManager Assessment
    // ========================================================
    console.log("\n--- Group D: Real TaskManager Assessment ---");

    await runTestCase('C2-D1', 'Real local TaskManager evaluates correctly with Entrypoint & Tests', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const engine = new CallGraphEngine(adapter);

      const assessment = await engine.assessBlastRadius('TaskManager');
      console.log(`    TaskManager Assessed Risk: ${assessment.assessedBlastRadius} (Confidence: ${assessment.confidence}, Completeness: ${assessment.analysisCompleteness})`);
      console.log(`    Identified Risk Factors: ${assessment.riskFactors.join(', ')}`);
      console.log(`    Rationale: ${assessment.rationale}`);

      assert.strictEqual(['HIGH', 'CRITICAL'].includes(assessment.assessedBlastRadius), true);
      assert.strictEqual(assessment.affectedSummary.entrypoints.includes('server.js'), true);
      assert.strictEqual(assessment.affectedSummary.tests.length >= 2, true);

      const lineEvidence = await engine.verifyLineProvenance('TaskManager');
      assert.strictEqual(['VERIFIED', 'STALE'].includes(lineEvidence.validationStatus), true);
      console.log(`    TaskManager Line Provenance Status: ${lineEvidence.validationStatus} (Lines [${lineEvidence.lineRange.join(', ')}])`);
    });

  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log("\n==================================================");
  console.log(`[P1-C2 Test Summary] Passed: ${passedCount}, Failed: ${failedCount}`);
  console.log("==================================================");

  if (failedCount > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAll().catch(err => {
    console.error("Fatal Test Suite Error:", err);
    process.exit(1);
  });
}

module.exports = { runAll };
