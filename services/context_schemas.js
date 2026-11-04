/**
 * Context Planning & Budgeting Schemas
 * Standardizes schema validation for TaskPayload, RetrievalPlan,
 * and TokenBudgetResult in Phase 1-C3.1.
 * 
 * Author: etrnya
 */

const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

class ContextValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ContextValidationError';
    this.code = 'SCHEMA_VALIDATION_ERROR';
    this.details = details;
  }
}

// 1. TaskPayload Schema
const TaskPayloadSchema = {
  type: 'object',
  required: ['taskId', 'action', 'objective', 'targetSymbols', 'targetFiles'],
  properties: {
    taskId: { type: 'string', minLength: 1 },
    action: {
      type: 'string',
      enum: ['BUG_FIX', 'REFACTOR', 'SECURITY_AUDIT', 'DOCUMENTATION', 'FEATURE']
    },
    objective: { type: 'string', minLength: 1 },
    targetSymbols: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1
    },
    targetFiles: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1
    },
    callerHints: {
      type: 'array',
      items: { type: 'string' }
    },
    maxExecutionTokens: {
      type: 'integer',
      minimum: 100,
      maximum: 32000
    },
    createdAt: { type: 'string' }
  },
  additionalProperties: true
};

// 2. RetrievalPlan Schema
const RetrievalPlanSchema = {
  type: 'object',
  required: [
    'planId',
    'roleId',
    'taskCategory',
    'policyName',
    'targetSymbols',
    'targetFiles',
    'traversalDepth',
    'traversalDirection',
    'includeSourceSnippets',
    'includeAffectedTests',
    'foldImplementations',
    'maxTokenBudget',
    'generatedAt'
  ],
  properties: {
    planId: { type: 'string', minLength: 1 },
    roleId: { type: 'string', minLength: 1 },
    taskCategory: {
      type: 'string',
      enum: ['BUG_FIX', 'REFACTOR', 'SECURITY_AUDIT', 'DOCUMENTATION', 'FEATURE']
    },
    policyName: {
      type: 'string',
      enum: [
        'ARCH_REFACTOR',
        'ARCH_TOPOLOGY',
        'REVIEW_BUGFIX',
        'REVIEW_SECURITY',
        'DOCS_INTERFACES',
        'BALANCED_DEFAULT'
      ]
    },
    targetSymbols: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1
    },
    targetFiles: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1
    },
    traversalDepth: {
      type: 'integer',
      minimum: 1,
      maximum: 3
    },
    traversalDirection: {
      type: 'string',
      enum: ['incoming', 'outgoing', 'bidirectional']
    },
    includeSourceSnippets: { type: 'boolean' },
    includeAffectedTests: { type: 'boolean' },
    foldImplementations: { type: 'boolean' },
    maxTokenBudget: {
      type: 'integer',
      minimum: 100,
      maximum: 6000
    },
    generatedAt: { type: 'string' }
  },
  additionalProperties: true
};

// 3. TokenBudgetResult Schema
const TokenBudgetResultSchema = {
  type: 'object',
  required: ['success', 'totalTokens', 'hardCapLimit', 'retainedItems', 'truncatedItems', 'notices'],
  properties: {
    success: { type: 'boolean' },
    totalTokens: { type: 'integer', minimum: 0 },
    hardCapLimit: { type: 'integer', minimum: 1 },
    retainedItems: { type: 'array' },
    truncatedItems: {
      type: 'array',
      items: {
        type: 'object',
        required: ['symbol', 'filePath', 'pruningAction', 'tokensSaved'],
        properties: {
          symbol: { type: 'string' },
          filePath: { type: 'string' },
          originalLines: { type: 'integer' },
          pruningAction: {
            type: 'string',
            enum: ['FOLDED', 'STRIPPED_SNIPPET', 'OMITTED']
          },
          tokensSaved: { type: 'integer' }
        }
      }
    },
    notices: {
      type: 'array',
      items: { type: 'string' }
    },
    errorCode: {
      type: 'string',
      enum: [
        'CORE_EVIDENCE_OVER_BUDGET',
        'TOKEN_BUDGET_UNVERIFIABLE',
        'FINAL_SERIALIZED_CONTEXT_OVER_BUDGET'
      ]
    }
  },
  additionalProperties: true
};

// Compile validators
const validateTaskPayloadCompiled = ajv.compile(TaskPayloadSchema);
const validateRetrievalPlanCompiled = ajv.compile(RetrievalPlanSchema);
const validateTokenBudgetResultCompiled = ajv.compile(TokenBudgetResultSchema);

function validateTaskPayload(payload) {
  const valid = validateTaskPayloadCompiled(payload);
  if (!valid) {
    throw new ContextValidationError(
      `TaskPayload validation failed: ${ajv.errorsText(validateTaskPayloadCompiled.errors)}`,
      validateTaskPayloadCompiled.errors
    );
  }
  return true;
}

function validateRetrievalPlan(plan) {
  const valid = validateRetrievalPlanCompiled(plan);
  if (!valid) {
    throw new ContextValidationError(
      `RetrievalPlan validation failed: ${ajv.errorsText(validateRetrievalPlanCompiled.errors)}`,
      validateRetrievalPlanCompiled.errors
    );
  }
  return true;
}

function validateTokenBudgetResult(result) {
  const valid = validateTokenBudgetResultCompiled(result);
  if (!valid) {
    throw new ContextValidationError(
      `TokenBudgetResult validation failed: ${ajv.errorsText(validateTokenBudgetResultCompiled.errors)}`,
      validateTokenBudgetResultCompiled.errors
    );
  }
  return true;
}

module.exports = {
  ContextValidationError,
  TaskPayloadSchema,
  RetrievalPlanSchema,
  TokenBudgetResultSchema,
  validateTaskPayload,
  validateRetrievalPlan,
  validateTokenBudgetResult
};
