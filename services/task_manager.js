const crypto = require('crypto');
const globalEmitter = require('../shared/global_emitter');
const roleManager = require('./role_manager');
const { dispatchTask } = require('../main');

/**
 * TaskManager
 * 受限非同步任務管理器 (Bounded In-Memory Asynchronous Task Manager)
 * 
 * 核心原則：
 * 1. 集中容量管理：MAX_CONCURRENT=2, MAX_QUEUE=10, MAX_STORE=50。
 * 2. 嚴格終態淘汰：僅淘汰 COMPLETED / FAILED，絕不淘汰 QUEUED 或 RUNNING。
 * 3. 底層名額守護：dispatchTask 的 Promise 真正 settle 前絕不釋放 activeCount。
 * 4. 錯誤脫敏白名單：依結構化錯誤精確分類，未知錯誤歸為 TASK_EXECUTION_FAILED，絕不外洩敏感資訊。
 * 5. Guardrail 結果保護：回傳 undefined 嚴格判定為 FAILED (TASK_EXECUTION_REJECTED, 403)。
 */

const MAX_CONCURRENT_TASKS = 2;
const MAX_QUEUE_CAPACITY = 10;
const MAX_STORE_CAPACITY = 50;

class TaskManager {
  constructor(options = {}) {
    this.tasks = new Map(); // key: taskId, value: TaskRecord
    this.queue = [];        // FIFO array of taskIds
    this.activeCount = 0;
    this.eventSequence = 0;
    
    // 可注入 dispatchTask 實作，方便測試進行 Deferred Promise 驗證
    this.dispatchFn = options.dispatchFn || dispatchTask;

    this.MAX_CONCURRENT_TASKS = options.maxConcurrent || MAX_CONCURRENT_TASKS;
    this.MAX_QUEUE_CAPACITY = options.maxQueue || MAX_QUEUE_CAPACITY;
    this.MAX_STORE_CAPACITY = options.maxStore || MAX_STORE_CAPACITY;
  }

