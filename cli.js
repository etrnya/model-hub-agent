const { dispatchTask } = require('./main');
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
  console.log("🚀 Antigravity Agent OS - Interactive CLI");
  console.log("=".repeat(50));

  while (true) {
    console.log("\n[新任務輸入]");
    const objective = await question("🎯 任務目標 (或輸入 'exit' 退出): ");
    
    if (objective.toLowerCase() === 'exit') break;

    const constraintsInput = await question("⛓️  限制條件 (以逗號分隔, 選填): ");
    const constraints = constraintsInput ? constraintsInput.split(',').map(s => s.trim()) : [];

    const tier = await question("⚡ 模型等級 (ultra/high/medium/base, 預設 high): ") || "high";

    const taskPayload = {
      objective,
      constraints,
      tags: ["cli_task"]
    };

    // 預設一個通用的 schema
    const defaultSchema = {
      type: "object",
      properties: {
        analysis: { type: "string" },
        result: { type: "string" },
        recommendations: { type: "array", items: { type: "string" } }
      },
      required: ["analysis", "result"]
    };

    try {
      await dispatchTask(taskPayload, defaultSchema, tier);
    } catch (error) {
      console.error("\n❌ 執行出錯:", error.message);
    }

    console.log("\n" + "-".repeat(50));
  }

  rl.close();
}

startCLI();
