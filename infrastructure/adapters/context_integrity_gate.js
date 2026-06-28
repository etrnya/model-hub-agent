/**
 * ContextIntegrityGate (CIG)
 * Guardian & Router Layer for ContextOS.
 * Prevents double-compression, tracks context provenance, and routes tasks to optimal compression policies.
 */
class ContextIntegrityGate {
  /**
   * Classifies the task type based on objective, tags, and context properties.
   * @param {Object} context 
   * @returns {'code' | 'doc' | 'debug' | 'explore'}
   */
  classifyTaskType(context) {
    const objective = (context.objective || '').toLowerCase();
    const tags = context.tags || [];

    if (
      tags.includes('write') ||
      tags.includes('refactor') ||
      objective.includes('修改') ||
      objective.includes('重構') ||
      objective.includes('寫入') ||
      objective.includes('添加') ||
      objective.includes('實作') ||
      objective.includes('refactor') ||
      objective.includes('write')
    ) {
      return 'code';
    }

    if (
      objective.includes('.pdf') ||
      objective.includes('.docx') ||
      objective.includes('.xlsx') ||
      objective.includes('文件') ||
      objective.includes('閱讀') ||
      objective.includes('分析') ||
      objective.includes('document')
    ) {
      return 'doc';
    }

    if (
      objective.includes('error') ||
      objective.includes('bug') ||
      objective.includes('crash') ||
      objective.includes('fail') ||
      objective.includes('故障') ||
      objective.includes('偵錯') ||
      objective.includes('錯誤') ||
      objective.includes('日誌') ||
      objective.includes('log')
    ) {
      return 'debug';
    }

    return 'explore';
  }

  /**
   * Processes the active state context, enforcing integrity policies and routing.
   * @param {Object} context - The current task context snapshot.
   * @returns {Object} Enriched context with integrity policies and mapped headers.
   */
  process(context) {
    const taskType = this.classifyTaskType(context);
    
    const policies = {
      task_type: taskType,
      bypass_semantic_compression: false,
      bypass_ast_compression: false,
      effort: 'moderate',
      shaper_policy: 'summarize',
      provenance: ['raw_task']
    };

    // Apply policy based on task classification (CRIL)
    switch (taskType) {
      case 'code':
        policies.bypass_semantic_compression = true;
        policies.bypass_ast_compression = true;
        policies.effort = 'max';
        policies.shaper_policy = 'fidelity';
        policies.provenance.push('write-protection');
        break;
      case 'doc':
        policies.bypass_semantic_compression = false;
        policies.bypass_ast_compression = true; // Docs have no AST; bypass AST parser
        policies.effort = 'moderate';
        policies.shaper_policy = 'summarize';
        policies.provenance.push('document-exploration');
        break;
      case 'debug':
        policies.bypass_semantic_compression = false;
        policies.bypass_ast_compression = false;
        policies.effort = 'high';
        policies.shaper_policy = 'surgical';
        policies.provenance.push('incident-diagnostics');
        break;
      case 'explore':
      default:
        policies.bypass_semantic_compression = false;
        policies.bypass_ast_compression = false;
        policies.effort = 'min';
        policies.shaper_policy = 'cost-saving';
        policies.provenance.push('semantic-explore');
        break;
    }

    // Double Compression Prevention (Force bypass if CodeGraph context is injected)
    if (context.code_context) {
      policies.bypass_semantic_compression = true;
      policies.bypass_ast_compression = true;
      policies.provenance.push('codegraph-ir');
    }

    // Track preprocessed documents
    if (context.objective && (context.objective.includes('.pdf') || context.objective.includes('.xlsx'))) {
      policies.provenance.push('markitdown-preprocessed');
    }

    // Map policies to Headroom-compatible HTTP Headers
    const headers = {
      'x-headroom-mode': policies.task_type,
      'x-headroom-effort': policies.effort,
      'x-headroom-shaper-policy': policies.shaper_policy,
      'x-headroom-provenance': policies.provenance.join(','),
      'x-headroom-bypass-compression': (policies.bypass_semantic_compression && policies.bypass_ast_compression) ? '1' : '0'
    };

    console.log(`🛡️  [CIG/CRIL] Route policy: Class=${taskType} | Bypass=${headers['x-headroom-bypass-compression']} | Effort=${policies.effort} | Provenance=[${policies.provenance.join(', ')}]`);

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
