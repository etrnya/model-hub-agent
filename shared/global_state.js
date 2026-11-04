/**
 * GlobalState
 * Implements Optimistic Concurrency Control (OCC) for distributed agent tasks.
 * Ensures state consistency across multiple model calls with full reference isolation,
 * language-level private field encapsulation (#data), root reserved fields protection,
 * and pure structured data validation.
 */

const ROOT_RESERVED_FIELDS = new Set(['version', 'change_log']);
const GLOBAL_FORBIDDEN_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Validates that an input complies with the Pure Structured Data contract:
 * - Allowed types: string, finite number, boolean, null, plain object, clean array.
 * - Explicitly rejected: Function, Symbol, BigInt, undefined, NaN, Infinity, Date, RegExp, Map, Set, Custom Class.
 * - Explicitly rejected: Prototype pollution keys (__proto__, prototype, constructor) at all levels.
 * - Root-reserved fields (version, change_log) rejected at root level unless allowRootReserved is true.
 * - Nested version / change_log are allowed as business metadata.
 * - Explicitly rejected: Accessors (Getters / Setters).
 * - Explicitly rejected: Array non-index named properties, array Symbol properties.
 * - Cycle detection: DFS visiting/visited sets accurately distinguishing true circular references from DAG shared references.
 * 
 * @param {*} data 
 * @param {{ allowRootReserved?: boolean, isRoot?: boolean, visiting?: WeakSet, visited?: WeakSet }} options 
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateStateData(data, options = {}) {
  const {
    allowRootReserved = false,
    isRoot = false,
    visiting = new WeakSet(),
    visited = new WeakSet()
  } = options;

  // 1. Null is allowed
  if (data === null) {
    return { valid: true };
  }

  // 2. Reject undefined (Pure Structured Data does not accept undefined)
  if (data === undefined) {
    return { valid: false, reason: 'undefined is not allowed in GlobalState' };
  }

  const type = typeof data;

  // 3. Reject non-JSON primitive types
  if (type === 'function') {
    return { valid: false, reason: 'Functions are not allowed in GlobalState' };
  }
  if (type === 'symbol') {
    return { valid: false, reason: 'Symbols are not allowed in GlobalState' };
  }
  if (type === 'bigint') {
    return { valid: false, reason: 'BigInt is not allowed in GlobalState' };
  }

  // 4. Primitive types
  if (type === 'string' || type === 'boolean') {
    return { valid: true };
  }

  if (type === 'number') {
    if (!Number.isFinite(data)) {
      return { valid: false, reason: 'NaN and Infinity are not allowed in GlobalState' };
    }
    return { valid: true };
  }

  // 5. Must be object (plain object or array)
  if (type !== 'object') {
    return { valid: false, reason: `Unsupported data type "${type}"` };
  }

  // Cycle & Shared Reference handling via DFS
  // If node is currently on the active recursion stack -> TRUE CYCLE
  if (visiting.has(data)) {
    return { valid: false, reason: 'Circular reference detected' };
  }
  // If node has already been completely verified and is cycle-free -> SHARED REFERENCE (DAG), SAFE
  if (visited.has(data)) {
    return { valid: true };
  }

  visiting.add(data);

  // 6. Handle Array
  if (Array.isArray(data)) {
    // Check for Symbol properties on array
    if (Object.getOwnPropertySymbols(data).length > 0) {
      visiting.delete(data);
      return { valid: false, reason: 'Symbol properties on arrays are not allowed in GlobalState' };
    }

    // Inspect all own property names on the array
    const propNames = Object.getOwnPropertyNames(data);
    for (const key of propNames) {
      if (GLOBAL_FORBIDDEN_FIELDS.has(key)) {
        visiting.delete(data);
        return { valid: false, reason: `Prototype pollution field "${key}" is strictly forbidden on arrays` };
      }

      if (key === 'length') {
        continue;
      }

      // Check if key is a valid non-negative integer index within bounds
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= data.length) {
        visiting.delete(data);
        return { valid: false, reason: `Custom property "${key}" is not allowed on arrays` };
      }

      // Check descriptor for getter / setter and enumerable
      const desc = Object.getOwnPropertyDescriptor(data, key);
      if (desc && (desc.get || desc.set)) {
        visiting.delete(data);
        return { valid: false, reason: 'Getters and setters are not allowed on arrays' };
      }
      if (desc && !desc.enumerable) {
        visiting.delete(data);
        return { valid: false, reason: `Non-enumerable index property "${key}" is not allowed on arrays` };
      }

      const itemValidation = validateStateData(desc.value, {
        allowRootReserved: false,
        isRoot: false,
        visiting,
        visited
      });
      if (!itemValidation.valid) {
        visiting.delete(data);
        return itemValidation;
      }
    }

    visiting.delete(data);
    visited.add(data);
    return { valid: true };
  }

  // 7. Plain Object verification
  const proto = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) {
    visiting.delete(data);
    return { valid: false, reason: 'Custom class instances or prototype mutations are not allowed' };
  }

  // Reject Symbol keys
  if (Object.getOwnPropertySymbols(data).length > 0) {
    visiting.delete(data);
    return { valid: false, reason: 'Symbol properties are not allowed in GlobalState' };
  }

  // Inspect own property names
  const propNames = Object.getOwnPropertyNames(data);
  for (const key of propNames) {
    if (GLOBAL_FORBIDDEN_FIELDS.has(key)) {
      visiting.delete(data);
      return { valid: false, reason: `Prototype pollution field "${key}" is strictly forbidden` };
    }

    if (isRoot && !allowRootReserved && ROOT_RESERVED_FIELDS.has(key)) {
      visiting.delete(data);
      return { valid: false, reason: `Reserved field "${key}" is prohibited in state updates` };
    }

    // Check descriptor for getter / setter and enumerable BEFORE reading value
    const desc = Object.getOwnPropertyDescriptor(data, key);
    if (desc && (desc.get || desc.set)) {
      visiting.delete(data);
      return { valid: false, reason: `Getter/Setter accessors are not allowed on property "${key}"` };
    }
    if (desc && !desc.enumerable) {
      visiting.delete(data);
      return { valid: false, reason: `Non-enumerable property "${key}" is not allowed in GlobalState` };
    }

    const valValidation = validateStateData(desc.value, {
      allowRootReserved: false,
      isRoot: false,
      visiting,
      visited
    });
    if (!valValidation.valid) {
      visiting.delete(data);
      return valValidation;
    }
  }

  visiting.delete(data);
  visited.add(data);
  return { valid: true };
}

