const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

/**
 * RoleManager
 * 受限的角色定義載入器與資料轉換器 (Bounded Data Transformer)
 * 
 * 核心原則：
 * 1. 白名單查找，杜絕路徑穿越。
 * 2. 啟動時執行 Meta-Schema 與 Output Schema 雙重編譯校驗。
 * 3. 輸出採用 structuredClone 進行完整參照隔離，防止外部修改內部設定。
 * 4. 使用 Object.hasOwn() 嚴格判斷欄位存在性，禁止隱式寬容覆寫。
 */

const VALID_TIERS = ['ultra', 'high', 'medium', 'base'];
const REGISTERED_ROLE_IDS = [
  'software_architect',
  'code_reviewer',
  'doc_synthesizer'
];

class RoleManager {
  constructor() {
    this.rolesDir = path.resolve(__dirname, '../roles');
    this.metaSchemaPath = path.join(this.rolesDir, 'role_meta_schema.json');
    this.ajv = new Ajv({ allErrors: true, strict: false });
    this.rolesCache = new Map();

    this._initialize();
  }

  /**
   * 初始化：載入 Meta-Schema 與驗證所有註冊角色
   */
  _initialize() {
    if (!fs.existsSync(this.metaSchemaPath)) {
      throw new Error(`[RoleManager] Meta-schema not found at ${this.metaSchemaPath}`);
    }

    const metaSchemaContent = JSON.parse(fs.readFileSync(this.metaSchemaPath, 'utf8'));
    this.validateMetaSchema = this.ajv.compile(metaSchemaContent);

    for (const roleId of REGISTERED_ROLE_IDS) {
      this._loadAndValidateRole(roleId);
    }
  }

  /**
   * 白名單載入單一角色並執行雙層編譯校驗
   */
  _loadAndValidateRole(roleId) {
    if (!REGISTERED_ROLE_IDS.includes(roleId)) {
      throw new Error(`[RoleManager] Unauthorized or unregistered role ID: "${roleId}"`);
    }

    const roleFilePath = path.join(this.rolesDir, `${roleId}.json`);
    if (!fs.existsSync(roleFilePath)) {
      throw new Error(`[RoleManager] Role definition file missing: ${roleFilePath}`);
    }

    let roleData;
    try {
      roleData = JSON.parse(fs.readFileSync(roleFilePath, 'utf8'));
    } catch (err) {
      throw new Error(`[RoleManager] Failed to parse JSON for role "${roleId}": ${err.message}`);
    }

    // 1. 檔名與 ID 一致性防呆
    if (roleData.id !== roleId) {
      throw new Error(`[RoleManager] Role ID mismatch in file: expected "${roleId}", got "${roleData.id}"`);
    }

    // 2. 禁用外部 $ref 與未定義 URI 載入能力 (防範 SSRF / 本機檔案參照漏洞)
    const jsonStr = JSON.stringify(roleData);
    if (jsonStr.includes('"$ref"') || jsonStr.includes("'$ref'")) {
      throw new Error(`[RoleManager] Security Violation: External or relative $ref is strictly prohibited in role schema (${roleId})`);
    }

    // 3. 第一層校驗：Meta-Schema 驗證
    const isValidMeta = this.validateMetaSchema(roleData);
    if (!isValidMeta) {
      const errorDetails = JSON.stringify(this.validateMetaSchema.errors);
      throw new Error(`[RoleManager] Meta-schema validation failed for role "${roleId}": ${errorDetails}`);
    }

    // 4. 第二層校驗：Role Output Schema 必須能成功編譯為合法 Draft-07 JSON Schema
    try {
      this.ajv.compile(roleData.schema);
    } catch (compileErr) {
      throw new Error(`[RoleManager] Role output schema compilation failed for "${roleId}": ${compileErr.message}`);
    }

    this.rolesCache.set(roleId, Object.freeze(roleData));
  }

  /**
   * 列出所有可用角色之精簡公開資訊（深層獨立物件）
   */
  listRoles() {
    const list = [];
    for (const [id, role] of this.rolesCache.entries()) {
      list.push({
        id,
        name: role.name,
        description: role.description,
        recommendedTier: role.recommendedTier
      });
    }
    return structuredClone(list);
  }

