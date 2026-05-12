/**
 * GuardrailManager
 * Acts as an AI Firewall to prevent Prompt Injection and Data Leakage.
 */
class GuardrailManager {
  constructor() {
    // 1. Prompt Injection Patterns (Heuristic)
    this.injectionPatterns = [
      /ignore\s+(all\s+)?previous\s+instructions/i,
      /stop\s+the\s+current\s+task/i,
      /you\s+are\s+now\s+(a|an)\s+\w+/i,
      /switch\s+to\s+developer\s+mode/i,
      /bypass\s+all\s+filters/i,
      /system\s+role\s*:/i,
      /\[\s*system\s*\]/i
    ];

    // 2. Sensitive Data Patterns (DLP)
    this.sensitivePatterns = {
      'API_KEY': /[a-zA-Z0-9]{32,}/, // Simple catch-all for long alphanumeric strings
      'CREDIT_CARD': /\b(?:\d[ -]*?){13,16}\b/,
      'EMAIL': /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
    };
  }

  /**
   * Scans a task payload for security violations.
   * @param {Object} payload - { objective, constraints, ... }
   * @returns {Object} { safe: boolean, reason: string, sanitizedPayload: Object }
   */
  async scan(payload) {
    const textToScan = JSON.stringify(payload);
    
    // Check for Prompt Injection
    for (const pattern of this.injectionPatterns) {
      if (pattern.test(textToScan)) {
        console.error(`🚨 [Guardrail] Security Alert: Prompt Injection detected! Pattern: ${pattern}`);
        return {
          safe: false,
          reason: "SECURITY_VIOLATION: Potential Prompt Injection detected.",
          sanitizedPayload: payload
        };
      }
    }

    // Check for Sensitive Information and Sanitize
    let sanitizedText = textToScan;
    let sensitiveFound = false;

    for (const [type, pattern] of Object.entries(this.sensitivePatterns)) {
      if (pattern.test(sanitizedText)) {
        console.warn(`⚠️  [Guardrail] Privacy Warning: ${type} detected. Sanitizing...`);
        sanitizedText = sanitizedText.replace(pattern, `[REDACTED_${type}]`);
        sensitiveFound = true;
      }
    }

    return {
      safe: true,
      reason: sensitiveFound ? "Sanitized" : "Clean",
      sanitizedPayload: sensitiveFound ? JSON.parse(sanitizedText) : payload
    };
  }
}

module.exports = new GuardrailManager();
