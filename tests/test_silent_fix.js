const SchemaValidator = require('../infrastructure/adapters/schema_validator');

const validator = new SchemaValidator();

const testCases = [
  {
    name: "JSON with extra text",
    input: "Here is the result: {\"status\": \"ok\", \"count\": 5} Hope this helps!",
    expected: { status: "ok", count: 5 }
  },
  {
    name: "JSON with unescaped newlines in strings",
    input: "{\"message\": \"Hello\nWorld\", \"code\": 200}",
    expected: { message: "Hello\\nWorld", code: 200 }
  },
  {
    name: "Truncated JSON",
    input: "{\"user\": {\"id\": 1, \"name\": \"John\",",
    expected: { user: { id: 1, name: "John" } }
  },
  {
    name: "JSON with comments",
    input: "{\n  // This is a comment\n  \"key\": \"value\",\n  /* Multi-line\n     comment */\n  \"num\": 10\n}",
    expected: { key: "value", num: 10 }
  },
  {
    name: "Markdown JSON with trailing comma",
    input: "```json\n{\n  \"a\": 1,\n  \"b\": 2,\n}\n```",
    expected: { a: 1, b: 2 }
  }
];

testCases.forEach(tc => {
  console.log(`\nTesting: ${tc.name}`);
  const fixed = validator.silentFix(tc.input);
  console.log(`Fixed Output: ${fixed}`);
  try {
    const parsed = JSON.parse(fixed);
    console.log("✅ Parse Success!");
  } catch (e) {
    console.log(`❌ Parse Failed: ${e.message}`);
  }
});
