/**
 * GuardrailManager
 * Acts as an AI Firewall to prevent Prompt Injection and Data Leakage.
 */
class GuardrailManager {
  constructor() {
    // 1. Prompt Injection & Malicious Command Patterns (AgentShield Heuristics)
    this.injectionPatterns = [
      /ignore\s+(all\s+)?previous\s+instructions/i,
      /stop\s+the\s+current\s+task/i,
      /you\s+are\s+now\s+(a|an)\s+\w+/i,
      /switch\s+to\s+developer\s+mode/i,
      /bypass\s+all\s+filters/i,
      /system\s+role\s*:/i,
      /\[\s*system\s*\]/i,
      // AgentShield - Dangerous Shell commands
      /rm\s+-rf\s+\//i,
      /rm\s+-rf\s+\*/i,
      /mkfs/i,
      /dd\s+if=/i,
      /:\(\)\{\s*:\s*\|\s*:\s*&\s*\};/i, // Fork bomb
      /chmod\s+([0-7])\1\1\s+/i, // chmod 777 etc
      /chown\s+/i,
      /shutdown\s+-h\s+now/i,
      /reboot/i,
      /killall/i,
      /pkill/i,
      /wget\s+.*\s*\|\s*bash/i,
      /curl\s+.*\s*\|\s*bash/i
    ];

    // 2. Sensitive Data Patterns (DLP - credential leak protection)
    this.sensitivePatterns = {
      'API_KEY': /[a-zA-Z0-9]{32,}/, // Simple catch-all for long alphanumeric strings
      'CREDIT_CARD': /\b(?:\d[ -]*?){15,16}\b/,
      'EMAIL': /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
      'AWS_ACCESS_KEY': /\bAKIA[0-9A-Z]{16}\b/,
      'GCP_SERVICE_ACCOUNT': /"client_email":\s*"[^"]+@gp-key.json"/i,
      'STRIPE_KEY': /\bsk_live_[0-9a-zA-Z]{24}\b/
    };
  }

  /**
   * Scans a task payload for security violations.
   * @param {Object|string} payload - { objective, constraints, ... }
   * @returns {Object} { safe: boolean, reason: string, sanitizedPayload: Object|string }
   */
  async scan(payload) {
    const textToScan = typeof payload === 'string' ? payload : JSON.stringify(payload);
    
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

    // Safe Recursive Sanitization to prevent destroying JSON syntax
    let sensitiveFound = false;
    const sanitizeValue = (value) => {
      if (typeof value === 'string') {
        let current = value;
        for (const [type, pattern] of Object.entries(this.sensitivePatterns)) {
          if (pattern.test(current)) {
            console.warn(`⚠️  [Guardrail] Privacy Warning: ${type} detected. Sanitizing...`);
            current = current.replace(pattern, `[REDACTED_${type}]`);
            sensitiveFound = true;
          }
        }
        return current;
      } else if (Array.isArray(value)) {
        return value.map(item => sanitizeValue(item));
      } else if (value !== null && typeof value === 'object') {
        const copy = {};
        for (const [k, v] of Object.entries(value)) {
          copy[k] = sanitizeValue(v);
        }
        return copy;
      }
      return value;
    };

    const sanitizedPayload = sanitizeValue(payload);

    return {
      safe: true,
      reason: sensitiveFound ? "Sanitized" : "Clean",
      sanitizedPayload: sanitizedPayload
    };
  }
}

module.exports = new GuardrailManager();
