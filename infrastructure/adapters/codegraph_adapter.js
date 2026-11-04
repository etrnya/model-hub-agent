/**
 * CodeGraphAdapter (Hardened & Sealed)
 * Bridge adapter to invoke the local CodeGraph CLI tools with robust sandbox protection,
 * schema validation, and lifecycle state management.
 * 
 * Part of Agent OS Phase 1-C1.
 * Author: etrnya
 */
const { execFile } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');

const execFileAsync = util.promisify(execFile);

const {
  CodeGraphValidationError,
  validateCodeGraphNode,
  validateCallerRelation,
  validateCalleeRelation,
  validateImpactAnalysis,
  validateCodeGraphStatus
} = require('./codegraph_schemas');

class CodeGraphSecurityError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = 'CodeGraphSecurityError';
    this.code = code;
  }
}

class CodeGraphCliError extends Error {
  constructor(code, message, exitCode = null) {
    super(`[${code}] ${message}`);
    this.name = 'CodeGraphCliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

// Security & Sandbox Constants
// Allow alphanumeric, underscore, colon, dot, forward/back slash, hyphen
const SYMBOL_REGEX = /^[a-zA-Z0-9_:./\\-]+$/;
const MAX_SNIPPET_LINES = 500;
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB
const EXEC_TIMEOUT_MS = 5000;           // 5s
const EXEC_MAX_BUFFER = 5 * 1024 * 1024;// 5MB

// Blacklist definitions
const BLACKLIST_PATH_REGEX = /(?:^|[/\\])(?:\.git|\.env|node_modules|id_rsa|id_ed25519)(?:$|[/\\]|\.)/i;
const BLACKLIST_EXT_REGEX = /\.(pem|key|pfx|crt|p12)$/i;

// Determine platform-safe binary & prefix args for zero-shell execution
function resolveCliExecution(customExecutable) {
  if (customExecutable) {
    return { binary: customExecutable, prefixArgs: [] };
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const shimPath = path.join(appData, 'npm/node_modules/@colbymchenry/codegraph/npm-shim.js');
    if (fsSync.existsSync(shimPath)) {
      // Execute via node directly to bypass Windows batch file CVE restrictions while strictly avoiding shell
      return { binary: process.execPath, prefixArgs: [shimPath] };
    }
  }

  return { binary: 'codegraph', prefixArgs: [] };
}

class CodeGraphAdapter {
  /**
   * @param {string} [projectPath] - Absolute path to project root
   * @param {object} [options]
   * @param {string} [options.cliExecutable] - Custom executable name or path
   * @param {Function} [options.cliRunner] - Optional mock runner for Tier 1 tests
   * @param {number} [options.timeoutMs=5000] - CLI execution timeout
   * @param {number} [options.maxBufferBytes=5242880] - Maximum stdout buffer
   */
  constructor(projectPath, options = {}) {
    this.projectPath = path.resolve(projectPath || path.resolve(__dirname, '../../'));
    const resolvedCli = resolveCliExecution(options.cliExecutable);
    this.cliExecutable = resolvedCli.binary;
    this.cliPrefixArgs = resolvedCli.prefixArgs;
    this.cliRunner = options.cliRunner || null;
    this.timeoutMs = options.timeoutMs || EXEC_TIMEOUT_MS;
    this.maxBufferBytes = options.maxBufferBytes || EXEC_MAX_BUFFER;

    // Index lifecycle state machine: IDLE -> SYNCING -> READY / DEGRADED
    this.indexState = 'IDLE';
    this.activeSyncPromise = null;
    this.lastSuccessfulStatus = null;
    this.lastSyncedAt = null;
  }

  /**
   * Validates a symbol name against strict regex whitelist.
   * Throws CodeGraphSecurityError if illegal characters detected.
   * @param {string} symbol
   * @returns {string} Trimmed valid symbol
   */
  validateSymbol(symbol) {
    if (!symbol || typeof symbol !== 'string') {
      throw new CodeGraphSecurityError('INVALID_SYMBOL', 'Symbol must be a non-empty string');
    }
    const trimmed = symbol.trim();
    if (!trimmed || !SYMBOL_REGEX.test(trimmed)) {
      throw new CodeGraphSecurityError('INVALID_SYMBOL', `Symbol contains illegal characters: "${symbol}"`);
    }
    return trimmed;
  }

  /**
   * Secure CLI Execution wrapper using execFile (No Shell).
   * @param {string[]} args
   * @returns {Promise<string>} stdout output
   */
  async _runCli(args) {
    try {
      if (this.cliRunner) {
        return await this.cliRunner(args);
      }

      const fullArgs = [...this.cliPrefixArgs, ...args];
      const { stdout } = await execFileAsync(this.cliExecutable, fullArgs, {
        cwd: this.projectPath,
        timeout: this.timeoutMs,
        maxBuffer: this.maxBufferBytes,
        windowsHide: true,
        shell: false
      });
      return stdout;
    } catch (err) {
      if (err instanceof CodeGraphCliError || err instanceof CodeGraphSecurityError) {
        throw err;
      }
      if (err.code === 'ENOENT') {
        throw new CodeGraphCliError('CLI_NOT_FOUND', `CodeGraph executable not found: "${this.cliExecutable}"`);
      }
      if (err.killed && (err.signal === 'SIGTERM' || err.signal === 'SIGKILL')) {
        throw new CodeGraphCliError('CLI_TIMEOUT', `CodeGraph CLI execution timed out after ${this.timeoutMs}ms`);
      }
      if (err.message && err.message.toLowerCase().includes('timed out')) {
        throw new CodeGraphCliError('CLI_TIMEOUT', `CodeGraph CLI execution timed out: ${err.message}`);
      }
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new CodeGraphCliError('CLI_OUTPUT_TOO_LARGE', `CodeGraph CLI output exceeded maximum buffer of ${this.maxBufferBytes} bytes`);
      }
      throw new CodeGraphCliError('CLI_NON_ZERO_EXIT', `CodeGraph CLI failed: ${err.message}`, err.code);
    }
  }

  /**
   * Safely parses JSON output from CLI with specific error taxonomy.
   * @param {string} raw
   * @returns {any}
   */
  _parseJson(raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new CodeGraphCliError('CLI_INVALID_JSON', `Failed to parse CodeGraph CLI JSON response: ${e.message}`);
    }
  }

