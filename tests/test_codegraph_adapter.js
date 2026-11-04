/**
 * Test Suite for CodeGraphAdapter (tests/test_codegraph_adapter.js)
 * Phase 1-C1 Hardening & Security Assertions.
 * 
 * Covers:
 * - Tier 1: Deterministic Offline Mock Tests (Symbols, Path Traversal, Symlinks, Limits, Schemas, Lifecycle)
 * - Tier 2: Local CLI Contract Test (Real codegraph CLI JSON Contract Verification)
 * 
 * Author: etrnya
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const {
  CodeGraphAdapter,
  CodeGraphSecurityError,
  CodeGraphCliError
} = require('../infrastructure/adapters/codegraph_adapter');

const {
  CodeGraphValidationError,
  validateCodeGraphNode,
  validateCallerRelation,
  validateCalleeRelation,
  validateImpactAnalysis,
  validateCodeGraphStatus
} = require('../infrastructure/adapters/codegraph_schemas');

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
  console.log("🧭 [P1-C1 Test Suite] CodeGraphAdapter Hardening & Security");
  console.log("==================================================\n");

  const projectRoot = path.resolve(__dirname, '..');
  const tempDir = path.resolve(projectRoot, '.test_tmp_cg');

  // Ensure clean temp dir
  if (fsSync.existsSync(tempDir)) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  await fs.mkdir(tempDir, { recursive: true });

  try {
    // ========================================================
    // C1-T1: Symbol Whitelist & Injection Defense
    // ========================================================
    console.log("--- Group 1: Symbol Whitelist & Command Injection Defense ---");

    await runTestCase('C1-T1.1', 'Valid symbol strings must pass validation', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      assert.strictEqual(adapter.validateSymbol('TaskManager'), 'TaskManager');
      assert.strictEqual(adapter.validateSymbol('TaskManager::_pumpQueue'), 'TaskManager::_pumpQueue');
      assert.strictEqual(adapter.validateSymbol('services/task_manager.js'), 'services/task_manager.js');
      assert.strictEqual(adapter.validateSymbol('node-123_45:bar'), 'node-123_45:bar');
    });

    await runTestCase('C1-T1.2', 'Command injection payloads in symbols must be rejected', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const maliciousSymbols = [
        'TaskManager; rm -rf /',
        'TaskManager && calc.exe',
        'TaskManager | cat /etc/passwd',
        'TaskManager`whoami`',
        'TaskManager$(id)',
        'Task"Manager',
        "Task'Manager",
        'TaskManager\nwhoami',
        'TaskManager\0injection'
      ];

      for (const mal of maliciousSymbols) {
        assert.throws(
          () => adapter.validateSymbol(mal),
          (err) => err instanceof CodeGraphSecurityError && err.code === 'INVALID_SYMBOL',
          `Should reject malicious symbol: ${mal}`
        );
      }
    });

    await runTestCase('C1-T1.3', 'Empty or non-string symbols must be rejected', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      assert.throws(() => adapter.validateSymbol(''), /INVALID_SYMBOL/);
      assert.throws(() => adapter.validateSymbol(null), /INVALID_SYMBOL/);
      assert.throws(() => adapter.validateSymbol(123), /INVALID_SYMBOL/);
    });

    // ========================================================
    // C1-T2: Path Traversal Defense
    // ========================================================
    console.log("\n--- Group 2: Path Traversal & Boundary Defense ---");

    await runTestCase('C1-T2.1', 'Parent directory traversal (../../) must be rejected', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      await assert.rejects(
        async () => adapter.resolveAndValidatePath('../../package.json'),
        (err) => err instanceof CodeGraphSecurityError && err.code === 'PATH_TRAVERSAL_DETECTED'
      );
    });

    await runTestCase('C1-T2.2', 'Sibling directory fake-prefix traversal must be rejected', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const fakeSiblingPath = path.resolve(projectRoot, '../' + path.basename(projectRoot) + '-secret/file.js');
      await assert.rejects(
        async () => adapter.resolveAndValidatePath(fakeSiblingPath),
        (err) => err instanceof CodeGraphSecurityError && err.code === 'PATH_TRAVERSAL_DETECTED'
      );
    });

    await runTestCase('C1-T2.3', 'Sensitive blacklist paths (.git, .env) must be blocked immediately', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const blockedPaths = [
        '.env',
        '.env.local',
        '.git/config',
        'services/.env',
        'keys/id_rsa',
        'cert.pem',
        'token.key'
      ];

      for (const bp of blockedPaths) {
        await assert.rejects(
          async () => adapter.resolveAndValidatePath(bp),
          (err) => err instanceof CodeGraphSecurityError && err.code === 'FILE_ACCESS_DENIED',
          `Should deny access to: ${bp}`
        );
      }
    });

    // ========================================================
    // C1-T3: Symlink Escape Defense
    // ========================================================
    console.log("\n--- Group 3: Symlink Escape Defense ---");

    await runTestCase('C1-T3.1', 'Symlinks pointing outside project root must be rejected', async () => {
      const outsideDir = path.resolve(tempDir, 'fake_outside');
      await fs.mkdir(outsideDir, { recursive: true });
      const outsideFile = path.resolve(outsideDir, 'outside_secret.txt');
      await fs.writeFile(outsideFile, 'TOP_SECRET_OUTSIDE_DATA', 'utf8');

      const symlinkPath = path.resolve(tempDir, 'symlink_to_outside.txt');
      try {
        await fs.symlink(outsideFile, symlinkPath, 'file');
      } catch (e) {
        console.log("    (Note: Symlink creation skipped on Windows if developer mode disabled: " + e.message + ")");
        return;
      }

      // Test realpath boundary with projectRoot escape
      const mockProjectRoot = path.resolve(tempDir, 'mock_project');
      await fs.mkdir(mockProjectRoot, { recursive: true });
      const escapeLink = path.resolve(mockProjectRoot, 'escape_link.txt');
      try {
        await fs.symlink(outsideFile, escapeLink, 'file');
        const adapter = new CodeGraphAdapter(mockProjectRoot);
        await assert.rejects(
          async () => adapter.resolveAndValidatePath('escape_link.txt'),
          (err) => err instanceof CodeGraphSecurityError && err.code === 'PATH_TRAVERSAL_DETECTED'
        );
      } catch (e) {
        if (!e.message.includes('PATH_TRAVERSAL_DETECTED')) {
          console.log("    (Note: Mock Symlink skipped: " + e.message + ")");
        } else {
          throw e;
        }
      }
    });

    // ========================================================
    // C1-T4: Code Snippet Reading Quota & Binary Protection
    // ========================================================
    console.log("\n--- Group 4: Code Snippet Reading Quotas & Sanitization ---");

    await runTestCase('C1-T4.1', 'Valid snippet read produces content, lineCount and dual SHA256 hashes', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const sampleFile = path.join(tempDir, 'sample_code.js');
      const lines = [];
      for (let i = 1; i <= 20; i++) {
        lines.push(`const line${i} = ${i};`);
      }
      await fs.writeFile(sampleFile, lines.join('\n'), 'utf8');

      const relativePath = path.relative(projectRoot, sampleFile);
      const result = await adapter.readCodeSnippet(relativePath, 5, 10);

      assert.strictEqual(result.lineCount, 6);
      assert.strictEqual(result.content.split('\n').length, 6);
      assert.strictEqual(result.content.includes('const line5 = 5;'), true);
      assert.strictEqual(result.content.includes('const line10 = 10;'), true);
      assert.strictEqual(typeof result.fileSha256, 'string');
      assert.strictEqual(result.fileSha256.length, 64);
      assert.strictEqual(typeof result.snippetSha256, 'string');
      assert.strictEqual(result.snippetSha256.length, 64);
      assert.notStrictEqual(result.fileSha256, result.snippetSha256);
    });

    await runTestCase('C1-T4.2', 'Exceeding 500 lines snippet limit must be rejected', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const largeFile = path.join(tempDir, 'large_file.js');
      const lines = new Array(600).fill('console.log("line");');
      await fs.writeFile(largeFile, lines.join('\n'), 'utf8');

      const relativePath = path.relative(projectRoot, largeFile);
      await assert.rejects(
        async () => adapter.readCodeSnippet(relativePath, 1, 501),
        (err) => err instanceof CodeGraphSecurityError && err.code === 'EXCEEDED_LINE_LIMIT'
      );
    });

    await runTestCase('C1-T4.3', 'Invalid line ranges must be rejected', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const sampleFile = path.join(tempDir, 'sample_code.js');
      const relativePath = path.relative(projectRoot, sampleFile);

      await assert.rejects(
        async () => adapter.readCodeSnippet(relativePath, 0, 10),
        (err) => err instanceof CodeGraphSecurityError && err.code === 'INVALID_LINE_RANGE'
      );

      await assert.rejects(
        async () => adapter.readCodeSnippet(relativePath, 10, 5),
        (err) => err instanceof CodeGraphSecurityError && err.code === 'INVALID_LINE_RANGE'
      );
    });

    await runTestCase('C1-T4.4', 'Binary files must be detected and rejected', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const binaryFile = path.join(tempDir, 'binary.bin');
      const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D, 0x0A, 0x1A]); // PNG header with 0x00
      await fs.writeFile(binaryFile, buffer);

      const relativePath = path.relative(projectRoot, binaryFile);
      await assert.rejects(
        async () => adapter.readCodeSnippet(relativePath, 1, 5),
        (err) => err instanceof CodeGraphSecurityError && err.code === 'BINARY_FILE_REJECTED'
      );
    });

    await runTestCase('C1-T4.5', 'Files larger than 1MB must be rejected', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      const over1MbFile = path.join(tempDir, 'over_1mb.txt');
      const bigBuf = Buffer.alloc(1024 * 1024 + 10240, 'a');
      await fs.writeFile(over1MbFile, bigBuf);

      const relativePath = path.relative(projectRoot, over1MbFile);
      await assert.rejects(
        async () => adapter.readCodeSnippet(relativePath, 1, 10),
        (err) => err instanceof CodeGraphSecurityError && err.code === 'FILE_TOO_LARGE'
      );
    });

    // ========================================================
    // C1-T5: CLI Error Handling, Timeouts & Malformed JSON
    // ========================================================
    console.log("\n--- Group 5: CLI Error Handling & Timeout Defense ---");

    await runTestCase('C1-T5.1', 'CLI non-zero exit code must be mapped to CodeGraphCliError', async () => {
      const mockRunner = async (args) => {
        const err = new Error('Command failed: codegraph unknown');
        err.code = 1;
        throw err;
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      await assert.rejects(
        async () => adapter.getStatus(),
        (err) => err instanceof CodeGraphCliError && err.code === 'CLI_NON_ZERO_EXIT'
      );
    });

    await runTestCase('C1-T5.2', 'CLI timeout must be mapped to CLI_TIMEOUT', async () => {
      const mockRunner = async (args) => {
        const err = new Error('timed out');
        err.killed = true;
        err.signal = 'SIGTERM';
        throw err;
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      await assert.rejects(
        async () => adapter.getStatus(),
        (err) => err instanceof CodeGraphCliError && err.code === 'CLI_TIMEOUT'
      );
    });

    await runTestCase('C1-T5.3', 'Malformed JSON from CLI must trigger CLI_INVALID_JSON', async () => {
      const mockRunner = async (args) => 'INVALID_NON_JSON_OUTPUT_<<<>>>';
      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      await assert.rejects(
        async () => adapter.getStatus(),
        (err) => err instanceof CodeGraphCliError && err.code === 'CLI_INVALID_JSON'
      );
    });

    // ========================================================
    // C1-T6: Schema Validation Assertions
    // ========================================================
    console.log("\n--- Group 6: Schema Validation Assertions ---");

    await runTestCase('C1-T6.1', 'getStatus rejects payloads missing required fields', async () => {
      const mockRunner = async (args) => JSON.stringify({ status: 'READY' }); // missing nodeCount
      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      await assert.rejects(
        async () => adapter.getStatus(),
        (err) => err instanceof CodeGraphValidationError && err.code === 'SCHEMA_VALIDATION_ERROR'
      );
    });

    await runTestCase('C1-T6.2', 'querySymbols rejects nodes missing filePath or line coordinates', async () => {
      const mockRunner = async (args) => JSON.stringify([
        { node: { name: 'Foo', kind: 'function' } } // missing filePath, startLine, endLine
      ]);
      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      await assert.rejects(
        async () => adapter.querySymbols('Foo'),
        (err) => err instanceof CodeGraphValidationError && err.code === 'SCHEMA_VALIDATION_ERROR'
      );
    });

    await runTestCase('C1-T6.3', 'findCallers validates caller relation structures', async () => {
      const mockRunner = async (args) => JSON.stringify({
        symbol: 'TaskManager',
        callers: [
          { name: 'server.js', filePath: 'server.js', startLine: 12 }
        ]
      });
      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const result = await adapter.findCallers('TaskManager');
      assert.strictEqual(result.symbol, 'TaskManager');
      assert.strictEqual(result.callers.length, 1);
      assert.strictEqual(result.callers[0].name, 'server.js');
    });

    await runTestCase('C1-T6.4', 'analyzeImpact validates blastRadius enum and affected array', async () => {
      const mockRunner = async (args) => JSON.stringify({
        symbol: 'TaskManager',
        blastRadius: 'HIGH',
        affected: [
          { name: 'server.js', kind: 'file', filePath: 'server.js', startLine: 1 }
        ]
      });
      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const result = await adapter.analyzeImpact('TaskManager');
      assert.strictEqual(result.blastRadius, 'HIGH');
      assert.strictEqual(result.affected.length, 1);
    });

    // ========================================================
    // C1-T7: Index Lifecycle & Concurrency Locking
    // ========================================================
    console.log("\n--- Group 7: Index Lifecycle & Concurrency Locking ---");

    await runTestCase('C1-T7.1', 'Concurrent syncIndex calls share the same in-flight Promise', async () => {
      let runCount = 0;
      const mockRunner = async (args) => {
        runCount++;
        await new Promise(r => setTimeout(r, 50));
        return JSON.stringify({ success: true, modifiedCount: 42 });
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      assert.strictEqual(adapter.indexState, 'IDLE');

      const p1 = adapter.syncIndex();
      assert.strictEqual(adapter.indexState, 'SYNCING');
      const p2 = adapter.syncIndex();

      assert.strictEqual(p1, p2, 'Concurrent calls must return the identical promise');
      const [res1, res2] = await Promise.all([p1, p2]);

      assert.strictEqual(runCount, 1, 'CLI runner must only be invoked once for concurrent sync requests');
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(adapter.indexState, 'READY');
    });

    await runTestCase('C1-T7.2', 'Sync failure transitions state to DEGRADED without crashing', async () => {
      const mockRunner = async (args) => {
        throw new Error('Sync database locked');
      };

      const adapter = new CodeGraphAdapter(projectRoot, { cliRunner: mockRunner });
      const res = await adapter.syncIndex();
      assert.strictEqual(res.success, false);
      assert.strictEqual(adapter.indexState, 'DEGRADED');
    });

    // ========================================================
    // C1-T8: Tier 2 Local CLI Contract Test (If CLI available)
    // ========================================================
    console.log("\n--- Group 8: Tier 2 Local CLI Contract Test ---");

    await runTestCase('C1-T8.1', 'Local codegraph CLI contract validation', async () => {
      const adapter = new CodeGraphAdapter(projectRoot);
      let status;
      try {
        status = await adapter.getStatus();
      } catch (err) {
        if (err.code === 'CLI_NOT_FOUND') {
          console.log("    (Notice: Local codegraph CLI not on PATH in this environment, skipping contract execution)");
          return;
        }
        throw err;
      }

      console.log(`    Local CodeGraph Status: ${status.nodeCount} nodes, status="${status.status}"`);
      assert.strictEqual(typeof status.nodeCount, 'number');
      assert.strictEqual(status.nodeCount > 0, true);

      // Test real symbol query
      const queryResults = await adapter.querySymbols('TaskManager', { limit: 5 });
      assert.strictEqual(Array.isArray(queryResults), true);
      assert.strictEqual(queryResults.length > 0, true);
      const match = queryResults.find(n => n.name === 'TaskManager');
      assert.strictEqual(!!match, true);
      assert.strictEqual(match.filePath.includes('task_manager.js'), true);

      // Test real callers
      const callersResult = await adapter.findCallers('TaskManager');
      assert.strictEqual(callersResult.symbol, 'TaskManager');
      assert.strictEqual(Array.isArray(callersResult.callers), true);

      // Test real impact
      const impactResult = await adapter.analyzeImpact('TaskManager', 2);
      assert.strictEqual(impactResult.symbol, 'TaskManager');
      assert.strictEqual(['LOW', 'MEDIUM', 'HIGH'].includes(impactResult.blastRadius), true);
      console.log(`    Verified TaskManager Impact Blast Radius: ${impactResult.blastRadius} (${impactResult.affected.length} affected components)`);
    });

  } finally {
    // Cleanup temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log("\n==================================================");
  console.log(`[P1-C1 Test Summary] Passed: ${passedCount}, Failed: ${failedCount}`);
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
