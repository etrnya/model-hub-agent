const Ajv = require('ajv');
const addFormats = require('ajv-formats');

class SchemaValidator {
  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
    this.silentFixRules = [
      {
        name: 'extract_markdown_json',
        pattern: /```json\s*([\s\S]*?)\s*```/,
        fix: (match, fullText) => {
          const matchResult = fullText.match(/```json\s*([\s\S]*?)\s*```/);
          return matchResult ? matchResult[1] : fullText;
        }
      },
      {
        name: 'trailing_commas',
        pattern: /,(?=\s*?[\}\]])/g,
        fix: () => ""
      }
    ];
  }

  /**
   * Attempts to fix common JSON formatting errors before parsing.
   * @param {string} rawContent 
   */
  silentFix(rawContent) {
    let fixedContent = rawContent.trim();
    
    // 1. Aggressive Extraction: Try to find the JSON core
    // Priority: Markdown blocks -> First { to Last } -> Original
    const startJsonMd = fixedContent.indexOf('```json');
    const endGenericMd = fixedContent.lastIndexOf('```');
    const startGenericMd = fixedContent.indexOf('```');

    if (startJsonMd !== -1 && endGenericMd !== -1 && endGenericMd > startJsonMd) {
      fixedContent = fixedContent.substring(startJsonMd + 7, endGenericMd).trim();
    } else if (startGenericMd !== -1 && endGenericMd !== -1 && endGenericMd > startGenericMd) {
      fixedContent = fixedContent.substring(startGenericMd + 3, endGenericMd).trim();
    } else {
      const firstBrace = fixedContent.indexOf('{');
      const lastBrace = fixedContent.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        fixedContent = fixedContent.substring(firstBrace, lastBrace + 1);
      }
    }

    // 2. Remove non-standard comments (// or /* */) safely (preserving strings)
    fixedContent = fixedContent.replace(/("([^"\\]|\\.)*")|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (m, g1) => g1 ? g1 : "");

    // 3. Fix unescaped newlines and control characters inside strings
    // We only target newlines between quotes
    fixedContent = fixedContent.replace(/"([^"]*)"/g, (match, p1) => {
      return '"' + p1.replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
    });

    // 4. Apply regex-based micro-fixes
    for (const rule of this.silentFixRules) {
      fixedContent = fixedContent.replace(rule.pattern, rule.fix);
    }

    // 5. Smart Brace Completion (Truncation recovery)
    fixedContent = this._completeBraces(fixedContent);

    return fixedContent.trim();
  }

  _completeBraces(content) {
    let openBraces = (content.match(/\{/g) || []).length;
    let closeBraces = (content.match(/\}/g) || []).length;
    let openBrackets = (content.match(/\[/g) || []).length;
    let closeBrackets = (content.match(/\]/g) || []).length;

    let fixed = content;
    
    // Fix truncated arrays
    if (openBrackets > closeBrackets) {
      fixed += ']'.repeat(openBrackets - closeBrackets);
    }
    
    // Fix truncated objects
    if (openBraces > closeBraces) {
      // If the last character is a comma, remove it before adding braces
      fixed = fixed.trim().replace(/,$/, "");
      fixed += '}'.repeat(openBraces - closeBraces);
    }

    return fixed;
  }

  validate(data, schema) {
    const validate = this.ajv.compile(schema);
    const valid = validate(data);
    return {
      valid,
      errors: validate.errors
    };
  }

  parseAndValidate(rawContent, schema) {
    const fixed = this.silentFix(rawContent);
    try {
      const parsed = JSON.parse(fixed);
      const validation = this.validate(parsed, schema);
      return {
        success: validation.valid,
        data: parsed,
        errors: validation.errors,
        fixed: fixed !== rawContent
      };
    } catch (e) {
      return {
        success: false,
        error: `JSON Parse Error: ${e.message}`,
        raw: fixed
      };
    }
  }
}

module.exports = SchemaValidator;