/**
 * Deep clones data via native structuredClone.
 * Requires Node.js 18+. Removes inconsistent JSON fallback.
 */
function deepClone(obj) {
  if (obj === undefined || obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (typeof structuredClone !== 'function') {
    throw new Error('[GlobalState] Runtime environment missing native structuredClone API. Node.js 18+ required.');
  }
  return structuredClone(obj);
}

class GlobalState {
  // JavaScript 原生私有欄位：外部無法直接讀寫或繞過 OCC 修改內部狀態
  #data;

  constructor(...args) {
    let initialData;
    if (args.length === 0) {
      initialData = {};
    } else {
      const firstArg = args[0];
      if (firstArg === null || firstArg === undefined || typeof firstArg !== 'object' || Array.isArray(firstArg)) {
        throw new TypeError('[GlobalState] initialData must be a non-null plain object');
      }
      initialData = firstArg;
    }

    // Validate initialData (allow root reserved fields because we will strip/reset them)
    const validation = validateStateData(initialData, { allowRootReserved: true, isRoot: true });
    if (!validation.valid) {
      throw new TypeError(`[GlobalState] Invalid initialData: ${validation.reason}`);
    }

    // Sanitize initialData: strip root reserved fields
    const sanitized = {};
    for (const key of Object.getOwnPropertyNames(initialData)) {
      if (!ROOT_RESERVED_FIELDS.has(key)) {
        const desc = Object.getOwnPropertyDescriptor(initialData, key);
        sanitized[key] = desc.value;
      }
    }

    const cloned = deepClone(sanitized);
    this.#data = {
      ...cloned,
      version: 1,
      change_log: []
    };
  }

  /**
   * 唯讀 version getter：提供低開銷讀取當前版本號，不暴露內部物件參照
   */
  get version() {
    return this.#data.version;
  }

  /**
   * Updates the state with OCC version checking and root reserved fields protection.
   * @param {Object} newData 
   * @param {number} expectedVersion 
   * @returns {boolean} Success
   */
  update(newData, expectedVersion) {
    // 1. OCC 版本檢查
    if (this.#data.version !== expectedVersion) {
      console.error(`[GlobalState] Version mismatch! Current: ${this.#data.version}, Expected: ${expectedVersion}`);
      return false;
    }

    // 2. 檢查更新資料結構型別
    if (!newData || typeof newData !== 'object' || Array.isArray(newData)) {
      console.error('[GlobalState] Rejected update: update payload must be a non-null object');
      return false;
    }

    // 3. 嚴格資料契約與根保留欄位校驗 (Pure Structured Data)
    const validation = validateStateData(newData, { allowRootReserved: false, isRoot: true });
    if (!validation.valid) {
      console.error(`[GlobalState] Rejected update: ${validation.reason}`);
      return false;
    }

    // 4. 深拷貝輸入資料以防參照外洩
    const clonedUpdates = deepClone(newData);

    // 5. 套用業務更新
    Object.assign(this.#data, clonedUpdates);
    
    // 6. 版本單調遞增
    this.#data.version += 1;
    
    // 7. 記錄變更日誌
    this.#data.change_log.push({
      timestamp: Date.now(),
      version: this.#data.version,
      changedFields: Object.keys(clonedUpdates)
    });

    return true;
  }

  /**
   * Returns a snapshot of the current state.
   */
  getSnapshot() {
    return deepClone(this.#data);
  }

  /**
   * Merges state (Fallback strategy for conflicts)
   * Validates remoteData FIRST before any property reading to guarantee zero Getter execution.
   * Sanitizes remote data by stripping root reserved fields to protect local version and change_log continuity.
   * @param {Object} remoteData 
   */
  merge(remoteData) {
    console.warn("[GlobalState] Manual merge triggered due to conflict.");
    if (!remoteData || typeof remoteData !== 'object' || Array.isArray(remoteData)) {
      console.error("[GlobalState] Merge payload must be a non-null object");
      return;
    }

    // 1. Validate remoteData FIRST before any property reading!
    // Root version / change_log are allowed on remoteData because they will be stripped below.
    // However, any Getters/Setters, Functions, Symbols, etc. will fail here with zero Getter invocation.
    const validation = validateStateData(remoteData, { allowRootReserved: true, isRoot: true });
    if (!validation.valid) {
      console.error(`[GlobalState] Rejected merge: ${validation.reason}`);
      return; // Atomic: zero state mutations
    }

    // 2. Extract non-root-reserved fields using descriptors (100% safe from getter side-effects)
    const sanitizedRemote = {};
    for (const key of Object.getOwnPropertyNames(remoteData)) {
      if (!ROOT_RESERVED_FIELDS.has(key)) {
        const desc = Object.getOwnPropertyDescriptor(remoteData, key);
        sanitizedRemote[key] = desc.value;
      }
    }

    const clonedRemote = deepClone(sanitizedRemote);

    // 3. Remote wins for business data
    Object.assign(this.#data, clonedRemote);

    // 4. Local version increments strictly by +1
    this.#data.version += 1;

    // 5. Append merge resolution record to local change_log
    this.#data.change_log.push({
      timestamp: Date.now(),
      version: this.#data.version,
      note: "Merged conflict resolution"
    });
  }
}

module.exports = GlobalState;
