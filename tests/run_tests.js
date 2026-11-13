/**
 * P0-B Step 2.1: Robust Deterministic Test Runner for Model Hub Agent
 * 
 * Key Architectural Upgrades:
 * 1. Bidirectional Manifest Verification:
 *    - Forward: Detects any uncataloged tests on disk.
 *    - Reverse: Detects any registered tests in the manifest that do not exist on disk.
 *    - Strict Mode: Halts execution if manifest integrity is compromised.
 * 2. Child Process Robustness:
 *    - Handles process startup errors ('error' event).
 *    - Handles signal termination ('close' event with signal).
 *    - Per-suite timeout watchdog (default 30s) with graceful SIGTERM and forceful SIGKILL.
 * 3. Execution Modes:
 *    - Default / `npm test`: Executes deterministic OFFLINE_SUITES.
 *    - `--external` / `npm run test:external`: Executes EXTERNAL_SUITES.
 *    - `--check-only`: Validates bidirectional manifest integrity and exits immediately.
 *    - `--strict-manifest`: Mandates zero manifest discrepancies before running tests.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 1. 固定離線單元測試清單 (Deterministic Offline Suites - 100% Mocked & Fast)
const OFFLINE_SUITES = [
  'test_fail_closed.js',
  'test_guardrail.js',
  'test_silent_fix.js',
  'test_compression.js',
  'test_self_correction_flow.js',
  'test_circuit_breaker.js',
  'test_global_state.js',
  'test_error_taxonomy.js',
  'test_router_health_state_machine.js',
  'test_router_cascading_integration.js',
  'test_role_manager.js',
  'test_role_integration.js',
  'test_async_task_manager.js',
  'test_async_task_integration.js',
  'test_codegraph_adapter.js',
  'test_codegraph_impact.js',
  'test_context_planning_budget.js',
  'test_evidence_admission_compiler.js',
  'test_isolation_degradation_matrix.js',
  'test_c4_pipeline_wiring.js'
];

// 2. 外部依賴整合測試清單 (External Integration & Provider Diagnostics)
const EXTERNAL_SUITES = [
  'test_advanced_features.js',
  'test_all_models.js',
  'test_ecc_features.js',
  'test_fuzzy_memory.js',
  'test_gcp_project.js',
  'test_gemini_models.js',
  'test_integration.js',
  'test_markitdown.js',
  'test_markitdown_agent.js',
  'test_model_selection.js',
  'test_nvidia.js',
  'test_raw_response.js',
  'test_regions.js',
  'test_vertex_ai.js'
];

// 3. 診斷與輔助腳本清單 (Utility & Diagnostic Scripts)
const UTILITY_SCRIPTS = [
  'analyze_ac_rpd.js',
  'benchmark_runner.js',
  'check_enabled_apis.js',
  'diagnose_keys.js',
  'enable_vertex_api.js',
  'generate_ams_schema.js',
  'list_vertex_models.js',
  'run_tests.js'
];

/**
 * 雙向完整性防漏檢查 (Bidirectional Manifest Integrity Check)
 * 1. 正向檢查：磁碟上的 JS 檔案是否均已登記。
 * 2. 反向檢查：Manifest 登記的項目是否實際存在於磁碟上。
 */
function verifyTestInventory(testsDir) {
  const allEntries = fs.readdirSync(testsDir);
  const diskJsFiles = new Set(allEntries.filter(f => f.endsWith('.js')));
  
  const allRegistered = [
    ...OFFLINE_SUITES,
    ...EXTERNAL_SUITES,
    ...UTILITY_SCRIPTS
  ];
  const registeredSet = new Set(allRegistered);

  // 正向：磁碟上有，但清單未登記
  const uncataloged = [...diskJsFiles].filter(f => !registeredSet.has(f));
  const uncatalogedTests = uncataloged.filter(f => f.startsWith('test_'));

  // 反向：清單已登記，但磁碟上不存在 (Dangling Manifest References)
  const missingFiles = allRegistered.filter(f => !diskJsFiles.has(f));
  const missingOffline = OFFLINE_SUITES.filter(f => !diskJsFiles.has(f));
  const missingExternal = EXTERNAL_SUITES.filter(f => !diskJsFiles.has(f));

  return {
    totalDiskFiles: diskJsFiles.size,
    offlineCount: OFFLINE_SUITES.length,
    externalCount: EXTERNAL_SUITES.length,
    utilityCount: UTILITY_SCRIPTS.length,
    uncataloged,
    uncatalogedTests,
    missingFiles,
    missingOffline,
    missingExternal,
    isClean: uncatalogedTests.length === 0 && missingFiles.length === 0
  };
}