  /**
   * Resolves and verifies that a target file path strictly resides within the project root,
   * handles symlinks securely, and filters sensitive blacklisted files.
   * @param {string} filePath
   * @returns {Promise<string>} Validated real absolute path
   */
  async resolveAndValidatePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      throw new CodeGraphSecurityError('INVALID_PATH', 'File path must be a non-empty string');
    }

    // 1. Blacklist check on raw input
    if (BLACKLIST_PATH_REGEX.test(filePath) || BLACKLIST_EXT_REGEX.test(filePath)) {
      throw new CodeGraphSecurityError('FILE_ACCESS_DENIED', `Access to sensitive path or extension is blocked: ${filePath}`);
    }

    // 2. Resolve relative to project root
    const resolvedPath = path.resolve(this.projectPath, filePath);

    // 3. Strict Boundary check (No startsWith naive checking)
    const relative = path.relative(this.projectPath, resolvedPath);
    const isInside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!isInside && relative !== '') {
      throw new CodeGraphSecurityError('PATH_TRAVERSAL_DETECTED', `Path traversal detected: "${filePath}" escapes project root`);
    }

    // 4. Resolve Symbolic Links (Symlink escape defense)
    let realPath;
    try {
      realPath = await fs.realpath(resolvedPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new CodeGraphSecurityError('FILE_NOT_FOUND', `File not found: ${filePath}`);
      }
      throw err;
    }

    // 5. Verify Real Path Boundary
    const realRelative = path.relative(this.projectPath, realPath);
    const isRealInside = realRelative !== '' && !realRelative.startsWith('..') && !path.isAbsolute(realRelative);
    if (!isRealInside) {
      throw new CodeGraphSecurityError('PATH_TRAVERSAL_DETECTED', `Symlink escapes project root: "${filePath}" -> "${realPath}"`);
    }

    // 6. Blacklist check on real relative path
    if (BLACKLIST_PATH_REGEX.test(realRelative) || BLACKLIST_EXT_REGEX.test(realRelative)) {
      throw new CodeGraphSecurityError('FILE_ACCESS_DENIED', `Resolved target is blocked by security policy: ${realRelative}`);
    }

    return realPath;
  }

  /**
   * Safely reads a code snippet from a source file with strict line & size limits,
   * binary rejection, and provenance dual-SHA256 calculation.
   * @param {string} filePath 
   * @param {number} startLine 
   * @param {number} endLine 
   * @returns {Promise<{ content: string, lineCount: number, fileSha256: string, snippetSha256: string }>}
   */
  async readCodeSnippet(filePath, startLine, endLine) {
    const realPath = await this.resolveAndValidatePath(filePath);

    if (typeof startLine !== 'number' || typeof endLine !== 'number' || startLine < 1 || endLine < startLine) {
      throw new CodeGraphSecurityError('INVALID_LINE_RANGE', `Invalid line range [${startLine}, ${endLine}]`);
    }

    const requestedLines = endLine - startLine + 1;
    if (requestedLines > MAX_SNIPPET_LINES) {
      throw new CodeGraphSecurityError('EXCEEDED_LINE_LIMIT', `Requested ${requestedLines} lines exceeds maximum allowed limit of ${MAX_SNIPPET_LINES} lines`);
    }

    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      throw new CodeGraphSecurityError('NOT_A_FILE', `Target is not a regular file: ${filePath}`);
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new CodeGraphSecurityError('FILE_TOO_LARGE', `File size (${stat.size} bytes) exceeds maximum limit of 1MB`);
    }

    // Check first 8000 bytes for binary null byte (0x00)
    const fd = await fs.open(realPath, 'r');
    try {
      const probeSize = Math.min(stat.size, 8000);
      const probeBuffer = Buffer.alloc(probeSize);
      await fd.read(probeBuffer, 0, probeSize, 0);
      if (probeBuffer.includes(0x00)) {
        throw new CodeGraphSecurityError('BINARY_FILE_REJECTED', `Binary file content detected: ${filePath}`);
      }
    } finally {
      await fd.close();
    }

    const fullContent = await fs.readFile(realPath, 'utf8');
    const fileSha256 = crypto.createHash('sha256').update(fullContent).digest('hex');

    const lines = fullContent.split(/\r?\n/);
    const sliced = lines.slice(startLine - 1, endLine);
    const snippetContent = sliced.join('\n');
    const snippetSha256 = crypto.createHash('sha256').update(snippetContent).digest('hex');

    return {
      content: snippetContent,
      lineCount: sliced.length,
      fileSha256,
      snippetSha256
    };
  }

  /**
   * Synchronizes CodeGraph index with concurrency lock and lifecycle state machine.
   * Returns identical in-flight Promise when called concurrently.
   * @returns {Promise<{ success: boolean, modifiedCount: number, status: string }>}
   */
  syncIndex() {
    if (this.activeSyncPromise) {
      return this.activeSyncPromise;
    }

    this.indexState = 'SYNCING';

    this.activeSyncPromise = (async () => {
      try {
        const raw = await this._runCli(['sync', '--json']);
        let result = {};
        try {
          result = JSON.parse(raw);
        } catch {
          // If CLI doesn't output JSON for sync, treat non-empty output as success
          result = { success: true, modifiedCount: 0 };
        }

        this.indexState = 'READY';
        this.lastSyncedAt = new Date().toISOString();
        return {
          success: true,
          modifiedCount: result.modifiedCount || 0,
          status: this.indexState
        };
      } catch (err) {
        this.indexState = 'DEGRADED';
        // Do not throw away last successful state if degraded
        return {
          success: false,
          error: err.message,
          status: this.indexState
        };
      } finally {
        this.activeSyncPromise = null;
      }
    })();

    return this.activeSyncPromise;
  }

  /**
   * Retrieves CodeGraph database status with schema validation.
   * @returns {Promise<object>}
   */
  async getStatus() {
    try {
      const raw = await this._runCli(['status', '--json']);
      const data = this._parseJson(raw);
      
      // Normalize CLI differences (e.g. CLI has initialized: true instead of status)
      if (!data.status && data.initialized !== undefined) {
        data.status = data.initialized ? 'READY' : 'UNINITIALIZED';
      }

      validateCodeGraphStatus(data, true);
      this.lastSuccessfulStatus = data;
      this.indexState = 'READY';
      return data;
    } catch (err) {
      if (this.lastSuccessfulStatus) {
        this.indexState = 'DEGRADED';
        return { ...this.lastSuccessfulStatus, status: 'DEGRADED' };
      }
      throw err;
    }
  }

  /**
   * Queries symbols from CodeGraph AST with schema validation.
   * @param {string} query 
   * @param {object} [options]
   * @param {number} [options.limit=10]
   * @param {string} [options.kind]
   * @returns {Promise<Array<object>>}
   */
  async querySymbols(query, options = {}) {
    const validSymbol = this.validateSymbol(query);
    const limit = Math.max(1, Math.min(options.limit || 10, 50));

    const args = ['query', validSymbol, '--limit', String(limit), '--json'];
    if (options.kind) {
      args.push('--kind', options.kind);
    }

    const raw = await this._runCli(args);
    const results = this._parseJson(raw);

    if (!Array.isArray(results)) {
      throw new CodeGraphValidationError('CodeGraph query output must be an array');
    }

    const validatedNodes = [];
    for (const item of results) {
      const node = item.node || item;
      validateCodeGraphNode(node, true);
      validatedNodes.push(node);
    }

    return validatedNodes;
  }

  /**
   * Finds callers for a given symbol with schema validation.
   * @param {string} symbol 
   * @param {number|object} [options] - limit or options object
   * @returns {Promise<{ symbol: string, callers: Array<object> }>}
   */
  async findCallers(symbol, options = {}) {
    const validSymbol = this.validateSymbol(symbol);
    const limit = typeof options === 'number' ? options : (options.limit || 20);
    const safeLimit = Math.max(1, Math.min(limit, 100));

    const args = ['callers', validSymbol, '--limit', String(safeLimit), '--json'];
    const raw = await this._runCli(args);
    const data = this._parseJson(raw);

    // Normalize output structure
    const payload = {
      symbol: data.symbol || validSymbol,
      callers: Array.isArray(data.callers) ? data.callers : (Array.isArray(data) ? data : [])
    };

    validateCallerRelation(payload, true);
    return payload;
  }

  /**
   * Finds callees for a given symbol with schema validation.
   * @param {string} symbol 
   * @param {number|object} [options] - limit or options object
   * @returns {Promise<{ symbol: string, callees: Array<object> }>}
   */
  async findCallees(symbol, options = {}) {
    const validSymbol = this.validateSymbol(symbol);
    const limit = typeof options === 'number' ? options : (options.limit || 20);
    const safeLimit = Math.max(1, Math.min(limit, 100));

    const args = ['callees', validSymbol, '--limit', String(safeLimit), '--json'];
    const raw = await this._runCli(args);
    const data = this._parseJson(raw);

    const payload = {
      symbol: data.symbol || validSymbol,
      callees: Array.isArray(data.callees) ? data.callees : (Array.isArray(data) ? data : [])
    };

    validateCalleeRelation(payload, true);
    return payload;
  }

  /**
   * Analyzes impact (blast radius) for a given symbol with schema validation.
   * @param {string} symbol 
   * @param {number} [depth=2] 
   * @returns {Promise<object>}
   */
  async analyzeImpact(symbol, depth = 2) {
    const validSymbol = this.validateSymbol(symbol);
    const safeDepth = Math.max(1, Math.min(depth, 5));

    const args = ['impact', validSymbol, '--depth', String(safeDepth), '--json'];
    const raw = await this._runCli(args);
    const data = this._parseJson(raw);

    // Calculate blastRadius if missing from CLI output
    let blastRadius = data.blastRadius;
    const affectedCount = Array.isArray(data.affected) ? data.affected.length : 0;
    if (!blastRadius) {
      if (affectedCount > 10) blastRadius = 'HIGH';
      else if (affectedCount > 2) blastRadius = 'MEDIUM';
      else blastRadius = 'LOW';
    }

    const payload = {
      symbol: data.symbol || validSymbol,
      depth: safeDepth,
      nodeCount: data.nodeCount !== undefined ? data.nodeCount : affectedCount,
      edgeCount: data.edgeCount !== undefined ? data.edgeCount : 0,
      blastRadius,
      affected: Array.isArray(data.affected) ? data.affected : []
    };

    validateImpactAnalysis(payload, true);
    return payload;
  }

  /**
   * Formats the outputs into a standard 5-part structure to assist LLM pattern recognition.
   */
  formatLlmContext(symbol, location, relations, callers, impact) {
    return [
      `[SYMBOL]    : ${symbol}`,
      `[LOCATION]  : ${location}`,
      `[RELATIONS] :\n${(relations || []).map(r => `  - ${r}`).join('\n')}`,
      `[CALLERS]   :\n${(callers || []).map(c => `  - ${c}`).join('\n')}`,
      `[IMPACT]    : ${impact}`
    ].join('\n');
  }

  /**
   * Backward-compatible findSymbol wrapper.
   */
  async findSymbol(query, type = 'any', limit = 10) {
    try {
      const nodes = await this.querySymbols(query, { limit });
      if (nodes.length === 0) {
        return `[SYMBOL]    : ${query}\n[STATUS]    : NOT_FOUND\n[IMPACT]    : No impact, symbol not found in codebase.`;
      }
      return nodes.map(node => {
        const relations = node.signature ? [node.signature] : [];
        const impact = `Moderate Risk. Changing this ${node.kind || 'symbol'} could affect its immediate imports.`;
        return this.formatLlmContext(
          node.qualifiedName || node.name,
          `${node.filePath}:${node.startLine}`,
          relations,
          [],
          impact
        );
      }).join('\n\n---\n\n');
    } catch (error) {
      return `Error finding symbol: ${error.message}`;
    }
  }

  /**
   * Backward-compatible getFeatureContext wrapper.
   */
  async getFeatureContext(featureName) {
    try {
      const validSymbol = this.validateSymbol(featureName);
      const stdout = await this._runCli(['context', validSymbol]);
      return stdout.trim();
    } catch (error) {
      return `Error building feature context: ${error.message}`;
    }
  }
}

CodeGraphAdapter.CodeGraphAdapter = CodeGraphAdapter;
CodeGraphAdapter.CodeGraphSecurityError = CodeGraphSecurityError;
CodeGraphAdapter.CodeGraphCliError = CodeGraphCliError;

module.exports = CodeGraphAdapter;
