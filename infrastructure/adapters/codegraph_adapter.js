/**
 * CodeGraphAdapter
 * Bridge adapter to invoke the local CodeGraph CLI tools.
 * Serves as the "Reasoning Accelerator Layer" for Agent OS.
 */
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs').promises;

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
   * Reads a specific range of lines from a file.
   * @param {string} filePath 
   * @param {number} startLine 
   * @param {number} endLine 
   */
  async _readCodeSnippet(filePath, startLine, endLine) {
    try {
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(this.projectPath, filePath);
      const content = await fs.readFile(absolutePath, 'utf8');
      const lines = content.split(/\r?\n/);
      
      // Lines are 1-indexed
      const sliced = lines.slice(startLine - 1, endLine);
      return sliced.join('\n');
    } catch (e) {
      return `(Failed to read code snippet: ${e.message})`;
    }
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

  /**
   * Automatically extracts potential symbols from objective and constraints,
   * queries CodeGraph, and compiles an LLM-ready markdown context block.
   * @param {string} objective 
   * @param {Array<string>} [constraints=[]] 
   * @returns {Promise<string>}
   */
  async extractAndBuildRelations(objective, constraints = []) {
    const combinedText = objective + ' ' + (constraints || []).join(' ');
    
    // Match potential symbols like SchemaValidator, SchemaValidator.validate, silentFix, base_client.js, etc.
    const candidates = Array.from(combinedText.matchAll(/[a-zA-Z0-9_]+(?:::[a-zA-Z0-9_]+)?(?:\.[a-zA-Z0-9_]+)?/g))
      .map(m => m[0])
      .filter(symbol => {
        // Exclude common programming/system stopwords
        const stopwords = new Set([
          'true', 'false', 'const', 'let', 'function', 'class', 'import', 'require', 'return',
          'if', 'else', 'for', 'while', 'async', 'await', 'js', 'json', 'Node', 'GCP', 'Vertex', 'AI', 'NVIDIA',
          'API', 'HTTP', 'headers', 'header', 'Grep', 'View', 'SilentFix', 'VerificationGate'
        ]);
        return symbol.length > 2 && !stopwords.has(symbol) && !/^\d+$/.test(symbol);
      });

    // De-duplicate candidates
    const uniqueSymbols = Array.from(new Set(candidates));
    if (uniqueSymbols.length === 0) {
      return '';
    }

    // Expand symbols with replacements (e.g. A.B -> A::B, A, B)
    const expandedSymbols = [];
    for (const symbol of uniqueSymbols) {
      expandedSymbols.push(symbol);
      if (symbol.includes('.')) {
        expandedSymbols.push(symbol.replace(/\./g, '::'));
        const parts = symbol.split('.');
        parts.forEach(p => {
          if (p.length > 2) expandedSymbols.push(p);
        });
      }
    }
    const finalSymbols = Array.from(new Set(expandedSymbols));

    console.log(`\n🔍 [CodeGraphAdapter] Extracted potential symbols for pre-query: ${finalSymbols.join(', ')}`);

    const contextBlocks = [];

    for (const symbol of finalSymbols) {
      // 1. Check if it's a file name
      if (symbol.endsWith('.js')) {
        const featureCtx = await this.getFeatureContext(symbol);
        if (featureCtx && !featureCtx.startsWith('Error')) {
          contextBlocks.push(`### File Context for: ${symbol}\n${featureCtx}`);
        }
        continue;
      }

      // 2. Query symbol definitions
      let cmd = `codegraph query "${symbol}" --limit 3 --json`;
      try {
        const { stdout } = await execAsync(cmd, { cwd: this.projectPath });
        const results = JSON.parse(stdout);
        
        if (results && results.length > 0) {
          for (const item of results) {
            const node = item.node;
            // Only index methods, classes, functions (skip broad constants if they are noisy)
            if (['method', 'class', 'function'].includes(node.kind)) {
              // Get direct callers for this exact node
              const callersCtx = await this.findCallers(node.qualifiedName || node.name, 1);
              
              // Read code block for the symbol using our helper
              const codeBlock = await this._readCodeSnippet(node.filePath, node.startLine, node.endLine);
              
              const relations = node.signature ? [node.signature] : [];
              const formatted = this.formatLlmContext(
                node.qualifiedName || node.name,
                `${node.filePath}:${node.startLine}`,
                relations,
                [callersCtx],
                `Blast Radius: Changing this ${node.kind} affects downstream callers.`
              );

              contextBlocks.push(`### Symbol: ${node.qualifiedName || node.name}\n${formatted}\n\n#### Source Code Snippet:\n\`\`\`${node.language || 'javascript'}\n${codeBlock}\n\`\`\``);
            }
          }
        }
      } catch (e) {
        // Silently skip if query fails
      }
    }

    if (contextBlocks.length === 0) return '';

    return [
      `## 🧭 CodeGraph Intelligence Context (Pre-Query)`,
      `This section contains the pre-indexed symbols, dependencies, caller graphs, and source snippets relevant to this task extracted locally via CodeGraph.`,
      ...contextBlocks
    ].join('\n\n');
  }
}

module.exports = CodeGraphAdapter;