/**
 * 獨立子行程執行單一測試檔案 (具備 Timeout 看門狗與 Signal 健全防護)
 */
function runSuite(suiteFile, testsDir, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const fullPath = path.join(testsDir, suiteFile);
    const startTime = Date.now();

    if (!fs.existsSync(fullPath)) {
      return resolve({
        suiteFile,
        exitCode: 1,
        signal: null,
        passed: false,
        durationMs: 0,
        error: `File not found: ${fullPath}`
      });
    }

    let isSettled = false;
    let timer = null;

    const child = spawn(process.execPath, [fullPath], {
      cwd: path.resolve(testsDir, '..'),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['inherit', 'pipe', 'pipe']
    });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk;
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk;
      process.stderr.write(chunk);
    });

    // 超時看門狗 (Timeout Watchdog)
    timer = setTimeout(() => {
      if (!isSettled) {
        console.error(`\n⏰ [TIMEOUT] tests/${suiteFile} 超過 ${timeoutMs}ms 未結束，強制發送 SIGTERM 終止...`);
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!isSettled) {
            console.error(`💥 [FORCE KILL] tests/${suiteFile} 無法正常退出，發送 SIGKILL...`);
            child.kill('SIGKILL');
          }
        }, 2000);
      }
    }, timeoutMs);

    child.on('close', (code, signal) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);

      const durationMs = Date.now() - startTime;
      const passed = code === 0 && signal === null;

      resolve({
        suiteFile,
        exitCode: code !== null ? code : 1,
        signal,
        passed,
        durationMs,
        stdoutData,
        stderrData
      });
    });

    child.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);

      const durationMs = Date.now() - startTime;
      console.error(`💥 [SPAWN ERROR] 無法啟動子行程 tests/${suiteFile}: ${err.message}`);
      resolve({
        suiteFile,
        exitCode: 1,
        signal: null,
        passed: false,
        durationMs,
        error: err.message
      });
    });
  });
}

/**
 * 主執行入口
 */
