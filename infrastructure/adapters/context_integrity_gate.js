/**
 * ContextIntegrityGate (CIG)
 * Guardian Layer for ContextOS.
 * Prevents double-compression, tracks context provenance, and guards reasoning fidelity.
 */
class ContextIntegrityGate {
  /**
   * Processes the active state context, enforcing integrity policies.
   * @param {Object} context - The current task context snapshot.
   * @returns {Object} Enriched context with integrity policies and mapped headers.
   */
  process(context) {
    const policies = {
      bypass_semantic_compression: false,
      bypass_ast_compression: false,
      provenance: ['raw_task'],
      mode: (context.tags && context.tags.includes('write')) ? 'write' : 'explore'
    };

    // 1. Double Compression Prevention (CodeGraph Injection check)
    if (context.code_context) {
      policies.bypass_semantic_compression = true;
      policies.bypass_ast_compression = true; // CodeGraph results are already surgical; bypass double-compression
      policies.provenance.push('codegraph-ir');
    }

    // 2. Track Preprocessing Provenance (MarkItDown check)
    if (context.objective && (context.objective.includes('.pdf') || context.objective.includes('.xlsx'))) {
      policies.provenance.push('markitdown-preprocessed');
    }

    // 3. Prevent Reasoning Corruption (Write Protection check)
    if (policies.mode === 'write') {
      policies.bypass_semantic_compression = true;
      policies.bypass_ast_compression = true; // Source writing requires absolute code preservation
      policies.provenance.push('write-protection');
    }

    // 4. Map policies to Headroom-compatible HTTP Headers
    const headers = {
      'x-headroom-mode': policies.mode,
      'x-headroom-provenance': policies.provenance.join(','),
      'x-headroom-bypass-compression': (policies.bypass_semantic_compression && policies.bypass_ast_compression) ? '1' : '0'
    };

    console.log(`🛡️  [CIG] Enforced policies: Bypass=${headers['x-headroom-bypass-compression']} | Mode=${policies.mode} | Provenance=[${policies.provenance.join(', ')}]`);

    return {
      ...context,
      integrity_metadata: {
        policies,
        timestamp: Date.now()
      },
      integrity_headers: headers
    };
  }
}

module.exports = new ContextIntegrityGate();
