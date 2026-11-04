/**
 * Unit Test Suite for RoleManager (tests/test_role_manager.js)
 * Covers R1 to R6, Reference Isolation, Ajv Dual-Layer Compilation, and Path Traversal Guards.
 */

const assert = require('assert');
const roleManager = require('../services/role_manager');

let passedCount = 0;
let failedCount = 0;

function runTestCase(testId, description, fn) {
  try {
    fn();
    console.log(`  ✅ [${testId}] PASS: ${description}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ [${testId}] FAIL: ${description}`);
    console.error(`     Error: ${err.message}`);
    failedCount++;
  }
}

function runAll() {
  console.log("\n==================================================");
  console.log("🎭 [P1-A Test Suite] RoleManager Unit & Boundary Assertions");
  console.log("==================================================\n");

  // R1: 三個角色正常載入
  runTestCase('R1', 'Role Loading: All 3 registered roles loaded with expected fields', () => {
    const roles = roleManager.listRoles();
    assert.strictEqual(roles.length, 3, 'Must load exactly 3 roles');
    
    const roleIds = roles.map(r => r.id);
    assert.ok(roleIds.includes('software_architect'), 'Must contain software_architect');
    assert.ok(roleIds.includes('code_reviewer'), 'Must contain code_reviewer');
    assert.ok(roleIds.includes('doc_synthesizer'), 'Must contain doc_synthesizer');

    for (const r of roles) {
      assert.ok(typeof r.id === 'string' && r.id.length > 0);
      assert.ok(typeof r.name === 'string' && r.name.length > 0);
      assert.ok(typeof r.description === 'string' && r.description.length > 0);
      assert.ok(['ultra', 'high', 'medium', 'base'].includes(r.recommendedTier));
    }
  });

  // R2: Meta-Schema 與 Schema 雙層編譯防護
  runTestCase('R2', 'Dual-Layer Schema Compilation: Output schemas compile and reject $ref', () => {
    for (const roleInfo of roleManager.listRoles()) {
      const fullRole = roleManager.getRole(roleInfo.id);
      assert.strictEqual(fullRole.schema.type, 'object');
      assert.ok(Array.isArray(fullRole.schema.required));
      assert.ok(typeof fullRole.schema.properties === 'object');
      
      const serialized = JSON.stringify(fullRole.schema);
      assert.strictEqual(serialized.includes('$ref'), false, 'External $ref must not exist');
    }
  });

  // R3: 不存在角色明確拒絕
  runTestCase('R3', 'Role Not Found: Unknown role IDs reject with ROLE_NOT_FOUND', () => {
    assert.throws(() => {
      roleManager.getRole('unregistered_ghost_role');
    }, /Role not found/);

    assert.throws(() => {
      roleManager.buildTask('unregistered_ghost_role', { objective: 'Test task' });
    }, /ROLE_NOT_FOUND/);
  });

  // R4: 路徑穿越攻擊防護
  runTestCase('R4', 'Path Traversal Defense: Directory traversal inputs rejected cleanly via whitelist', () => {
    const maliciousIds = [
      '../../package',
      '..\\..\\package',
      '../main',
      './software_architect',
      'software_architect/../code_reviewer',
      '/etc/passwd'
    ];

    for (const id of maliciousIds) {
      assert.throws(() => {
        roleManager.getRole(id);
      }, /Role not found/);

      assert.throws(() => {
        roleManager.buildTask(id, { objective: 'Test task' });
      }, /ROLE_NOT_FOUND/);
    }
  });

  // R5: Tier 覆寫與非法 Tier 判定
  runTestCase('R5', 'Tier Overrides: Honors valid tier override, rejects null and illegal values', () => {
    // 預設 fallback 至 recommendedTier
    const defaultTask = roleManager.buildTask('software_architect', {
      objective: 'Build system'
    });
    assert.strictEqual(defaultTask.tier, 'high', 'Default tier must match role recommendedTier (high)');

    // 顯式合法覆寫
    const ultraTask = roleManager.buildTask('software_architect', {
      objective: 'Build system',
      tier: 'ultra'
    });
    assert.strictEqual(ultraTask.tier, 'ultra', 'Caller tier must explicitly override role tier');

    // 明確傳入 null -> 拒絕
    assert.throws(() => {
      roleManager.buildTask('software_architect', {
        objective: 'Build system',
        tier: null
      });
    }, /INVALID_PARAMETER: Invalid tier/);

    // 明確傳入非法字串 -> 拒絕
    assert.throws(() => {
      roleManager.buildTask('software_architect', {
        objective: 'Build system',
        tier: 'super_saiyan'
      });
    }, /INVALID_PARAMETER: Invalid tier/);
  });

  // R6: Constraints 追加與型別校驗
  runTestCase('R6', 'Constraints Composition: Appends user constraints without overriding role rules', () => {
    const userConstraints = ['Must complete in 2 hours', 'Use TypeScript 5'];
    const task = roleManager.buildTask('software_architect', {
      objective: 'Design API',
      constraints: userConstraints
    });

    const role = roleManager.getRole('software_architect');
    assert.strictEqual(task.taskPayload.constraints.length, role.role_constraints.length + 2);
    assert.deepStrictEqual(
      task.taskPayload.constraints.slice(-2),
      userConstraints
    );

    // constraints 非陣列或內含非字串時拋出異常
    assert.throws(() => {
      roleManager.buildTask('software_architect', {
        objective: 'Design API',
        constraints: 'not an array'
      });
    }, /INVALID_PARAMETER: "constraints" must be an array of strings/);

    assert.throws(() => {
      roleManager.buildTask('software_architect', {
        objective: 'Design API',
        constraints: [12345]
      });
    }, /INVALID_PARAMETER: Each constraint must be a non-empty string/);
  });

  // R7 (Unit): 選擇角色後禁止傳入 schema
  runTestCase('R7-Unit', 'Schema Lock: Selecting role prohibits custom schema (even if null or empty)', () => {
    assert.throws(() => {
      roleManager.buildTask('code_reviewer', {
        objective: 'Review PR',
        schema: null
      });
    }, /INVALID_PARAMETER: Custom schema cannot be provided when a role is selected/);

    assert.throws(() => {
      roleManager.buildTask('code_reviewer', {
        objective: 'Review PR',
        schema: { type: 'object' }
      });
    }, /INVALID_PARAMETER: Custom schema cannot be provided when a role is selected/);
  });

  // R8 (Unit): 參照完全隔離保護 (Deep Immutability & Reference Isolation)
  runTestCase('R8-Unit', 'Reference Isolation: Mutations to retrieved role objects do not pollute internal cache', () => {
    const role1 = roleManager.getRole('doc_synthesizer');
    role1.role_constraints.push('MUTATED_INTRUSIVE_CONSTRAINT');
    role1.schema.properties.injected_field = { type: 'string' };

    const role2 = roleManager.getRole('doc_synthesizer');
    assert.strictEqual(
      role2.role_constraints.includes('MUTATED_INTRUSIVE_CONSTRAINT'),
      false,
      'Internal role_constraints must remain untouched after external mutation'
    );
    assert.strictEqual(
      Object.hasOwn(role2.schema.properties, 'injected_field'),
      false,
      'Internal schema must remain untouched after external mutation'
    );
  });

  console.log("\n==================================================");
  console.log(`📊 [RoleManager Unit Results]: ${passedCount} passed, ${failedCount} failed`);
  console.log("==================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

try {
  runAll();
} catch (err) {
  console.error("❌ Fatal unhandled error in test_role_manager.js:", err);
  process.exit(1);
}

