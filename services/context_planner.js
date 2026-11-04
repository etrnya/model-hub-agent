/**
 * Role-Aware Context Planner
 * 
 * Part of Phase 1-C3.1: Core Planning & Budgeting
 * Implements deterministic Role-aware and Task-aware retrieval planning
 * with a strict 3-tier priority hierarchy:
 *   Tier 1: Security Invariants (Path sandboxing, Hard Token caps, Max Depth)
 *   Tier 2: Task Mandatory Requirements (E.g. BUG_FIX must include tests & callers)
 *   Tier 3: Role Preference (Folding peripheral code, docstring detail)
 * 
 * Author: etrnya
 */

const crypto = require('node:crypto');
const path = require('node:path');
const {
  validateTaskPayload,
  validateRetrievalPlan,
  ContextValidationError
} = require('./context_schemas');

class CodeGraphSecurityError extends Error {
  constructor(message, code = 'SECURITY_VIOLATION') {
    super(message);
    this.name = 'CodeGraphSecurityError';
    this.code = code;
  }
}

class RoleAwareContextPlanner {
  /**
   * @param {Object} [options]
   * @param {number} [options.defaultMaxTokens=3000]
   * @param {number} [options.maxAllowedBudget=6000]
   */
  constructor(options = {}) {
    this.defaultMaxTokens = options.defaultMaxTokens || 3000;
    this.maxAllowedBudget = options.maxAllowedBudget || 6000;
  }