  /**
   * 提交新任務並進行原子容量審查與角色合成
   * @param {Object} userInput - 使用者輸入參數
   * @returns {Object} { taskId, status: 'QUEUED', createdAt }
   */
  submitTask(userInput) {
    if (!userInput || typeof userInput !== 'object' || Array.isArray(userInput)) {
      const err = new Error("INVALID_PARAMETER: Request body must be a valid JSON object.");
      err.statusCode = 400;
      throw err;
    }

    let taskPayload;
    let outputSchema;
    let tier;
    let selectedRoleId = null;

    // 1. 角色模式與無角色模式分流解析
    if (Object.hasOwn(userInput, 'role')) {
      const roleId = userInput.role;
      if (!roleId || typeof roleId !== 'string') {
        const err = new Error("INVALID_PARAMETER: 'role' must be a non-empty string.");
        err.statusCode = 400;
        throw err;
      }
      if (Object.hasOwn(userInput, 'schema')) {
        const err = new Error("INVALID_PARAMETER: Custom schema cannot be provided when a role is selected.");
        err.statusCode = 400;
        throw err;
      }

      try {
        const built = roleManager.buildTask(roleId, userInput);
        taskPayload = built.taskPayload;
        outputSchema = built.outputSchema;
        tier = built.tier;
        selectedRoleId = roleId;
      } catch (roleErr) {
        roleErr.statusCode = 400;
        throw roleErr;
      }
    } else {
      // 無角色舊模式
      if (!Object.hasOwn(userInput, 'objective') || typeof userInput.objective !== 'string' || !userInput.objective.trim()) {
        const err = new Error("INVALID_PARAMETER: Missing required 'objective' field.");
        err.statusCode = 400;
        throw err;
      }

      if (Object.hasOwn(userInput, 'tier')) {
        const validTiers = ['ultra', 'high', 'medium', 'base'];
        if (!validTiers.includes(userInput.tier)) {
          const err = new Error(`INVALID_PARAMETER: Invalid tier "${userInput.tier}". Supported: ${validTiers.join(', ')}`);
          err.statusCode = 400;
          throw err;
        }
      }

      taskPayload = {
        objective: userInput.objective.trim(),
        constraints: Array.isArray(userInput.constraints) ? userInput.constraints : [],
        tags: Array.isArray(userInput.tags) ? userInput.tags : ["async_task"]
      };

      if (Object.hasOwn(userInput, 'code_context') && typeof userInput.code_context === 'string') {
        taskPayload.code_context = userInput.code_context;
      }

      // P1-C4: 無角色模式下結構化 CodeGraph 與隔離參數透傳
      if (Object.hasOwn(userInput, 'action') && typeof userInput.action === 'string') {
        taskPayload.action = userInput.action;
      }
      if (Object.hasOwn(userInput, 'targetFiles') && Array.isArray(userInput.targetFiles)) {
        taskPayload.targetFiles = userInput.targetFiles;
      }
      if (Object.hasOwn(userInput, 'targetSymbols') && Array.isArray(userInput.targetSymbols)) {
        taskPayload.targetSymbols = userInput.targetSymbols;
      }
      if (Object.hasOwn(userInput, 'tenantId') && typeof userInput.tenantId === 'string') {
        taskPayload.tenantId = userInput.tenantId;
      }
      if (Object.hasOwn(userInput, 'taskType') && typeof userInput.taskType === 'string') {
        taskPayload.taskType = userInput.taskType;
      }
      if (Object.hasOwn(userInput, 'maxExecutionTokens') && Number.isSafeInteger(userInput.maxExecutionTokens) && userInput.maxExecutionTokens > 0) {
        taskPayload.maxExecutionTokens = userInput.maxExecutionTokens;
      }
      if (Object.hasOwn(userInput, 'evidenceNodes') && Array.isArray(userInput.evidenceNodes)) {
        taskPayload.evidenceNodes = userInput.evidenceNodes;
      }

      outputSchema = userInput.schema || {
        type: "object",
        properties: {
          analysis: { type: "string" },
          result: { type: "string" },
          recommendations: { type: "array", items: { type: "string" } }
        },
        required: ["analysis", "result"]
      };

      tier = userInput.tier || 'high';
    }

    // 2. 先消耗排隊名額，再檢查容量（避免有空閒執行名額時誤拒絕）
    this._pumpQueue();

    // 3. 檢查排隊上限
    if (this.queue.length >= this.MAX_QUEUE_CAPACITY) {
      const err = new Error("TASK_QUEUE_FULL: Asynchronous task queue is full (max 10). Please try again later.");
      err.type = 'TASK_QUEUE_FULL';
      err.statusCode = 429;
      throw err;
    }

    // 4. 檢查 Store 總容量並執行終態專屬淘汰
    if (this.tasks.size >= this.MAX_STORE_CAPACITY) {
      let oldestTerminalId = null;
      let oldestTime = Infinity;

      for (const [id, t] of this.tasks.entries()) {
        if (t.status === 'COMPLETED' || t.status === 'FAILED') {
          if (t.createdAt < oldestTime) {
            oldestTime = t.createdAt;
            oldestTerminalId = id;
          }
        }
      }

      if (oldestTerminalId) {
        this.tasks.delete(oldestTerminalId);
      } else {
        // 50 筆全為在途任務 (極端飽和防護)
        const err = new Error("TASK_STORE_EXHAUSTED: In-flight task capacity exhausted. Please wait for running tasks to complete.");
        err.type = 'TASK_STORE_EXHAUSTED';
        err.statusCode = 503;
        throw err;
      }
    }

    // 5. 生成密碼學安全 Task ID
    const taskId = `task_${crypto.randomUUID()}`;
    const createdAt = Date.now();
    if (!Object.hasOwn(taskPayload, 'taskId')) {
      taskPayload.taskId = taskId;
    }

    const taskRecord = {
      taskId,
      status: 'QUEUED',
      createdAt,
      startTime: null,
      durationMs: null,
      role: selectedRoleId,
      objective: taskPayload.objective,
      taskPayload,
      outputSchema,
      tier,
      data: null,
      error: null
    };

    this.tasks.set(taskId, taskRecord);
    this.queue.push(taskId);

    // 廣播 TASK_QUEUED 生命週期事件
    this._emitLifecycle(taskRecord, 'TASK_QUEUED');

    // 異步排程背景啟動（不阻塞呼叫者）
    setImmediate(() => {
      this._pumpQueue();
    });

    return {
      taskId,
      status: 'QUEUED',
      createdAt
    };
  }

