/**
 * P0-B Step 3: Automated Assertion Test for GlobalState OCC (Optimistic Concurrency Control)
 * 
 * Verifies:
 * 1. [GS1] Normal Version Increment: Legal update increments version and appends change_log.
 * 2. [GS2] Stale Version Rejection: Stale expectedVersion returns false and leaves state unmodified.
 * 3. [GS3] Sequential Multiple Updates: Monotonic version increments without gaps.
 * 4. [GS4] Concurrent Race Conflict Simulation: Controlled promise barrier enforces exactly one winner and one conflict rejection.
 * 5. [GS5] State Consistency on Rejection & Fallback Merge: Verifies state atomicity and merge resolution.
 * 6. [GS6] Deep Clone Snapshot Mutation Isolation: Modifying snapshot cannot corrupt internal state.
 * 
 * Uses node:assert/strict. Exits with non-zero code on any failure.
 */

const assert = require('node:assert/strict');
const GlobalState = require('../shared/global_state');

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
  console.log("🔒 [P0-B Test Suite] GlobalState OCC Assertions");
  console.log("==================================================\n");

  // ----------------------------------------------------
  // GS1: 正常版本遞增 (Normal Version Increment)
  // ----------------------------------------------------
  await runTestCase('GS1', 'Normal Version Increment: Legal update increments version and records change_log', async () => {
    const initialState = {
      task_id: "TASK-100",
      status: "pending",
      result: null
    };

    const state = new GlobalState(initialState);
    const snap1 = state.getSnapshot();

    // 斷言初始狀態契約
    assert.strictEqual(snap1.version, 1, 'Initial version must be exactly 1');
    assert.strictEqual(snap1.task_id, "TASK-100");
    assert.deepStrictEqual(snap1.change_log, [], 'Initial change_log must be empty');

    // 執行合法更新
    const success = state.update({ status: "in_progress", worker: "agent-alpha" }, 1);
    const snap2 = state.getSnapshot();

    // 斷言更新成功與版本遞增
    assert.strictEqual(success, true, 'Legal update with expectedVersion 1 must return true');
    assert.strictEqual(snap2.version, 2, 'Version must increment from 1 to 2');
    assert.strictEqual(snap2.status, "in_progress", 'Status must be updated');
    assert.strictEqual(snap2.worker, "agent-alpha", 'Worker field must be set');
    assert.strictEqual(snap2.task_id, "TASK-100", 'Existing task_id must remain preserved');

    // 斷言變更日誌
    assert.strictEqual(snap2.change_log.length, 1, 'change_log must have 1 entry');
    assert.strictEqual(snap2.change_log[0].version, 2, 'change_log version must match new version');
    assert.deepStrictEqual(snap2.change_log[0].changedFields.sort(), ["status", "worker"].sort(), 'changedFields must record updated keys');
  });

  // ----------------------------------------------------
  // GS2: 舊版本提交衝突拒絕 (Stale Version Rejection)
  // ----------------------------------------------------
  await runTestCase('GS2', 'Stale Version Rejection: Stale expectedVersion returns false and leaves state unmodified', async () => {
    const state = new GlobalState({ counter: 0 });

    // Step 1: 晉升至 Version 2
    const update1 = state.update({ counter: 10, note: "First valid update" }, 1);
    assert.strictEqual(update1, true);
    assert.strictEqual(state.getSnapshot().version, 2);

    // Step 2: 嘗試以過期的 Version 1 提交新資料
    const staleUpdate = state.update({ counter: 999, malicious: "Should be rejected" }, 1);
    const snapAfterStale = state.getSnapshot();

    // 斷言：依照契約回傳 false
    assert.strictEqual(staleUpdate, false, 'Update with stale expectedVersion 1 must return false');

    // 斷言：版本絕不倒退亦不晉升
    assert.strictEqual(snapAfterStale.version, 2, 'Version must remain strictly at 2');

    // 斷言：資料完全未被污染
    assert.strictEqual(snapAfterStale.counter, 10, 'Existing data must not be overwritten');
    assert.strictEqual(snapAfterStale.malicious, undefined, 'Stale fields must not be injected');
    assert.strictEqual(snapAfterStale.change_log.length, 1, 'change_log must NOT append failed attempt');
  });

  // ----------------------------------------------------
  // GS3: 連續多次更新單調性 (Sequential Multiple Updates)
  // ----------------------------------------------------
  await runTestCase('GS3', 'Sequential Multiple Updates: Monotonic version increments without gaps', async () => {
    const state = new GlobalState({ stepCount: 0 });

    for (let i = 1; i <= 5; i++) {
      const ok = state.update({ stepCount: i, lastAction: `action_${i}` }, i);
      assert.strictEqual(ok, true, `Update step ${i} must succeed`);
      assert.strictEqual(state.getSnapshot().version, i + 1, `Version must be ${i + 1}`);
    }

    const finalSnap = state.getSnapshot();
    assert.strictEqual(finalSnap.version, 6, 'Final version must be 6 after 5 updates');
    assert.strictEqual(finalSnap.stepCount, 5);
    assert.strictEqual(finalSnap.change_log.length, 5, 'Must record exactly 5 change_log steps');

    // 驗證 change_log 內版本無跳號
    finalSnap.change_log.forEach((entry, idx) => {
      assert.strictEqual(entry.version, idx + 2, `Log entry ${idx} must record version ${idx + 2}`);
    });
  });

  // ----------------------------------------------------
  // GS4: 併發更新衝突模擬 (Concurrent Race Conflict with Barrier)
  // ----------------------------------------------------
  await runTestCase('GS4', 'Concurrent Race Conflict: Controlled barrier enforces exactly 1 winner and 1 rejection', async () => {
    const state = new GlobalState({ sharedResource: "initial" });
    const snap = state.getSnapshot(); // version: 1

    // 建立可控同步屏障 (Barrier)
    let releaseBarrier;
    const barrierPromise = new Promise((resolve) => {
      releaseBarrier = resolve;
    });

    // 模擬 Session A 與 Session B 同時持有 Version 1 嘗試提交
    const sessionA = async () => {
      await barrierPromise; // 等待發令槍
      return state.update({ sharedResource: "session_A_wins", session: "A" }, snap.version);
    };

    const sessionB = async () => {
      await barrierPromise; // 等待發令槍
      return state.update({ sharedResource: "session_B_wins", session: "B" }, snap.version);
    };

    // 同步觸發併發競賽
    const racePromise = Promise.all([sessionA(), sessionB()]);
    releaseBarrier(); // 釋放屏障

    const [resultA, resultB] = await racePromise;

    // 斷言：必定恰好一個成功，一個失敗
    const successCount = [resultA, resultB].filter(r => r === true).length;
    const failureCount = [resultA, resultB].filter(r => r === false).length;

    assert.strictEqual(successCount, 1, 'Exactly one concurrent session must succeed');
    assert.strictEqual(failureCount, 1, 'Exactly one concurrent session must be rejected with conflict');

    // 斷言：最終版本恰好為 2
    const finalSnap = state.getSnapshot();
    assert.strictEqual(finalSnap.version, 2, 'Version must only increment once from 1 to 2');

    // 斷言：最終資料與成功者完全一致
    if (resultA) {
      assert.strictEqual(finalSnap.sharedResource, "session_A_wins");
      assert.strictEqual(finalSnap.session, "A");
    } else {
      assert.strictEqual(finalSnap.sharedResource, "session_B_wins");
      assert.strictEqual(finalSnap.session, "B");
    }
  });

  // ----------------------------------------------------
  // GS5: 狀態原子性與衝突合併 (State Consistency & Fallback Merge)
  // ----------------------------------------------------
  await runTestCase('GS5', 'State Consistency & Fallback Merge: Manual merge strategy recovers from conflict cleanly', async () => {
    const state = new GlobalState({ payload: "v1_data" }); // version 1
    state.update({ payload: "v2_data" }, 1); // version 2

    // 驗證拒絕時狀態保持一致
    const failedUpdate = state.update({ payload: "stale_attempt" }, 1);
    assert.strictEqual(failedUpdate, false);
    assert.strictEqual(state.getSnapshot().payload, "v2_data");
    assert.strictEqual(state.getSnapshot().version, 2);

    // 測試備援合併策略 (merge fallback)
    const remoteConflictResolution = { payload: "merged_v3_data", resolution: "remote_wins" };
    state.merge(remoteConflictResolution);

    const mergedSnap = state.getSnapshot();
    assert.strictEqual(mergedSnap.version, 3, 'Merge must increment version to 3');
    assert.strictEqual(mergedSnap.payload, "merged_v3_data", 'Remote data must be adopted');
    assert.strictEqual(mergedSnap.resolution, "remote_wins");
    assert.strictEqual(mergedSnap.change_log[mergedSnap.change_log.length - 1].note, "Merged conflict resolution");
  });

  // ----------------------------------------------------
  // GS6: 讀取資料參照深層隔離 (Deep Clone Mutation Isolation)
  // ----------------------------------------------------
  await runTestCase('GS6', 'Deep Clone Snapshot Mutation Isolation: Modifying snapshot cannot corrupt internal state', async () => {
    const state = new GlobalState({
      cluster: "prod-us-east",
      tags: ["active", "secure"],
      nestedConfig: {
        timeout: 5000,
        retries: 3
      }
    });

    const snapshot = state.getSnapshot();

    // 刻意竄改 Snapshot 物件內部深層欄位
    snapshot.cluster = "HACKED_CLUSTER";
    snapshot.tags.push("HACKED_TAG");
    snapshot.nestedConfig.timeout = 999999;
    snapshot.version = 999;

    // 重新取得最新 Snapshot
    const freshSnapshot = state.getSnapshot();

    // 斷言：內部資料完全未受污染
    assert.strictEqual(freshSnapshot.cluster, "prod-us-east", 'Scalar field must remain pristine');
    assert.deepStrictEqual(freshSnapshot.tags, ["active", "secure"], 'Array must not receive pushed items');
    assert.strictEqual(freshSnapshot.nestedConfig.timeout, 5000, 'Nested object field must remain unmodified');
    assert.strictEqual(freshSnapshot.version, 1, 'Version must not be corrupted externally');
  });

  // ----------------------------------------------------
  // GS7: constructor 外部修改 initialData 巢狀物件隔離
  // ----------------------------------------------------
  await runTestCase('GS7', 'Constructor Nested Object Isolation: Mutating source initialData nested object must not leak into GlobalState', async () => {
    const rawInitial = {
      session: {
        role: "admin",
        permissions: { read: true, write: true }
      }
    };

    const state = new GlobalState(rawInitial);

    // 外部惡意修改已傳入的原始物件
    rawInitial.session.role = "hacked_guest";
    rawInitial.session.permissions.write = false;

    // 驗證 GlobalState 內部不受污染
    const current = state.getSnapshot();
    assert.strictEqual(current.session.role, "admin", 'Role must remain admin regardless of external mutations');
    assert.strictEqual(current.session.permissions.write, true, 'Nested write permission must remain true');
    assert.strictEqual(current.version, 1, 'Version must remain 1');
    assert.strictEqual(current.change_log.length, 0, 'No change_log should be created by external mutation');
  });

  // ----------------------------------------------------
  // GS8: constructor 外部修改 initialData 陣列隔離
  // ----------------------------------------------------
  await runTestCase('GS8', 'Constructor Array Isolation: Mutating source initialData array must not leak into GlobalState', async () => {
    const rawInitial = {
      tags: ["security", "audit"],
      allowList: [100, 200]
    };

    const state = new GlobalState(rawInitial);

    // 外部直接修改陣列
    rawInitial.tags.push("unauthorized_tag");
    rawInitial.allowList[0] = 999;

    // 驗證 GlobalState 內部陣列完全獨立
    const current = state.getSnapshot();
    assert.deepStrictEqual(current.tags, ["security", "audit"], 'Tags array must not contain externally pushed elements');
    assert.deepStrictEqual(current.allowList, [100, 200], 'AllowList array must not reflect external in-place modifications');
  });

  // ----------------------------------------------------
  // GS9: update() 後外部修改 newData 巢狀物件隔離
  // ----------------------------------------------------
  await runTestCase('GS9', 'Update Nested Object Isolation: Mutating source newData nested object after update() must not leak', async () => {
    const state = new GlobalState({ app: "agent-os" });

    const updatePayload = {
      dbConfig: {
        host: "prod-db.internal",
        poolSize: 20
      }
    };

    const ok = state.update(updatePayload, 1);
    assert.strictEqual(ok, true, 'Initial update must succeed');

    // 更新完成後，外部改動 updatePayload 內容
    updatePayload.dbConfig.host = "corrupted-db.attacker";
    updatePayload.dbConfig.poolSize = 99999;

    // 驗證 GlobalState 內部不受污染
    const current = state.getSnapshot();
    assert.strictEqual(current.dbConfig.host, "prod-db.internal", 'Host must remain prod-db.internal');
    assert.strictEqual(current.dbConfig.poolSize, 20, 'PoolSize must remain 20');
    assert.strictEqual(current.version, 2, 'Version must be 2');
  });

  // ----------------------------------------------------
  // GS10: update() 後外部修改 newData 陣列隔離
  // ----------------------------------------------------
  await runTestCase('GS10', 'Update Array Isolation: Mutating source newData array after update() must not leak', async () => {
    const state = new GlobalState({ app: "agent-os" });

    const updatePayload = {
      authorizedWorkers: ["worker-1", "worker-2"]
    };

    const ok = state.update(updatePayload, 1);
    assert.strictEqual(ok, true, 'Initial update must succeed');

    // 更新完成後，外部向陣列 push 惡意元素
    updatePayload.authorizedWorkers.push("rogue-worker");
    updatePayload.authorizedWorkers[0] = "mutated-worker";

    // 驗證 GlobalState 內部不受影響
    const current = state.getSnapshot();
    assert.deepStrictEqual(current.authorizedWorkers, ["worker-1", "worker-2"], 'authorizedWorkers must not reflect external mutations');
    assert.strictEqual(current.version, 2);
  });

  // ----------------------------------------------------
  // GS11: #data 原生私有欄位封裝與同名公開屬性完全隔離
  // ----------------------------------------------------
  await runTestCase('GS11', 'Private Field Encapsulation: Mounting public state.data cannot pollute or bypass internal #data', async () => {
    const state = new GlobalState({ service: "auth-gateway", maxConnections: 500 });
    const before = state.getSnapshot();

    // 斷言初始狀態未掛載公開 data 屬性
    assert.strictEqual(state.data, undefined, 'state.data must initially be undefined');

    // 外部嘗試在實例上建立公開屬性以繞過 OCC
    state.data = { version: 999, service: "hacked-service" };
    if (state.data) {
      state.data.version = 888;
      state.data.maxConnections = 999999;
    }

    // 斷言內部狀態完全不受影響
    const after = state.getSnapshot();
    assert.strictEqual(after.version, before.version, 'Internal version must strictly match before state');
    assert.deepStrictEqual(after, before, 'Snapshot must be completely identical to before state');

    // 斷言後續合法更新不受掛載之公開屬性干擾
    const ok = state.update({ maxConnections: 600 }, 1);
    assert.strictEqual(ok, true, 'Subsequent legal update must succeed');
    assert.strictEqual(state.getSnapshot().maxConnections, 600);
    assert.strictEqual(state.getSnapshot().version, 2);
  });

  // ----------------------------------------------------
  // GS12: 唯讀 version getter 行為與不可竄改性驗證
  // ----------------------------------------------------
  await runTestCase('GS12', 'Read-only Version Getter: Returns current version and prevents external modification', async () => {
    const state = new GlobalState({ node: "primary" });

    // 1. 等於 snapshot 的 version
    assert.strictEqual(state.version, 1, 'Initial state.version must be 1');
    assert.strictEqual(state.version, state.getSnapshot().version, 'state.version must match getSnapshot().version');

    // 2. update() 成功後 version 正確遞增
    const ok = state.update({ node: "secondary" }, 1);
    assert.strictEqual(ok, true);
    assert.strictEqual(state.version, 2, 'state.version must increment to 2');
    assert.strictEqual(state.version, state.getSnapshot().version);

    // 3. OCC 衝突後 version 保持不變
    const failUpdate = state.update({ node: "stale" }, 1); // stale version 1
    assert.strictEqual(failUpdate, false);
    assert.strictEqual(state.version, 2, 'state.version must remain 2 after conflict');

    // 4. 外部不能透過 version getter 修改內部版本
    try {
      state.version = 999; // 在 strict mode 下無 setter 會丟出 TypeError
    } catch (e) {
      assert.ok(e instanceof TypeError, 'Writing to getter-only property should throw TypeError in strict mode');
    }
    assert.strictEqual(state.version, 2, 'state.version must strictly remain 2 after illegal assign attempt');
    assert.strictEqual(state.getSnapshot().version, 2);
  });

  // ----------------------------------------------------
  // GS13: update() 傳入 version 遭拒絕，不可覆寫版本控制欄位
  // ----------------------------------------------------
  await runTestCase('GS13', 'Reserved Fields Protection: update() containing version must be rejected', async () => {
    const state = new GlobalState({ app: "gateway", tier: "gold" });
    const snapBefore = state.getSnapshot();

    // 嘗試透過 update 注入 version
    const result = state.update({ app: "updated-gateway", version: 999 }, 1);

    // 斷言：必須拒絕並回傳 false
    assert.strictEqual(result, false, 'update() with reserved field version must return false');

    // 斷言：內部狀態與 version 保持原子性不變，不得局部更新
    const snapAfter = state.getSnapshot();
    assert.strictEqual(state.version, 1, 'state.version must remain 1');
    assert.strictEqual(snapAfter.version, 1, 'Snapshot version must remain 1');
    assert.strictEqual(snapAfter.app, "gateway", 'Data must remain untouched when update is rejected');
    assert.strictEqual(snapAfter.change_log.length, 0, 'change_log must not append any entry');
  });

  // ----------------------------------------------------
  // GS14: update() 傳入 change_log 遭拒絕，不可覆寫或清空稽核日誌
  // ----------------------------------------------------
  await runTestCase('GS14', 'Reserved Fields Protection: update() containing change_log must be rejected', async () => {
    const state = new GlobalState({ service: "auth" });
    // 執行一次合法更新以建立一條歷史紀錄
    const ok = state.update({ service: "auth-v2" }, 1);
    assert.strictEqual(ok, true);
    assert.strictEqual(state.version, 2);
    assert.strictEqual(state.getSnapshot().change_log.length, 1);

    // 嘗試透過 update 清空或竄改 change_log
    const attackResult = state.update({ change_log: [] }, 2);

    // 斷言：必須拒絕並回傳 false
    assert.strictEqual(attackResult, false, 'update() with reserved field change_log must return false');

    // 斷言：稽核紀錄與版本完整保留
    const currentSnap = state.getSnapshot();
    assert.strictEqual(state.version, 2, 'Version must remain 2');
    assert.strictEqual(currentSnap.change_log.length, 1, 'Existing change_log must be preserved intact');
    assert.strictEqual(currentSnap.change_log[0].version, 2);
  });

  // ----------------------------------------------------
  // GS15: merge() 傳入 version 時隔離，本地版本依規則單調遞增
  // ----------------------------------------------------
  await runTestCase('GS15', 'Reserved Fields Protection: merge() must not adopt remote version', async () => {
    const state = new GlobalState({ config: "local-v1" });
    // 晉升至 version 2
    state.update({ config: "local-v2" }, 1);
    assert.strictEqual(state.version, 2);

    // 遠端傳入帶有自訂 version 999 的衝突資料
    state.merge({ config: "remote-v3", version: 999 });

    // 斷言：本地版本只能依本地規則單調遞增 (+1 變成 3)，不得採用遠端 version 999 或跳躍
    assert.strictEqual(state.version, 3, 'Local version must strictly increment by 1 (2 -> 3)');
    assert.strictEqual(state.getSnapshot().version, 3, 'Snapshot version must strictly be 3');
    assert.strictEqual(state.getSnapshot().config, "remote-v3", 'Business data should be merged');
  });

  // ----------------------------------------------------
  // GS16: merge() 傳入 change_log 時保護本地日誌並追加合併紀錄
  // ----------------------------------------------------
  await runTestCase('GS16', 'Reserved Fields Protection: merge() must preserve local change_log and append resolution entry', async () => {
    const state = new GlobalState({ status: "init" });
    state.update({ status: "active" }, 1);
    assert.strictEqual(state.getSnapshot().change_log.length, 1);

    // 遠端傳入偽造的 change_log 試圖覆蓋本地紀錄
    state.merge({
      status: "reconciled",
      change_log: [{ malicious: "fake-history", timestamp: 0 }]
    });

    const snap = state.getSnapshot();
    // 斷言：本地歷史紀錄必須完整保留，不可被遠端覆寫，長度應為 2 (原本 1 筆 + 1 筆 merge 紀錄)
    assert.strictEqual(snap.change_log.length, 2, 'change_log must have 2 entries');
    assert.strictEqual(snap.change_log[0].version, 2, 'Local history entry must be intact');
    assert.strictEqual(snap.change_log[1].version, 3, 'Merge resolution entry must have version 3');
    assert.strictEqual(snap.change_log[1].note, "Merged conflict resolution", 'Merge resolution entry must have correct note');
    assert.strictEqual(snap.status, "reconciled", 'Business data merged');
  });

  // ----------------------------------------------------
  // GS17: 拒絕不符合 Pure Structured Data 契約的非法型別
  // ----------------------------------------------------
  await runTestCase('GS17', 'Pure Structured Data Contract: Rejects Function and Symbol inputs', async () => {
    const state = new GlobalState({ mode: "safe" });

    // 嘗試傳入含有 Function 的 payload
    const funcResult = state.update({ fn: () => "code-injection" }, 1);
    assert.strictEqual(funcResult, false, 'update() with Function must be rejected');

    // 嘗試傳入含有 Symbol 的 payload
    const symResult = state.update({ sym: Symbol("illegal") }, 1);
    assert.strictEqual(symResult, false, 'update() with Symbol must be rejected');

    // 嘗試在巢狀物件中傳入 Function
    const nestedResult = state.update({ nested: { badFn: function() {} } }, 1);
    assert.strictEqual(nestedResult, false, 'update() with nested Function must be rejected');

    // 嘗試傳入自訂類別實例 (Custom Class Instance)
    class CustomModel { constructor() { this.name = "custom"; } }
    const classResult = state.update({ model: new CustomModel() }, 1);
    assert.strictEqual(classResult, false, 'update() with Custom Class instance must be rejected');

    // 斷言：內部狀態維持原狀，version 為 1，change_log 為空
    const snap = state.getSnapshot();
    assert.strictEqual(state.version, 1);
    assert.strictEqual(snap.mode, "safe");
    assert.strictEqual(snap.fn, undefined);
    assert.strictEqual(snap.sym, undefined);
    assert.strictEqual(snap.nested, undefined);
    assert.strictEqual(snap.model, undefined);
    assert.strictEqual(snap.change_log.length, 0);
  });

  // ----------------------------------------------------
  // GS18: 一般業務資料更新正常，OCC 正常遞增，且原型污染鍵名遭阻擋
  // ----------------------------------------------------
  await runTestCase('GS18', 'Normal Business Update & Prototype Pollution Defense', async () => {
    const state = new GlobalState({ counter: 10, metadata: { team: "core" } });

    // 1. 嘗試原型污染攻擊鍵名 __proto__ (物件實字 prototype setter)
    const protoResult1 = state.update({ "__proto__": { admin: true } }, 1);
    assert.strictEqual(protoResult1, false, 'update() with __proto__ literal must be rejected');

    // 2. 嘗試原型污染攻擊鍵名 __proto__ (JSON.parse 產生之 own property)
    const jsonProtoPayload = JSON.parse('{"__proto__": {"admin": true}}');
    const protoResult2 = state.update(jsonProtoPayload, 1);
    assert.strictEqual(protoResult2, false, 'update() with JSON parsed __proto__ must be rejected');

    // 3. 嘗試原型污染攻擊鍵名 prototype
    const protoResult3 = state.update({ "prototype": { hacked: true } }, 1);
    assert.strictEqual(protoResult3, false, 'update() with prototype must be rejected');

    // 4. 嘗試原型污染攻擊鍵名 constructor
    const ctorResult = state.update({ "constructor": { hacked: true } }, 1);
    assert.strictEqual(ctorResult, false, 'update() with constructor must be rejected');

    // 5. 正常業務資料更新
    const validUpdate = state.update({
      counter: 20,
      metadata: { team: "core", verified: true },
      tags: ["release", "stable"]
    }, 1);

    // 斷言：正常更新成功
    assert.strictEqual(validUpdate, true, 'Valid business update must succeed');

    const finalSnap = state.getSnapshot();
    assert.strictEqual(state.version, 2);
    assert.strictEqual(finalSnap.version, 2);
    assert.strictEqual(finalSnap.counter, 20);
    assert.strictEqual(finalSnap.metadata.verified, true);
    assert.deepStrictEqual(finalSnap.tags, ["release", "stable"]);
    assert.strictEqual(finalSnap.change_log.length, 1);
    assert.deepStrictEqual(finalSnap.change_log[0].changedFields.sort(), ["counter", "metadata", "tags"].sort());
  });

  // ----------------------------------------------------
  // GS19: 合法共用參照 (DAG) 不得被誤判為循環參照
  // ----------------------------------------------------
  await runTestCase('GS19', 'Shared References (DAG): Valid shared sub-objects must not be rejected as circular', async () => {
    const state = new GlobalState({ app: "cluster" });

    const sharedConfig = { timeout: 3000, retries: 3 };
    const dagPayload = {
      primaryNode: sharedConfig,
      secondaryNode: sharedConfig,
      clusterName: "us-east-1"
    };

    // 斷言：合法共用參照必須成功更新，不應被誤判為循環參照
    const ok = state.update(dagPayload, 1);
    assert.strictEqual(ok, true, 'Shared reference (DAG) update must succeed');

    const snap = state.getSnapshot();
    assert.strictEqual(state.version, 2);
    assert.strictEqual(snap.primaryNode.timeout, 3000);
    assert.strictEqual(snap.secondaryNode.retries, 3);
  });

  // ----------------------------------------------------
  // GS20: 真正循環參照必須被精準偵測並拒絕
  // ----------------------------------------------------
  await runTestCase('GS20', 'Circular Reference Detection: True cycle must be rejected and leave state untouched', async () => {
    const state = new GlobalState({ mode: "stable" });

    const cycleObj = { title: "cycle-test" };
    cycleObj.self = cycleObj; // 真正回邊

    const ok = state.update(cycleObj, 1);
    assert.strictEqual(ok, false, 'True circular reference must be rejected');

    const snap = state.getSnapshot();
    assert.strictEqual(state.version, 1);
    assert.strictEqual(snap.mode, "stable");
    assert.strictEqual(snap.title, undefined);
    assert.strictEqual(snap.change_log.length, 0);
  });

  // ----------------------------------------------------
  // GS21: Array 中的 Function 必須被拒絕
  // ----------------------------------------------------
  await runTestCase('GS21', 'Array Element Contract: Function inside array must be rejected', async () => {
    const state = new GlobalState({ steps: [] });

    const payload = {
      steps: [1, 2, () => "rogue-function"]
    };

    const ok = state.update(payload, 1);
    assert.strictEqual(ok, false, 'Array with function element must be rejected');

    const snap = state.getSnapshot();
    assert.strictEqual(state.version, 1);
    assert.deepStrictEqual(snap.steps, []);
    assert.strictEqual(snap.change_log.length, 0);
  });

  // ----------------------------------------------------
  // GS22: Array 中的 Symbol 屬性必須被拒絕
  // ----------------------------------------------------
  await runTestCase('GS22', 'Array Symbol Contract: Symbol property attached to array must be rejected', async () => {
    const state = new GlobalState({ tags: ["a"] });

    const badArr = ["a", "b"];
    badArr[Symbol('secret')] = "leak";

    const ok = state.update({ tags: badArr }, 1);
    assert.strictEqual(ok, false, 'Array with symbol property must be rejected');

    const snap = state.getSnapshot();
    assert.strictEqual(state.version, 1);
    assert.deepStrictEqual(snap.tags, ["a"]);
    assert.strictEqual(snap.change_log.length, 0);
  });

  // ----------------------------------------------------
  // GS23: Array 自訂命名屬性必須被拒絕
  // ----------------------------------------------------
  await runTestCase('GS23', 'Array Named Property Contract: Custom non-index property on array must be rejected', async () => {
    const state = new GlobalState({ items: [1] });

    const badArr = [1, 2, 3];
    badArr.customProp = "unauthorized-field";

    const ok = state.update({ items: badArr }, 1);
    assert.strictEqual(ok, false, 'Array with custom named property must be rejected');

    const snap = state.getSnapshot();
    assert.strictEqual(state.version, 1);
    assert.deepStrictEqual(snap.items, [1]);
    assert.strictEqual(snap.change_log.length, 0);
  });

  // ----------------------------------------------------
  // GS24: merge() 的非法資料必須被拒絕，且保證原子性
  // ----------------------------------------------------
  await runTestCase('GS24', 'Merge Data Contract & Atomicity: Invalid remote data must be rejected without partial state changes', async () => {
    const state = new GlobalState({ healthyKey: "original-val" });

    // 嘗試透過 merge 傳入包含非法函式的資料
    state.merge({
      healthyKey: "mutated-val",
      illegalFn: () => "evil"
    });

    // 斷言：狀態必須維持 100% 原子性，version 不得遞增，資料不得被局部修改，日誌不追加
    const snap = state.getSnapshot();
    assert.strictEqual(state.version, 1, 'Version must remain 1 after rejected merge');
    assert.strictEqual(snap.version, 1);
    assert.strictEqual(snap.healthyKey, "original-val", 'healthyKey must remain untouched');
    assert.strictEqual(snap.illegalFn, undefined);
    assert.strictEqual(snap.change_log.length, 0, 'change_log must remain empty');
  });

  // ----------------------------------------------------
  // GS25: constructor 的非法資料必須依正式契約拋出 TypeError
  // ----------------------------------------------------
  await runTestCase('GS25', 'Constructor Data Contract: Illegal data types in initialData must throw TypeError', async () => {
    // 1. 包含 Function 應拋出 TypeError
    assert.throws(() => {
      new GlobalState({ badFunction: () => {} });
    }, (err) => {
      return err instanceof TypeError && /GlobalState/i.test(err.message);
    }, 'Constructor with function must throw TypeError');

    // 2. 包含 Symbol 應拋出 TypeError
    assert.throws(() => {
      new GlobalState({ badSymbol: Symbol('test') });
    }, (err) => {
      return err instanceof TypeError && /GlobalState/i.test(err.message);
    }, 'Constructor with Symbol must throw TypeError');

    // 3. 包含 NaN 應拋出 TypeError
    assert.throws(() => {
      new GlobalState({ badNumber: NaN });
    }, (err) => {
      return err instanceof TypeError && /GlobalState/i.test(err.message);
    }, 'Constructor with NaN must throw TypeError');

    // 4. 合法 initialData 正常初始化
    const valid = new GlobalState({ service: "worker-pool", concurrency: 4 });
    assert.strictEqual(valid.version, 1);
    assert.strictEqual(valid.getSnapshot().concurrency, 4);
  });

  // ----------------------------------------------------
  // GS26: Getter / Setter 防護：直接拒絕且不觸發副程式執行
  // ----------------------------------------------------
  await runTestCase('GS26', 'Getter/Setter Defense: Accessors must be rejected without side-effect execution', async () => {
    const state = new GlobalState({ safe: true });

    let sideEffectRan = false;
    const sneakyPayload = {
      get evilAccessor() {
        sideEffectRan = true;
        return "hacked";
      }
    };

    const ok = state.update(sneakyPayload, 1);
    assert.strictEqual(ok, false, 'Payload with getter must be rejected');
    assert.strictEqual(sideEffectRan, false, 'Getter must NOT be executed during validation');

    const snap = state.getSnapshot();
    assert.strictEqual(state.version, 1);
    assert.strictEqual(snap.safe, true);
    assert.strictEqual(snap.evilAccessor, undefined);
    assert.strictEqual(snap.change_log.length, 0);
  });

  // ----------------------------------------------------
  // GS27: merge() 收到含有 Getter 的 remoteData 必須被拒絕，且不得執行 Getter
  // ----------------------------------------------------
  await runTestCase('GS27', 'Merge Accessor Defense: Accessor in remoteData must be rejected without execution', async () => {
    const state = new GlobalState({ health: "green" });

    let mergeGetterRan = false;
    const maliciousRemote = {};
    Object.defineProperty(maliciousRemote, 'injectedPayload', {
      enumerable: true,
      get() {
        mergeGetterRan = true;
        return "compromised";
      }
    });

    state.merge(maliciousRemote);

    // 斷言：Getter 絕對未曾執行，狀態零變更，version 維持 1
    assert.strictEqual(mergeGetterRan, false, 'Getter in merge() payload must NOT be executed');
    assert.strictEqual(state.version, 1, 'Version must remain 1 after rejected merge');
    const snap = state.getSnapshot();
    assert.strictEqual(snap.health, "green");
    assert.strictEqual(snap.injectedPayload, undefined);
    assert.strictEqual(snap.change_log.length, 0);
  });

  // ----------------------------------------------------
  // GS28: constructor 接受合法巢狀 version / change_log
  // ----------------------------------------------------
  await runTestCase('GS28', 'Constructor Nested Reserved Fields: Nested metadata.version/change_log allowed', async () => {
    const state = new GlobalState({
      service: "payment-api",
      metadata: {
        version: 2,
        change_log: ["init-v1", "upgrade-v2"]
      }
    });

    // 根 version 必須嚴格由 GlobalState 設為 1，但巢狀業務資料完整保留
    assert.strictEqual(state.version, 1, 'Root version must strictly be 1');
    const snap = state.getSnapshot();
    assert.strictEqual(snap.service, "payment-api");
    assert.strictEqual(snap.metadata.version, 2, 'Nested version must be preserved');
    assert.deepStrictEqual(snap.metadata.change_log, ["init-v1", "upgrade-v2"], 'Nested change_log must be preserved');
    assert.deepStrictEqual(snap.change_log, [], 'Root change_log must be empty initially');
  });

  // ----------------------------------------------------
  // GS29: update 接受合法巢狀 version / change_log
  // ----------------------------------------------------
  await runTestCase('GS29', 'Update Nested Reserved Fields: Nested schema.version allowed in update()', async () => {
    const state = new GlobalState({ service: "doc-service" });

    const ok = state.update({
      schema: {
        version: "v3.1",
        change_log: [{ note: "schema migration" }]
      }
    }, 1);

    assert.strictEqual(ok, true, 'update() with nested version/change_log must succeed');
    assert.strictEqual(state.version, 2, 'Root version must increment to 2');
    const snap = state.getSnapshot();
    assert.strictEqual(snap.schema.version, "v3.1");
    assert.strictEqual(snap.schema.change_log.length, 1);
  });

  // ----------------------------------------------------
  // GS30: merge 接受合法巢狀 version / change_log
  // ----------------------------------------------------
  await runTestCase('GS30', 'Merge Nested Reserved Fields: Nested remote.version allowed in merge()', async () => {
    const state = new GlobalState({ service: "mesh" });

    state.merge({
      remoteMeta: {
        version: 99,
        change_log: ["cluster-sync"]
      }
    });

    assert.strictEqual(state.version, 2, 'Root version must increment by 1');
    const snap = state.getSnapshot();
    assert.strictEqual(snap.remoteMeta.version, 99);
    assert.deepStrictEqual(snap.remoteMeta.change_log, ["cluster-sync"]);
    assert.strictEqual(snap.change_log.length, 1, 'Root change_log appends merge resolution');
  });

  // ----------------------------------------------------
  // GS31: 根層級保留欄位在三種入口之防護
  // ----------------------------------------------------
  await runTestCase('GS31', 'Root Reserved Fields Enforcement: Root version/change_log protected across all 3 APIs', async () => {
    // 1. constructor 重置根層級保留欄位
    const state = new GlobalState({ version: 999, change_log: ["fake"], app: "test" });
    assert.strictEqual(state.version, 1, 'constructor must reset root version to 1');
    assert.deepStrictEqual(state.getSnapshot().change_log, [], 'constructor must reset root change_log');
    assert.strictEqual(state.getSnapshot().app, "test");

    // 2. update 拒絕根層級保留欄位
    const failVer = state.update({ version: 888 }, 1);
    assert.strictEqual(failVer, false, 'update() must reject root version');
    const failLog = state.update({ change_log: [] }, 1);
    assert.strictEqual(failLog, false, 'update() must reject root change_log');
    assert.strictEqual(state.version, 1);

    // 3. merge 剝離根層級保留欄位，不採用遠端根版本
    state.merge({ version: 777, change_log: ["hacked-log"], syncData: "ok" });
    assert.strictEqual(state.version, 2, 'merge() must increment root version to 2 (not 777)');
    const snap = state.getSnapshot();
    assert.strictEqual(snap.syncData, "ok");
    assert.strictEqual(snap.change_log.length, 1, 'merge() appends local merge note, ignoring remote log');
  });

  // ----------------------------------------------------
  // GS32: constructor 引數契約驗證 (new GlobalState() vs undefined vs null)
  // ----------------------------------------------------
  await runTestCase('GS32', 'Constructor Arguments Contract: Distinguish 0 args from explicit undefined/null', async () => {
    // 1. new GlobalState() (0 args) 正常初始化為空物件
    const state0 = new GlobalState();
    assert.strictEqual(state0.version, 1);
    assert.deepStrictEqual(state0.getSnapshot(), { version: 1, change_log: [] });

    // 2. new GlobalState(undefined) 明確違反契約，拋出 TypeError
    assert.throws(() => {
      new GlobalState(undefined);
    }, (err) => {
      return err instanceof TypeError && /initialData/i.test(err.message);
    }, 'new GlobalState(undefined) must throw TypeError');

    // 3. new GlobalState(null) 明確違反契約，拋出 TypeError
    assert.throws(() => {
      new GlobalState(null);
    }, (err) => {
      return err instanceof TypeError && /initialData/i.test(err.message);
    }, 'new GlobalState(null) must throw TypeError');
  });

  // ----------------------------------------------------
  // GS33: DAG 共用參照之 clone 參照完整性
  // ----------------------------------------------------
  await runTestCase('GS33', 'Deep Clone DAG Identity: Preserves shared reference identity across clone', async () => {
    const sharedSub = { clusterId: "c-101", region: "apac" };
    const state = new GlobalState({
      nodeA: sharedSub,
      nodeB: sharedSub
    });

    const snap = state.getSnapshot();
    // 斷言：在 snapshot 內部，nodeA 與 nodeB 指向相同的共用記憶體參照 (DAG 結構保全)
    assert.strictEqual(snap.nodeA, snap.nodeB, 'Snapshot must preserve identity between shared DAG nodes');
    assert.strictEqual(snap.nodeA.clusterId, "c-101");
  });

  // ----------------------------------------------------
  // GS34: 不可列舉屬性 (Non-enumerable Property) 契約防護
  // ----------------------------------------------------
  await runTestCase('GS34', 'Non-enumerable Property Contract: Rejects non-enumerable properties across all APIs', async () => {
    // 1. constructor 收到 non-enumerable 自有業務屬性時拒絕 (拋出 TypeError)
    const badInit = {};
    Object.defineProperty(badInit, 'hiddenSecret', {
      value: "hidden-value",
      enumerable: false,
      configurable: true
    });
    assert.throws(() => {
      new GlobalState(badInit);
    }, (err) => {
      return err instanceof TypeError && /initialData/i.test(err.message);
    }, 'constructor with non-enumerable property must throw TypeError');

    // 2. update 收到 non-enumerable 自有業務屬性時拒絕，狀態、版本、change_log 不變
    const state = new GlobalState({ regularField: "init" });
    const badUpdate = { normal: 123 };
    Object.defineProperty(badUpdate, 'hiddenUpdate', {
      value: "hidden-update",
      enumerable: false,
      configurable: true
    });
    const updateResult = state.update(badUpdate, 1);
    assert.strictEqual(updateResult, false, 'update() with non-enumerable property must return false');
    assert.strictEqual(state.version, 1);
    assert.strictEqual(state.getSnapshot().regularField, "init");
    assert.strictEqual(state.getSnapshot().normal, undefined);
    assert.strictEqual(state.getSnapshot().change_log.length, 0);

    // 3. merge 收到 non-enumerable 自有業務屬性時拒絕，狀態、版本、change_log 不變
    const badRemote = { remoteField: "remote-val" };
    Object.defineProperty(badRemote, 'hiddenRemote', {
      value: "hidden-remote",
      enumerable: false,
      configurable: true
    });
    state.merge(badRemote);
    assert.strictEqual(state.version, 1);
    assert.strictEqual(state.getSnapshot().regularField, "init");
    assert.strictEqual(state.getSnapshot().remoteField, undefined);
    assert.strictEqual(state.getSnapshot().change_log.length, 0);

    // 4. Array 中含有 non-enumerable 索引屬性遭拒絕
    const badArr = [1, 2, 3];
    Object.defineProperty(badArr, '1', {
      value: 999,
      enumerable: false,
      configurable: true
    });
    const arrUpdateResult = state.update({ items: badArr }, 1);
    assert.strictEqual(arrUpdateResult, false, 'update() with non-enumerable array index must return false');
    assert.strictEqual(state.version, 1);

    // 5. 正常 enumerable 業務資料仍可正常通過
    const goodUpdate = state.update({
      regularField: "updated",
      normalArray: [1, 2, 3],
      nestedObj: { safe: true }
    }, 1);
    assert.strictEqual(goodUpdate, true, 'update() with normal enumerable properties must succeed');
    assert.strictEqual(state.version, 2);
    assert.strictEqual(state.getSnapshot().regularField, "updated");
    assert.strictEqual(state.getSnapshot().nestedObj.safe, true);
    assert.deepStrictEqual(state.getSnapshot().normalArray, [1, 2, 3]);
  });

  console.log("\n==================================================");
  console.log(`📊 [GlobalState OCC Results]: ${passedCount} passed, ${failedCount} failed`);
  console.log("==================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAll().catch(err => {
  console.error("❌ Fatal unhandled error in test_global_state.js:", err);
  process.exit(1);
});