  /**
   * Validates target file path against Tier 1 Security Invariants:
   * Must be relative POSIX path, no directory traversal ('..'), no absolute paths, no null bytes.
   * @param {string} filePath 
   */
  validatePathSafety(filePath) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new CodeGraphSecurityError('File path must be a non-empty string', 'INVALID_TARGET_FILE_PATH');
    }
    if (filePath.includes('\0')) {
      throw new CodeGraphSecurityError('Null byte detected in file path', 'PATH_TRAVERSAL_DETECTED');
    }
    // Check for directory traversal sequences
    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (segments.includes('..')) {
      throw new CodeGraphSecurityError(`Path traversal attempt detected in target file: "${filePath}"`, 'PATH_TRAVERSAL_DETECTED');
    }
    if (path.isAbsolute(filePath) || /^[a-zA-Z]:/.test(filePath) || normalized.startsWith('/')) {
      throw new CodeGraphSecurityError(`Absolute paths are prohibited in target file: "${filePath}"`, 'ABSOLUTE_PATH_PROHIBITED');
    }
    return normalized;
  }

  /**
   * Resolves the deterministic policy and planning parameters
   * based on the 3-tier priority hierarchy.
   * 
   * @param {string} roleId
   * @param {string} action
   * @returns {Object}
   */
  resolvePolicyAndParameters(roleId, action) {
    const role = (roleId || 'default').toLowerCase();
    
    // Default baseline parameters
    let policyName = 'BALANCED_DEFAULT';
    let traversalDepth = 1;
    let traversalDirection = 'bidirectional';
    let includeSourceSnippets = true;
    let includeAffectedTests = false;
    let foldImplementations = false;

    // --- Tier 2: Task Mandatory Requirements ---
    switch (action) {
      case 'BUG_FIX':
        traversalDepth = 2;
        traversalDirection = 'incoming';
        includeAffectedTests = true; // MANDATORY: tests must be included
        includeSourceSnippets = true;
        policyName = 'REVIEW_BUGFIX';
        break;

      case 'REFACTOR':
        traversalDepth = 2;
        traversalDirection = 'bidirectional';
        includeAffectedTests = true; // MANDATORY: affected tests for blast radius
        includeSourceSnippets = true;
        policyName = 'ARCH_REFACTOR';
        break;

      case 'SECURITY_AUDIT':
        traversalDepth = 3; // MANDATORY: deep entrypoint tracing
        traversalDirection = 'bidirectional';
        includeAffectedTests = true;
        includeSourceSnippets = true;
        policyName = 'REVIEW_SECURITY';
        break;

      case 'DOCUMENTATION':
        traversalDepth = 1;
        traversalDirection = 'outgoing';
        includeAffectedTests = false; // Documentation does not need test suites
        foldImplementations = true;  // MANDATORY: fold internal bodies
        policyName = 'DOCS_INTERFACES';
        break;

      case 'FEATURE':
        traversalDepth = 2;
        traversalDirection = 'bidirectional';
        includeAffectedTests = true;
        includeSourceSnippets = true;
        policyName = 'ARCH_TOPOLOGY';
        break;

      default:
        policyName = 'BALANCED_DEFAULT';
        break;
    }

    // --- Tier 3: Role Preference Application (Cannot override Tier 2 Mandatories) ---
    if (role === 'software_architect') {
      foldImplementations = true; // Architect prefers folding peripheral implementations
      if (action === 'FEATURE' || action === 'REFACTOR') {
        policyName = action === 'REFACTOR' ? 'ARCH_REFACTOR' : 'ARCH_TOPOLOGY';
      }
    } else if (role === 'code_reviewer') {
      // Code reviewer demands tests and caller context
      includeAffectedTests = true;
      if (action === 'BUG_FIX') {
        policyName = 'REVIEW_BUGFIX';
      } else if (action === 'SECURITY_AUDIT') {
        policyName = 'REVIEW_SECURITY';
      }
    } else if (role === 'doc_synthesizer') {
      foldImplementations = true; // Synthesizer strongly prefers interface folding
      if (action === 'DOCUMENTATION') {
        policyName = 'DOCS_INTERFACES';
      }
      // CRITICAL TIER 2 OVERRIDE:
      // If role is doc_synthesizer but action is BUG_FIX or REFACTOR,
      // Tier 2 MANDATORY requirement overrides Tier 3!
      if (action === 'BUG_FIX' || action === 'REFACTOR' || action === 'SECURITY_AUDIT') {
        includeAffectedTests = true; // Tier 2 retains test suites!
      }
    }

    // --- Tier 1: Security Invariants (Capping Depth & Sanitizing) ---
    traversalDepth = Math.max(1, Math.min(3, traversalDepth));

    return {
      policyName,
      traversalDepth,
      traversalDirection,
      includeSourceSnippets,
      includeAffectedTests,
      foldImplementations
    };
  }

  /**
   * Plans a deterministic RetrievalPlan for a given role and task.
   * 
   * @param {string|null} roleId 
   * @param {Object} taskPayload 
   * @returns {Promise<Object>} RetrievalPlan
   */
  async plan(roleId, taskPayload) {
    if (!taskPayload || typeof taskPayload !== 'object') {
      throw new ContextValidationError('TaskPayload must be a non-null object');
    }

    // 1. Validate incoming TaskPayload Schema
    validateTaskPayload(taskPayload);

    // 2. Validate Security Invariants on Target Files
    const sanitizedFiles = taskPayload.targetFiles.map(f => this.validatePathSafety(f));
    const uniqueFiles = [...new Set(sanitizedFiles)];
    const uniqueSymbols = [...new Set(taskPayload.targetSymbols.map(s => String(s).trim()))];

    // 3. Resolve Token Budget (Tier 1 Constraint)
    let requestedBudget = taskPayload.maxExecutionTokens || this.defaultMaxTokens;
    if (typeof requestedBudget !== 'number' || isNaN(requestedBudget) || requestedBudget <= 0) {
      requestedBudget = this.defaultMaxTokens;
    }
    const maxTokenBudget = Math.min(requestedBudget, this.maxAllowedBudget);

    // 4. Resolve Policy and Parameters via 3-tier hierarchy
    const resolved = this.resolvePolicyAndParameters(roleId, taskPayload.action);

    // 5. Construct RetrievalPlan
    const planId = `plan-${crypto.randomUUID().slice(0, 8)}`;
    const plan = {
      planId,
      roleId: (roleId || 'default').trim(),
      taskCategory: taskPayload.action,
      policyName: resolved.policyName,
      targetSymbols: uniqueSymbols,
      targetFiles: uniqueFiles,
      traversalDepth: resolved.traversalDepth,
      traversalDirection: resolved.traversalDirection,
      includeSourceSnippets: resolved.includeSourceSnippets,
      includeAffectedTests: resolved.includeAffectedTests,
      foldImplementations: resolved.foldImplementations,
      maxTokenBudget,
      generatedAt: new Date().toISOString()
    };

    // 6. Validate output RetrievalPlan Schema
    validateRetrievalPlan(plan);

    return plan;
  }
}

module.exports = {
  RoleAwareContextPlanner,
  CodeGraphSecurityError
};
