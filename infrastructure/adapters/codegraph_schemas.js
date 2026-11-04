/**
 * CodeGraph Schemas and Validators
 * Standardizes schema validation for all CodeGraph CLI JSON payloads.
 * Part of Phase 1-C1 Hardening.
 * 
 * Author: etrnya
 */
const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

class CodeGraphValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'CodeGraphValidationError';
    this.code = 'SCHEMA_VALIDATION_ERROR';
    this.details = details;
  }
}

// 1. CodeGraphNode Schema
const CodeGraphNodeSchema = {
  type: 'object',
  required: ['name', 'filePath', 'startLine', 'endLine'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string', minLength: 1 },
    qualifiedName: { type: 'string' },
    kind: { type: 'string' },
    filePath: { type: 'string', minLength: 1 },
    language: { type: 'string' },
    startLine: { type: 'integer', minimum: 1 },
    endLine: { type: 'integer', minimum: 1 },
    signature: { type: 'string' },
    docstring: { type: 'string' },
    isExported: { type: 'boolean' },
    isAsync: { type: 'boolean' }
  },
  additionalProperties: true
};

// 2. CallerRelation Schema
const CallerRelationSchema = {
  type: 'object',
  required: ['symbol', 'callers'],
  properties: {
    symbol: { type: 'string', minLength: 1 },
    depth: { type: 'integer', minimum: 1 },
    callers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'filePath', 'startLine'],
        properties: {
          name: { type: 'string' },
          qualifiedName: { type: 'string' },
          filePath: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          kind: { type: 'string' }
        },
        additionalProperties: true
      }
    }
  },
  additionalProperties: true
};

// 3. CalleeRelation Schema
const CalleeRelationSchema = {
  type: 'object',
  required: ['symbol', 'callees'],
  properties: {
    symbol: { type: 'string', minLength: 1 },
    depth: { type: 'integer', minimum: 1 },
    callees: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'filePath', 'startLine'],
        properties: {
          name: { type: 'string' },
          qualifiedName: { type: 'string' },
          filePath: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          kind: { type: 'string' }
        },
        additionalProperties: true
      }
    }
  },
  additionalProperties: true
};

// 4. ImpactAnalysis Schema
const ImpactAnalysisSchema = {
  type: 'object',
  required: ['symbol', 'blastRadius', 'affected'],
  properties: {
    symbol: { type: 'string', minLength: 1 },
    depth: { type: 'integer', minimum: 0 },
    nodeCount: { type: 'integer', minimum: 0 },
    edgeCount: { type: 'integer', minimum: 0 },
    blastRadius: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    affected: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'kind', 'filePath', 'startLine'],
        properties: {
          name: { type: 'string' },
          kind: { type: 'string' },
          filePath: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 }
        },
        additionalProperties: true
      }
    }
  },
  additionalProperties: true
};

// 5. CodeGraphStatus Schema
const CodeGraphStatusSchema = {
  type: 'object',
  required: ['status', 'nodeCount'],
  properties: {
    status: { type: 'string' },
    nodeCount: { type: 'integer', minimum: 0 },
    edgeCount: { type: 'integer', minimum: 0 },
    fileCount: { type: 'integer', minimum: 0 },
    dbPath: { type: 'string' },
    version: { type: 'string' }
  },
  additionalProperties: true
};

const compileValidator = (schema) => {
  const validate = ajv.compile(schema);
  return (data, throwOnError = false) => {
    const valid = validate(data);
    if (!valid && throwOnError) {
      const errorMsg = (validate.errors || []).map(e => `${e.instancePath || 'root'} ${e.message}`).join(', ');
      throw new CodeGraphValidationError(`Validation failed: ${errorMsg}`, validate.errors);
    }
    return {
      valid,
      errors: validate.errors || []
    };
  };
};

const validateCodeGraphNode = compileValidator(CodeGraphNodeSchema);
const validateCallerRelation = compileValidator(CallerRelationSchema);
const validateCalleeRelation = compileValidator(CalleeRelationSchema);
const validateImpactAnalysis = compileValidator(ImpactAnalysisSchema);
const validateCodeGraphStatus = compileValidator(CodeGraphStatusSchema);

module.exports = {
  CodeGraphValidationError,
  CodeGraphNodeSchema,
  CallerRelationSchema,
  CalleeRelationSchema,
  ImpactAnalysisSchema,
  CodeGraphStatusSchema,
  validateCodeGraphNode,
  validateCallerRelation,
  validateCalleeRelation,
  validateImpactAnalysis,
  validateCodeGraphStatus
};