  /**
   * 佇列推動排程器 (Queue Pump)
   */
  _pumpQueue() {
    while (this.activeCount < this.MAX_CONCURRENT_TASKS && this.queue.length > 0) {
      const nextTaskId = this.queue.shift();
      const task = this.tasks.get(nextTaskId);

      if (task && task.status === 'QUEUED') {
        this.activeCount++;
        task.status = 'RUNNING';
        task.startTime = performance.now();

        this._emitLifecycle(task, 'TASK_STARTED');
        this._executeTask(task);
      }
    }
  }

  /**
   * 背景執行任務並確保底層 Promise settle 前不釋放名額
   */
  async _executeTask(task) {
    try {
      const result = await this.dispatchFn(task.taskPayload, task.outputSchema, task.tier);

      if (result === undefined || result === null) {
        // Guardrail 安全攔截路徑
        task.status = 'FAILED';
        task.error = {
          type: 'TASK_EXECUTION_REJECTED',
          message: '任務因觸發系統安全政策或提示詞護欄遭拒絕執行。',
          statusCode: 403
        };
        this._emitLifecycle(task, 'TASK_FAILED');
      } else if (typeof result !== 'object') {
        task.status = 'FAILED';
        task.error = {
          type: 'TASK_EXECUTION_INVALID_RESULT',
          message: '模型產出資料無法通過架構契約驗證。',
          statusCode: 500
        };
        this._emitLifecycle(task, 'TASK_FAILED');
      } else {
        task.status = 'COMPLETED';
        task.data = result;
        this._emitLifecycle(task, 'TASK_COMPLETED');
      }
    } catch (err) {
      task.status = 'FAILED';
      
      // 結構化上游錯誤判定
      const isUpstream = (
        err.faultScope === 'PROVIDER' ||
        err.type === 'HUB_PROVIDER_SERVER_ERROR' ||
        err.type === 'HUB_RATE_LIMIT' ||
        err.type === 'HUB_TIMEOUT_ERROR'
      );

      if (isUpstream) {
        task.error = {
          type: 'TASK_UPSTREAM_FAILED',
          message: '上游 AI 模型供應商服務暫時不可用或配額耗盡。',
          statusCode: 502
        };
      } else {
        task.error = {
          type: 'TASK_EXECUTION_FAILED',
          message: '任務執行過程中發生內部錯誤。',
          statusCode: 500
        };
      }

      this._emitLifecycle(task, 'TASK_FAILED');
    } finally {
      if (task.startTime) {
        task.durationMs = Math.round(performance.now() - task.startTime);
      }
      // 只有在底層 Promise 真正 settle 後，名額才遞減並觸發下一個任務
      this.activeCount--;
      this._pumpQueue();
    }
  }

  /**
   * 廣播安全生命週期事件
   */
  _emitLifecycle(task, eventType) {
    this.eventSequence++;
    const eventPayload = {
      eventId: this.eventSequence,
      taskId: task.taskId,
      type: eventType,
      status: task.status,
      timestamp: Date.now()
    };

    if (task.error) {
      eventPayload.error = task.error;
    }

    globalEmitter.emit('task-lifecycle', eventPayload);
  }

  /**
   * 查詢單一任務詳情 (完全參照隔離)
   */
  getTask(taskId) {
    if (typeof taskId !== 'string' || !this.tasks.has(taskId)) {
      return null;
    }

    const t = this.tasks.get(taskId);
    return structuredClone({
      taskId: t.taskId,
      status: t.status,
      role: t.role,
      objective: t.objective,
      createdAt: t.createdAt,
      durationMs: t.durationMs,
      data: t.data,
      error: t.error
    });
  }

  /**
   * 查詢最近任務清冊歷史 (精簡陣列，由新至舊排序)
   */
  listTasks() {
    const list = [];
    for (const t of this.tasks.values()) {
      list.push({
        taskId: t.taskId,
        status: t.status,
        role: t.role,
        objective: t.objective,
        createdAt: t.createdAt,
        durationMs: t.durationMs
      });
    }

    list.sort((a, b) => b.createdAt - a.createdAt);
    return structuredClone(list);
  }

  /**
   * 重置內部儲存 (供測試獨立隔離使用)
   */
  clearStore() {
    this.tasks.clear();
    this.queue = [];
    this.activeCount = 0;
  }
}

// 導出單例與類別
const defaultTaskManager = new TaskManager();
defaultTaskManager.TaskManager = TaskManager;
module.exports = defaultTaskManager;