async function main() {
  const testsDir = __dirname;
  const runnerStartTime = Date.now();

  const isCheckOnly = process.argv.includes('--check-only');
  const isStrict = process.argv.includes('--strict-manifest');
  const runExternal = process.argv.includes('--external');
  const runAll = process.argv.includes('--all');

  console.log("================================================================================");
  console.log("🚀 [Test Runner] Antigravity Model Hub Agent - P0-B Step 3.2 Test Suite");
  console.log("================================================================================\n");

  // 1. 雙向完整性防漏檢查
  console.log("🔍 [Phase 1] 測試目錄雙向完整性盤點檢查 (Bidirectional Manifest Check)...");
  const inventory = verifyTestInventory(testsDir);
  console.log(`   磁碟總 JS 檔案數: ${inventory.totalDiskFiles}`);
  console.log(`   - 離線單元測試 (OFFLINE): ${inventory.offlineCount}`);
  console.log(`   - 外部整合測試 (EXTERNAL): ${inventory.externalCount}`);
  console.log(`   - 工具/診斷腳本 (UTILITY):  ${inventory.utilityCount}`);

  let hasManifestError = false;

  // 正向檢查：未登記的測試
  if (inventory.uncatalogedTests.length > 0) {
    hasManifestError = true;
    console.warn("\n⚠️  [WARNING] 發現未列入清單的測試檔案 (Uncataloged Test on Disk):");
    inventory.uncatalogedTests.forEach(f => console.warn(`   - tests/${f}`));
    console.warn("   請將新測試登記至 OFFLINE_SUITES 或 EXTERNAL_SUITES，避免靜默遺漏！\n");
  }

  // 反向檢查：已登記但檔案不存在
  if (inventory.missingFiles.length > 0) {
    hasManifestError = true;
    console.error("\n❌ [ERROR] Manifest 登記之檔案在磁碟上不存在 (Dangling Reference):");
    inventory.missingFiles.forEach(f => console.error(`   - tests/${f}`));
    console.error("   請清理無效登記或補齊檔案，避免執行不存在的測試！\n");
  }

  if (inventory.isClean) {
    console.log("   ✅ 測試清單雙向完整：無未分類測試，無無效登記項目。\n");
  }

  // 若為純檢查模式 (--check-only)
  if (isCheckOnly) {
    if (hasManifestError) {
      console.error("❌ [CHECK-ONLY] 完整性檢查未通過，程序終止 (Exit: 1)。");
      process.exit(1);
    } else {
      console.log("🎯 [CHECK-ONLY] 雙向完整性檢查完全通過，正常退出 (Exit: 0)。");
      process.exit(0);
    }
  }

  // 若指定 --strict-manifest，發現問題時立即阻擋
  if (isStrict && hasManifestError) {
    console.error("❌ [STRICT ERROR] 啟用 --strict-manifest，Manifest 存在差異，拒絕繼續執行 (Exit: 1)。");
    process.exit(1);
  }

  // 2. 確定執行目標清單
  let suitesToRun = [];
  let suiteTypeLabel = "離線單元測試 (OFFLINE)";

  if (runAll) {
    suitesToRun = [...OFFLINE_SUITES, ...EXTERNAL_SUITES];
    suiteTypeLabel = "全套測試 (OFFLINE + EXTERNAL)";
  } else if (runExternal) {
    suitesToRun = EXTERNAL_SUITES;
    suiteTypeLabel = "外部整合測試 (EXTERNAL)";
  } else {
    suitesToRun = OFFLINE_SUITES;
    suiteTypeLabel = "離線單元測試 (OFFLINE)";
  }

  console.log(`⚡ [Phase 2] 逐一執行測試套件: ${suiteTypeLabel} (共 ${suitesToRun.length} 套件)...`);
  const results = [];

  for (const suite of suitesToRun) {
    console.log(`\n▶️  [RUNNING] tests/${suite}`);
    const res = await runSuite(suite, testsDir, 30000);
    results.push(res);
    if (res.passed) {
      console.log(`✨ [SUITE PASSED] tests/${suite} (${res.durationMs}ms, Exit: ${res.exitCode})`);
    } else {
      const signalMsg = res.signal ? ` (Signal: ${res.signal})` : '';
      console.error(`💥 [SUITE FAILED] tests/${suite} (${res.durationMs}ms, Exit: ${res.exitCode}${signalMsg})`);
      if (res.error) console.error(`   錯誤原因: ${res.error}`);
    }
  }

  // 3. 匯總輸出報表
  const totalDuration = Date.now() - runnerStartTime;
  const passedSuites = results.filter(r => r.passed);
  const failedSuites = results.filter(r => !r.passed);

  console.log("\n================================================================================");
  console.log("📊 [Phase 3] 執行成果匯總 (Execution Summary)");
  console.log("================================================================================");

  results.forEach((r, idx) => {
    const statusIcon = r.passed ? "✅ PASS" : "❌ FAIL";
    const padName = r.suiteFile.padEnd(30, ' ');
    const padTime = `${r.durationMs}ms`.padStart(8, ' ');
    const signalMsg = r.signal ? `[Signal: ${r.signal}]` : '';
    console.log(` ${idx + 1}. [${statusIcon}] ${padName} | 耗時: ${padTime} | Exit: ${r.exitCode} ${signalMsg}`);
  });

  console.log("--------------------------------------------------------------------------------");
  console.log(`總測試套件數: ${results.length} | 通過: ${passedSuites.length} | 失敗: ${failedSuites.length}`);
  console.log(`總執行耗時: ${(totalDuration / 1000).toFixed(2)}s`);
  console.log("================================================================================\n");

  // 4. 正確設定整體 Exit Code
  if (failedSuites.length > 0) {
    console.error(`❌ [TEST RUNNER] 存在 ${failedSuites.length} 個失敗的測試套件，終止並回傳 Exit Code: 1`);
    process.exit(1);
  } else {
    console.log("🎉 [TEST RUNNER] 所有目標測試套件全數通過！回傳 Exit Code: 0");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("❌ Fatal runner crash:", err);
  process.exit(1);
});
