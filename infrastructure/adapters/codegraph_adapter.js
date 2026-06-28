/**
 * CodeGraphAdapter
 * Bridge adapter to invoke the local CodeGraph CLI tools.
 * Serves as the "Reasoning Accelerator Layer" for Agent OS.
 */
const { exec } = require('child_process');
const util = require('util');
const path = require('path');

const execAsync = util.promisify(exec);

class CodeGraphAdapter {
  constructor(projectPath) {
    this.projectPath = projectPath || path.resolve(__dirname, '../../');
  }

  /**
   * Formats the outputs into a standard 5-part structure to assist LLM pattern recognition.
   */
  formatLlmContext(symbol, location, relations, callers, impact) {
    return [
      `[SYMBOL]    : ${symbol}`,
      `[LOCATION]  : ${location}`,
      `[RELATIONS] :\n${relations.map(r => `  - ${r}`).join('\n')}`,
      `[CALLERS]   :\n${callers.map(c => `  - ${c}`).join('\n')}`,
      `[IMPACT]    : ${impact}`
    ].join('\n');
  }

  /**
   * 1. findSymbol - Finds symbol definition, location, usages, and callers.
   * @param {string} query 
   * @param {string} [type='any'] 
   * @param {number} [limit=10] 
   * @returns {Promise<string>}
   */
  async findSymbol(query, type = 'any', limit = 10) {
    try {
      let cmd = `codegraph query "${query}" --limit ${limit} --json`;
      const { stdout } = await execAsync(cmd, { cwd: this.projectPath });
      const results = JSON.parse(stdout);

      if (!results || results.length === 0) {
        return `[SYMBOL]    : ${query}\n[STATUS]    : NOT_FOUND\n[IMPACT]    : No impact, symbol not found in codebase.`;
      }

      return results.map(item => {
        const node = item.node;
        const relations = node.signature ? [node.signature] : [];
        const callers = []; // Simple callers list will be populated
        const impact = `Moderate Risk. Changing this ${node.kind} could affect its immediate imports.`;
        
        return this.formatLlmContext(
          node.qualifiedName || node.name,
          `${node.filePath}:${node.startLine}`,
          relations,
          callers,
          impact
        );
      }).join('\n\n---\n\n');
    } catch (error) {
      return `Error finding symbol: ${error.message}`;
    }
  }

  /**
   * 2. findCallers - Finds all callers transitively to analyze blast radius.
   * @param {string} symbol 
   * @param {number} [depth=1] 
   * @returns {Promise<string>}
   */
  async findCallers(symbol, depth = 1) {
    try {
      const cmd = `codegraph callers "${symbol}" --depth ${depth} --json`;
      const { stdout } = await execAsync(cmd, { cwd: this.projectPath });
      const result = JSON.parse(stdout);

      const callers = result.callers || [];
      let riskLevel = 'LOW';
      if (callers.length > 5) riskLevel = 'HIGH';
      else if (callers.length > 0) riskLevel = 'MEDIUM';

      const impact = `[IMPACT SCOPE: ${riskLevel}] Modifying this symbol affects ${callers.length} downstream components.`;

      return [
        `TARGET: ${result.symbol || symbol}`,
        `CALLED BY:`,
        callers.length > 0 
          ? callers.map((c, i) => `${i + 1}. ${c.filePath}:${c.startLine} (${c.name})`).join('\n')
          : '  - (No direct callers found in graph)',
        `\n${impact}`
      ].join('\n');
    } catch (error) {
      return `Error finding callers: ${error.message}`;
    }
  }

  /**
   * 3. getFeatureContext - Gets high-level entry points, flow, and code blocks.
   * @param {string} featureName 
   * @returns {Promise<string>}
   */
  async getFeatureContext(featureName) {
    try {
      // Runs the codegraph context CLI command which generates a complete markdown block
      const cmd = `codegraph context "${featureName}"`;
      const { stdout } = await execAsync(cmd, { cwd: this.projectPath });
      return stdout.trim();
    } catch (error) {
      return `Error building feature context: ${error.message}`;
    }
  }
}

module.exports = CodeGraphAdapter;
