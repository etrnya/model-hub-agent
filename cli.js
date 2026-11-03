const { dispatchTask } = require('./main');
const roleManager = require('./services/role_manager');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function startCLI() {
  console.log("\n" + "=".repeat(50));
  console.log("🚀 Antigravity Agent OS - Interactive CLI (P1-A Ready)");
  console.log("=".repeat(50));

  const availableRoles = roleManager.listRoles();

  while (true) {
    console.log("\n[新任務輸入]");
    console.log("專業角色選項 (Specialized Roles):");
    console.log("  [0] 自訂通用任務 (Custom Task - 一般輸出格式)");
    availableRoles.forEach((r, idx) => {
      console.log(`  [${idx + 1}] ${r.name} (${r.id}) - 推薦: ${r.recommendedTier}`);
      console.log(`      說明: ${r.description}`);
    });

    const roleChoiceInput = await question("\n🎭 請選擇角色編號 [0-3] (預設 0): ");
    if (roleChoiceInput.toLowerCase() === 'exit') break;

    const roleChoiceNum = parseInt(roleChoiceInput.trim() || "0", 10);
    const selectedRole = (roleChoiceNum >= 1 && roleChoiceNum <= availableRoles.length)
      ? availableRoles[roleChoiceNum - 1]
      : null;

    if (selectedRole) {
      console.log(`✨ 已選取角色: ${selectedRole.name}`);
    } else {
      console.log("ℹ️  使用通用任務模式 (無特定角色)");
    }

    const objective = await question("🎯 任務目標 (或輸入 'exit' 退出): ");
    if (objective.toLowerCase() === 'exit') break;

    const constraintsInput = await question("⛓️  限制條件 (以逗號分隔, 選填): ");
    const constraints = constraintsInput ? constraintsInput.split(',').map(s => s.trim()).filter(Boolean) : [];

    const defaultTierPrompt = selectedRole ? selectedRole.recommendedTier : "high";
    const tierInput = await question(`⚡ 模型等級 (ultra/high/medium/base, 預設 ${defaultTierPrompt}): `);
    const tier = tierInput.trim() || defaultTierPrompt;

    let taskPayload;
    let targetSchema;
    let resolvedTier = tier;

    if (selectedRole) {
      try {
        const built = roleManager.buildTask(selectedRole.id, {
          objective,
          constraints,
          tier
        });
        taskPayload = built.taskPayload;
        targetSchema = built.outputSchema;
        resolvedTier = built.tier;
      } catch (err) {
        console.error(`\n❌ 角色任務合成失敗: ${err.message}`);
        console.log("\n" + "-".repeat(50));
        continue;
      }
    } else {
      // 舊版預設通用 schema
      targetSchema = {
        type: "object",
        properties: {
          analysis: { type: "string" },
          result: { type: "string" },
          recommendations: { type: "array", items: { type: "string" } }
        },
        required: ["analysis", "result"]
      };

      taskPayload = {
        objective,
        constraints,
        tags: ["cli_task"]
      };
    }

    try {
      await dispatchTask(taskPayload, targetSchema, resolvedTier);
    } catch (error) {
      console.error("\n❌ 執行出錯:", error.message);
    }

    console.log("\n" + "-".repeat(50));
  }

  rl.close();
}

if (require.main === module) {
  startCLI();
}

module.exports = { startCLI };