  /**
   * 根據白名單 roleId 取得角色完整定義（完全參照隔離）
   */
  getRole(roleId) {
    if (typeof roleId !== 'string' || !this.rolesCache.has(roleId)) {
      throw new Error(`[RoleManager] Role not found: "${roleId}"`);
    }
    return structuredClone(this.rolesCache.get(roleId));
  }

  /**
   * 安全資料轉換器：將使用者輸入與角色定義合成為 dispatchTask 所需參數
   * @param {string} roleId - 白名單中的角色識別代號
   * @param {Object} userInput - 使用者傳入的任務參數
   * @returns {Object} { taskPayload, outputSchema, tier }
   */
  buildTask(roleId, userInput) {
    if (typeof roleId !== 'string' || !roleId.trim() || !this.rolesCache.has(roleId)) {
      throw new Error(`ROLE_NOT_FOUND: Unrecognized role ID: "${roleId}"`);
    }

    if (!userInput || typeof userInput !== 'object' || Array.isArray(userInput)) {
      throw new Error('INVALID_PARAMETER: userInput must be a valid non-null object');
    }

    // 規則 1：選擇角色後，若存在 schema 欄位（無論值為何），一律拒絕
    if (Object.hasOwn(userInput, 'schema')) {
      throw new Error('INVALID_PARAMETER: Custom schema cannot be provided when a role is selected.');
    }

    // 規則 2：objective 必須為非空字串
    if (!Object.hasOwn(userInput, 'objective') || typeof userInput.objective !== 'string' || !userInput.objective.trim()) {
      throw new Error('INVALID_PARAMETER: Missing or invalid "objective" in userInput.');
    }

    const role = this.rolesCache.get(roleId);

    // 規則 3：Tier 覆寫驗證
    let resolvedTier = role.recommendedTier;
    if (Object.hasOwn(userInput, 'tier')) {
      const explicitTier = userInput.tier;
      if (typeof explicitTier !== 'string' || !VALID_TIERS.includes(explicitTier)) {
        throw new Error(`INVALID_PARAMETER: Invalid tier "${explicitTier}". Supported: ${VALID_TIERS.join(', ')}`);
      }
      resolvedTier = explicitTier;
    }

    // 規則 4：constraints 格式驗證與追加合成 (不可覆蓋角色規範)
    let userConstraints = [];
    if (Object.hasOwn(userInput, 'constraints')) {
      if (!Array.isArray(userInput.constraints)) {
        throw new Error('INVALID_PARAMETER: "constraints" must be an array of strings.');
      }
      for (const c of userInput.constraints) {
        if (typeof c !== 'string' || !c.trim() || c.length > 500) {
          throw new Error('INVALID_PARAMETER: Each constraint must be a non-empty string under 500 characters.');
        }
      }
      userConstraints = userInput.constraints.map(s => s.trim());
    }

    // 規則 5：tags 格式驗證與追加合成
    let userTags = [];
    if (Object.hasOwn(userInput, 'tags')) {
      if (!Array.isArray(userInput.tags)) {
        throw new Error('INVALID_PARAMETER: "tags" must be an array of strings.');
      }
      for (const t of userInput.tags) {
        if (typeof t !== 'string' || !t.trim() || t.length > 32) {
          throw new Error('INVALID_PARAMETER: Each tag must be a non-empty string under 32 characters.');
        }
      }
      userTags = userInput.tags.map(s => s.trim());
    }

    // 合成 taskPayload
    const mergedConstraints = [...role.role_constraints, ...userConstraints];
    const mergedTags = Array.from(new Set([...(role.default_tags || []), ...userTags]));

    const taskPayload = {
      objective: userInput.objective.trim(),
      constraints: mergedConstraints,
      tags: mergedTags
    };

    if (Object.hasOwn(userInput, 'code_context') && typeof userInput.code_context === 'string') {
      taskPayload.code_context = userInput.code_context;
    }

    // 完全參照隔離輸出
    return {
      taskPayload: structuredClone(taskPayload),
      outputSchema: structuredClone(role.schema),
      tier: resolvedTier
    };
  }
}

// 導出單例
module.exports = new RoleManager();

