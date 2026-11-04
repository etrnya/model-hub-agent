/**
 * P0-B Step 1: Automated Assertion Test for SchemaValidator.silentFix()
 * 
 * Verifies:
 * 1. Markdown JSON block extraction with trailing commas removed.
 * 2. Conversational wrapping text stripped from JSON core.
 * 3. Unescaped newlines inside strings properly escaped.
 * 4. Truncated braces/brackets automatically closed.
 * 5. Single-line and multi-line comments stripped safely.
 * 6. Unfixable/corrupted inputs explicitly fail parsing and do not pretend to succeed.
 * 
 * Uses node:assert/strict. Exits with non-zero code on any failure.
 */

const assert = require('node:assert/strict');
const SchemaValidator = require('../infrastructure/adapters/schema_validator');

const validator = new SchemaValidator();

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
  console.log("🛠️  [P0-B Test Suite] SilentFix 2.0 Self-Healing Assertions");
  console.log("==================================================\n");

  // SF1: 額外文字包裹 (Aggressive Extraction)
  runTestCase('SF1', 'Conversational Text Stripping: Extracts JSON core from conversational chatter', () => {
    const input = "Here is the result: {\"status\": \"ok\", \"count\": 5} Hope this helps!";
    const fixed = validator.silentFix(input);
    const parsed = JSON.parse(fixed);

    assert.deepStrictEqual(parsed, { status: "ok", count: 5 });
  });

  // SF2: 字串內未轉義換行
  runTestCase('SF2', 'Unescaped Newline Repair: Escapes raw newlines within JSON strings', () => {
    const input = "{\"message\": \"Hello\nWorld\", \"code\": 200}";
    const fixed = validator.silentFix(input);
    const parsed = JSON.parse(fixed);

    assert.deepStrictEqual(parsed, { message: "Hello\nWorld", code: 200 });
  });

  // SF3: 截斷補全 (Truncation Recovery)
  runTestCase('SF3', 'Smart Brace Completion: Recovers truncated JSON object by completing braces', () => {
    const input = "{\"user\": {\"id\": 1, \"name\": \"John\",";
    const fixed = validator.silentFix(input);
    const parsed = JSON.parse(fixed);

    assert.strictEqual(parsed.user.id, 1);
    assert.strictEqual(parsed.user.name, "John");
  });

  // SF4: 註解剝離 (Comment Stripping)
  runTestCase('SF4', 'Comment Stripping: Strips // and /* */ comments while preserving string values', () => {
    const input = `{\n  // Single line comment\n  "key": "value // not a comment",\n  /* Multi-line\n     comment */\n  "num": 10\n}`;
    const fixed = validator.silentFix(input);
    const parsed = JSON.parse(fixed);

    assert.strictEqual(parsed.key, "value // not a comment");
    assert.strictEqual(parsed.num, 10);
  });

  // SF5: Markdown 代碼區塊與尾隨逗號修復
  runTestCase('SF5', 'Markdown & Trailing Commas: Extracts from markdown and removes illegal trailing commas', () => {
    const input = "```json\n{\n  \"a\": 1,\n  \"b\": 2,\n}\n```";
    const fixed = validator.silentFix(input);
    const parsed = JSON.parse(fixed);

    assert.deepStrictEqual(parsed, { a: 1, b: 2 });
  });

  // SF6: 無法自癒之無效輸入必須明確失敗，不得偽裝成功
  runTestCase('SF6', 'Unfixable Input Rejection: Fails parsing cleanly when input contains non-JSON gibberish', () => {
    const completelyInvalid = "This is pure natural language text without any JSON structure at all.";
    const fixed = validator.silentFix(completelyInvalid);
    
    // 斷言：無法修復的非 JSON 字串在 JSON.parse 時必須拋出 SyntaxError
    assert.throws(() => {
      JSON.parse(fixed);
    }, SyntaxError, 'Unfixable non-JSON input MUST throw SyntaxError and not masquerade as valid object');
  });

  console.log("\n==================================================");
  console.log(`📊 [SilentFix Results]: ${passedCount} passed, ${failedCount} failed`);
  console.log("==================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

try {
  runAll();
} catch (err) {
  console.error("❌ Fatal unhandled error in test_silent_fix.js:", err);
  process.exit(1);
}
