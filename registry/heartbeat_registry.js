/**
 * HeartbeatRegistry with Three-State Health State Machine (CLOSED / OPEN / HALF-OPEN)
 * 
 * Provides:
 * 1. Granular fault isolation across Model, Provider, Credential, and Account scopes.
 * 2. Standard Circuit Breaker three-state machine (CLOSED, OPEN, HALF-OPEN).
 * 3. Atomic Canary Probe admission control with unique generational token verification.
 * 4. Dual Watchdog protection (Active Timer + Passive Deadline check).
 * 5. Strict notBefore retention for upstream Retry-After headers without silent truncation.
 * 6. Separation of concerns: isHealthy() for status query vs canPass() for admission control.
 * 7. 100% backward compatibility for existing callers.
 */

const crypto = require('crypto');

class CircuitBreakerNode {
  constructor(key, options = {}) {
    this.key = key; // e.g. 'google', 'google:gemini-1.5-pro', 'google:cred:xyz'
    this.state = 'CLOSED'; // 'CLOSED' | 'OPEN' | 'HALF-OPEN'
    this.permanent = false;
    this.openReason = null;
    this.consecutiveFailures = 0;
    this.failureThreshold = options.failureThreshold || 3;

    this.initialCooldownMs = options.initialCooldownMs || 30000; // 30s
    this.maxCooldownMs = options.maxCooldownMs || 300000; // 5 mins
    this.currentCooldownMs = this.initialCooldownMs;
    this.notBefore = 0; // Absolute timestamp (ms)

    // Canary Probe Control
    this.generation = 0;
    this.activeGeneration = null;
    this.probeActive = false;
    this.probeToken = null;
    this.probeStartedAt = 0;
    this.probeTimeoutMs = options.probeTimeoutMs || 15000; // 15s
    this.probeDeadline = 0;
    this._timerHandle = null;

    // Time & Timer injection
    this.nowFn = options.nowFn || (() => Date.now());
    this.timerFn = options.timerFn || { setTimeout, clearTimeout };
  }

  _now() {
    return this.nowFn();
  }

  _clearActiveTimer() {
    if (this._timerHandle && this.timerFn.clearTimeout) {
      this.timerFn.clearTimeout(this._timerHandle);
      this._timerHandle = null;
    }
  }

  _checkPassiveDeadline(now) {
    if (this.state === 'HALF-OPEN' && this.probeActive && this.probeDeadline > 0 && now >= this.probeDeadline) {
      this._tripToOpen(now, { isExponential: true, reason: 'WATCHDOG_DEADLINE_EXPIRED' });
      return true;
    }
    return false;
  }

  _tripToOpen(now, { isExponential = false, explicitCooldownMs = null, notBefore = null, permanent = false, reason = null } = {}) {
    this.state = 'OPEN';
    this.probeActive = false;
    this.probeToken = null;
    this.probeDeadline = 0;
    this.activeGeneration = null;
    this._clearActiveTimer();

    if (permanent) {
      this.permanent = true;
      this.openReason = reason || 'PERMANENT_FAULT';
      this.notBefore = Infinity;
      return;
    }

    this.permanent = false;
    this.openReason = reason || 'CIRCUIT_TRIPPED';

    if (notBefore !== null && notBefore !== undefined && notBefore > now) {
      // Retain exact upstream notBefore without silent truncation
      this.notBefore = notBefore;
      this.currentCooldownMs = notBefore - now;
    } else if (explicitCooldownMs !== null && explicitCooldownMs > 0) {
      // Explicit cooldown (e.g. from Retry-After header)
      this.currentCooldownMs = explicitCooldownMs;
      this.notBefore = now + explicitCooldownMs;
    } else if (isExponential) {
      this.currentCooldownMs = Math.min(this.currentCooldownMs * 2, this.maxCooldownMs);
      this.notBefore = now + this.currentCooldownMs;
    } else {
      this.currentCooldownMs = this.initialCooldownMs;
      this.notBefore = now + this.currentCooldownMs;
    }
  }

  canPass(customNow = null) {
    const now = customNow !== null && customNow !== undefined ? customNow : this._now();
    this._checkPassiveDeadline(now);

    // 1. CLOSED
    if (this.state === 'CLOSED') {
      return { allowed: true, isCanary: false };
    }

    // 2. OPEN
    if (this.state === 'OPEN') {
      if (this.permanent) {
        return { allowed: false, reason: 'PERMANENT_OPEN', openReason: this.openReason };
      }
      if (now < this.notBefore) {
        return { allowed: false, reason: 'CIRCUIT_OPEN', retryAfterMs: this.notBefore - now };
      }
      // Cooldown expired, transition to HALF-OPEN
      this.state = 'HALF-OPEN';
      this.probeActive = false;
      this.probeToken = null;
      this.probeDeadline = 0;
      this.activeGeneration = null;
    }

    // 3. HALF-OPEN: Atomic token admission with generation tracking
    if (this.state === 'HALF-OPEN') {
      if (this.probeActive) {
        return { allowed: false, reason: 'CANARY_PROBE_IN_FLIGHT' };
      }

      // Increment generation and grant unique canary token
      this.generation++;
      this.activeGeneration = this.generation;
      this.probeActive = true;
      const nonce = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(6).toString('hex');
      this.probeToken = `probe_gen${this.generation}_${now}_${nonce}`;
      this.probeStartedAt = now;
      this.probeDeadline = now + this.probeTimeoutMs;

      // Active Watchdog Timer
      if (this.timerFn.setTimeout) {
        this._clearActiveTimer();
        this._timerHandle = this.timerFn.setTimeout(() => {
          if (this.state === 'HALF-OPEN' && this.probeActive) {
            this._tripToOpen(this._now(), { isExponential: true, reason: 'WATCHDOG_TIMER_EXPIRED' });
          }
        }, this.probeTimeoutMs);
      }

      return { allowed: true, isCanary: true, token: this.probeToken };
    }

    return { allowed: false, reason: 'UNKNOWN_STATE' };
  }

  isHealthy(customNow = null) {
    const now = customNow !== null && customNow !== undefined ? customNow : this._now();
    this._checkPassiveDeadline(now);

    if (this.state === 'CLOSED') return true;
    if (this.state === 'HALF-OPEN') return false; // Traffic not generally admitted
    if (this.permanent) return false;
    return now >= this.notBefore ? false : false;
  }

  getStatus(customNow = null) {
    const now = customNow !== null && customNow !== undefined ? customNow : this._now();
    this._checkPassiveDeadline(now);

    if (this.permanent) return 'degraded';
    if (this.state === 'OPEN') {
      if (now < this.notBefore) return 'degraded';
      return 'probing';
    }
    if (this.state === 'HALF-OPEN') return 'probing';
    return 'healthy';
  }

  recordSuccess({ token = null, now = null } = {}) {
    const currentNow = now !== null && now !== undefined ? now : this._now();
    this._checkPassiveDeadline(currentNow);

    if (this.state === 'HALF-OPEN') {
      // Reject stale probe token or generation mismatch
      if (!token || token !== this.probeToken || this.activeGeneration !== this.generation) {
        console.warn(`[CircuitBreakerNode] ⚠️ Stale or invalid canary probe token rejected for ${this.key}: ${token} (active gen: ${this.activeGeneration}, current gen: ${this.generation})`);
        return false;
      }
      this.state = 'CLOSED';
      this.consecutiveFailures = 0;
      this.currentCooldownMs = this.initialCooldownMs;
      this.probeActive = false;
      this.probeToken = null;
      this.probeDeadline = 0;
      this.activeGeneration = null;
      this._clearActiveTimer();
      return true;
    }

    if (this.state === 'CLOSED') {
      this.consecutiveFailures = 0;
      return true;
    }

    // If state is OPEN, any probe reporting success is expired/stale!
    return false;
  }

  recordFailure({ token = null, now = null, faultScope = 'MODEL', permanent = false, reason = null, explicitCooldownMs = null, notBefore = null } = {}) {
    if (faultScope === 'NONE') return false;

    const currentNow = now !== null && now !== undefined ? now : this._now();
    this._checkPassiveDeadline(currentNow);

    if (this.state === 'HALF-OPEN') {
      // Reject stale probe token or generation mismatch
      if (!token || token !== this.probeToken || this.activeGeneration !== this.generation) {
        console.warn(`[CircuitBreakerNode] ⚠️ Stale or invalid canary probe token rejected on failure for ${this.key}: ${token}`);
        return false;
      }
      this.activeGeneration = null;
      this._tripToOpen(currentNow, { isExponential: true, reason: reason || 'CANARY_PROBE_FAILED' });
      return true;
    }

    if (this.state === 'CLOSED') {
      if (permanent) {
        this._tripToOpen(currentNow, { permanent: true, reason });
        return true;
      }

      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold || notBefore || explicitCooldownMs !== null) {
        let cooldown = explicitCooldownMs;
        if (notBefore) {
          cooldown = Math.max(0, notBefore - currentNow);
        }
        this._tripToOpen(currentNow, { explicitCooldownMs: cooldown, notBefore, reason });
        return true;
      }
      return true;
    }

    // If state is OPEN, reject any stale probe report
    if (token) {
      return false;
    }

    if (notBefore && notBefore > this.notBefore) {
      this.notBefore = notBefore;
    }
    return true;
  }

  releaseProbe({ token = null } = {}) {
    if (this.state === 'HALF-OPEN' && this.probeActive) {
      if (token && (token !== this.probeToken || this.activeGeneration !== this.generation)) {
        return false;
      }
      this.probeActive = false;
      this.probeToken = null;
      this.probeDeadline = 0;
      this._clearActiveTimer();
      // Remains in HALF-OPEN so the next request can attempt canary admission!
      return true;
    }
    return false;
  }

  unblock() {
    this.state = 'CLOSED';
    this.permanent = false;
    this.openReason = null;
    this.consecutiveFailures = 0;
    this.currentCooldownMs = this.initialCooldownMs;
    this.notBefore = 0;
    this.probeActive = false;
    this.probeToken = null;
    this.probeDeadline = 0;
    this.activeGeneration = null;
    this._clearActiveTimer();
  }
}

class HeartbeatRegistry {
  constructor(options = {}) {
    this.history = new Map(); // Map<provider, { latency: number[], lastStatus: string, lastSeen: number, degradedUntil: number }>
    this.nodes = new Map(); // Map<string, CircuitBreakerNode>
    this.MAX_HISTORY = 10;
    this.nowFn = options.nowFn || (() => Date.now());
    this.timerFn = options.timerFn || { setTimeout, clearTimeout };
  }

  /**
   * Injectable virtual clock and timer for deterministic offline testing.
   */
  setClock(nowFn, timerFn = null) {
    if (typeof nowFn === 'function') {
      this.nowFn = nowFn;
    }
    if (timerFn) {
      this.timerFn = timerFn;
    }
    for (const node of this.nodes.values()) {
      node.nowFn = this.nowFn;
      node.timerFn = this.timerFn;
    }
  }

  /**
   * Clears all internal nodes and history (useful for test isolation).
   */
  reset() {
    for (const node of this.nodes.values()) {
      node._clearActiveTimer();
    }
    this.history.clear();
    this.nodes.clear();
  }

  getNode(key) {
    let node = this.nodes.get(key);
    if (!node) {
      node = new CircuitBreakerNode(key, {
        nowFn: this.nowFn,
        timerFn: this.timerFn
      });
      this.nodes.set(key, node);
    }
    return node;
  }

  /**
   * Admission Gate: Determines if a request can proceed to provider/model.
   * Handles HALF-OPEN Canary Token acquisition atomically across both Provider and Model scopes.
   * Preserves two-tier Canary Tokens in an envelope while maintaining backward-compatible string token.
   * @param {string} provider
   * @param {string|null} [modelId=null]
   * @param {Object} [options={}]
   * @returns {{ allowed: boolean, isCanary: boolean, token: string|null, tokens: { providerToken: string|null, modelToken: string|null }, reason?: string, retryAfterMs?: number }}
   */
  canPass(provider, modelId = null, options = {}) {
    const now = options.now !== undefined ? options.now : this.nowFn();

    // 1. Check Provider level gate
    const provNode = this.getNode(provider);
    const provPass = provNode.canPass(now);
    if (!provPass.allowed) {
      return {
        allowed: false,
        isCanary: false,
        token: null,
        tokens: { providerToken: null, modelToken: null },
        reason: provPass.reason || 'PROVIDER_CIRCUIT_OPEN',
        retryAfterMs: provPass.retryAfterMs,
        openReason: provPass.openReason
      };
    }

    // 2. Check Model level gate if modelId provided
    if (modelId) {
      const modelNode = this.getNode(`${provider}:${modelId}`);
      const modelPass = modelNode.canPass(now);
      if (!modelPass.allowed) {
        // Model rejected: if Provider node was granted a Canary probe in step 1, release it cleanly!
        if (provPass.isCanary && provPass.token) {
          provNode.releaseProbe({ token: provPass.token });
        }
        return {
          allowed: false,
          isCanary: false,
          token: null,
          tokens: { providerToken: null, modelToken: null },
          reason: modelPass.reason || 'MODEL_CIRCUIT_OPEN',
          retryAfterMs: modelPass.retryAfterMs,
          openReason: modelPass.openReason
        };
      }

      // Both allowed! Construct Two-Tier Token Envelope
      const isCanary = Boolean(provPass.isCanary || modelPass.isCanary);
      const providerToken = provPass.isCanary ? provPass.token : null;
      const modelToken = modelPass.isCanary ? modelPass.token : null;

      return {
        allowed: true,
        isCanary,
        // Backward compatibility: token defaults to modelToken if present, else providerToken
        token: modelToken || providerToken || null,
        tokens: {
          providerToken,
          modelToken
        }
      };
    }

    // Only Provider checked
    return {
      allowed: true,
      isCanary: Boolean(provPass.isCanary),
      token: provPass.token || null,
      tokens: {
        providerToken: provPass.isCanary ? provPass.token : null,
        modelToken: null
      }
    };
  }

  /**
   * Determines if a candidate model/provider is eligible to be listed as a routing candidate.
   * A candidate is eligible if:
   * 1. It is healthy (CLOSED state).
   * 2. OR it is in HALF-OPEN state (or OPEN with cooldown expired), ready for a Canary Probe.
   * A candidate is NOT eligible if:
   * - It is in PERMANENT failure.
   * - OR it is in OPEN state and cooldown is still active (now < notBefore).
   * @param {string} provider
   * @param {string|null} [modelId=null]
   * @param {Object} [options={}]
   * @returns {boolean}
   */
  isCandidateEligible(provider, modelId = null, options = {}) {
    const now = options.now !== undefined ? options.now : this.nowFn();

    // 1. Check Provider node
    const provNode = this.nodes.get(provider);
    if (provNode) {
      if (provNode.permanent) return false;
      if (provNode.state === 'OPEN' && now < provNode.notBefore) return false;
    }

    // 2. Check Model node if modelId provided
    if (modelId) {
      const modelNode = this.nodes.get(`${provider}:${modelId}`);
      if (modelNode) {
        if (modelNode.permanent) return false;
        if (modelNode.state === 'OPEN' && now < modelNode.notBefore) return false;
      }
    }

    // 3. Fallback check for legacy degradedUntil on history
    const stats = this.history.get(provider);
    if (stats && stats.lastStatus === 'degraded' && now < (stats.degradedUntil || 0)) {
      return false;
    }

    return true;
  }

  /**
   * Pure read-only status query: checks whether provider and optional model are healthy.
   * Does NOT consume Canary Tokens.
   * @param {string} provider 
   * @param {string|null} [modelId=null]
   * @param {Object} [options={}]
   * @returns {boolean}
   */
  isHealthy(provider, modelId = null, options = {}) {
    const now = options.now !== undefined ? options.now : this.nowFn();

    // 1. Provider node check
    const provNode = this.getNode(provider);
    if (!provNode.isHealthy(now)) return false;

    // 2. Model node check
    if (modelId) {
      const modelNode = this.getNode(`${provider}:${modelId}`);
      if (!modelNode.isHealthy(now)) return false;
    }

    // 3. Fallback check for legacy degradedUntil on history
    const stats = this.history.get(provider);
    if (stats && stats.lastStatus === 'degraded' && now < (stats.degradedUntil || 0)) {
      return false;
    }

    return true;
  }

  /**
   * Records a heartbeat for a specific provider and/or model.
   * Accurately settles two-tier Canary Tokens across Provider and Model scopes.
   * Supports success healing, failure tripping, and neutral release.
   * @param {string|Object} target - Provider string, or { provider, modelId, faultScope }
   * @param {number} latency - Response time in ms
   * @param {boolean} success - Whether operation succeeded
   * @param {Object} [options={}] - { token, tokens, faultScope, error, retryAfterMs, notBefore, permanent, reason, modelId, credentialId, accountId }
   */
  record(target, latency, success, options = {}) {
    const provider = typeof target === 'string' ? target : (target && target.provider) || 'unknown';
    const modelId = (target && target.modelId) || options.modelId || null;
    const now = options.now !== undefined ? options.now : this.nowFn();

    // 1. Update legacy latency history for provider
    const stats = this.history.get(provider) || { latency: [], lastStatus: 'unknown', lastSeen: 0, degradedUntil: 0 };
    if (typeof latency === 'number' && latency > 0) {
      stats.latency.push(latency);
      if (stats.latency.length > this.MAX_HISTORY) {
        stats.latency.shift();
      }
    }
    stats.lastSeen = now;

    // 2. Resolve faultScope
    let faultScope = options.faultScope || (target && target.faultScope);
    if (!faultScope) {
      if (options.error && options.error.faultScope) {
        faultScope = options.error.faultScope;
      } else if (modelId) {
        faultScope = 'MODEL';
      } else {
        faultScope = 'PROVIDER';
      }
    }

    const provNode = this.getNode(provider);

    // 3. Extract tokens from envelope or legacy token
    let providerToken = null;
    let modelToken = null;
    if (options.tokens) {
      providerToken = options.tokens.providerToken || null;
      modelToken = options.tokens.modelToken || null;
    }
    if (options.token) {
      if (!providerToken && provNode.state === 'HALF-OPEN' && options.token === provNode.probeToken) {
        providerToken = options.token;
      }
      if (!modelToken && modelId) {
        modelToken = options.token;
      }
      if (!providerToken && !modelId) {
        providerToken = options.token;
      }
    }

    if (success) {
      // Settle Provider node if it was in HALF-OPEN with valid providerToken
      if (provNode.state === 'HALF-OPEN') {
        if (providerToken) {
          provNode.recordSuccess({ token: providerToken, now });
        }
      } else if (provNode.state === 'CLOSED') {
        if (!modelId) {
          provNode.recordSuccess({ token: providerToken, now });
        }
      }

      // Settle Model node if modelId provided
      if (modelId) {
        this.getNode(`${provider}:${modelId}`).recordSuccess({ token: modelToken, now });
      }

      // Update provider stats if provNode is now CLOSED
      if (provNode.state === 'CLOSED') {
        stats.lastStatus = 'healthy';
        stats.degradedUntil = 0;
      }
      this.history.set(provider, stats);
    } else {
      // Extract error details
      const isManualOverride = (latency === 0 && !options.error);
      const permanent = options.permanent || (options.error && (options.error.type === 'HUB_MODEL_NOT_FOUND' || options.error.type === 'HUB_AUTH_ERROR')) || false;
      const reason = options.reason || (options.error && options.error.message) || (isManualOverride ? 'Manual Override' : 'API Error');
      const notBefore = options.notBefore || (options.error && options.error.retryAfterMs ? now + options.error.retryAfterMs : null);
      const explicitCooldownMs = options.explicitCooldownMs || (options.error && options.error.retryAfterMs ? options.error.retryAfterMs : (isManualOverride ? 300000 : null));

      if (faultScope === 'NONE') {
        // User/client input error: neutrally release probes without tripping breakers
        if (providerToken) provNode.releaseProbe({ token: providerToken });
        if (modelToken && modelId) this.getNode(`${provider}:${modelId}`).releaseProbe({ token: modelToken });
        return;
      }

      if (faultScope === 'PROVIDER') {
        provNode.recordFailure({
          token: providerToken,
          now,
          faultScope,
          permanent,
          reason,
          notBefore,
          explicitCooldownMs
        });

        // Isolate entire Provider in history stats if tripped to OPEN
        if (provNode.state === 'OPEN') {
          stats.lastStatus = 'degraded';
          stats.degradedUntil = provNode.notBefore;
        }
        this.history.set(provider, stats);

        // Model probe (if any) was not defective itself; neutrally release it
        if (modelToken && modelId) {
          this.getNode(`${provider}:${modelId}`).releaseProbe({ token: modelToken });
        }
      } else if (faultScope === 'MODEL') {
        if (!modelId) {
          console.warn(`[HeartbeatRegistry] ⚠️ SCOPE_ID_MISSING: faultScope is MODEL but modelId is missing for provider '${provider}'. Fault ignored to prevent broad outage.`);
          if (providerToken) provNode.releaseProbe({ token: providerToken });
          return;
        }

        // Isolate only this Model
        this.getNode(`${provider}:${modelId}`).recordFailure({
          token: modelToken,
          now,
          faultScope,
          permanent,
          reason,
          notBefore,
          explicitCooldownMs
        });

        // Provider Canary was not the cause of MODEL fault: neutrally release Provider probe!
        if (providerToken) {
          provNode.releaseProbe({ token: providerToken });
        }
      } else if (faultScope === 'CREDENTIAL') {
        const credKey = options.credentialId ? `${provider}:cred:${options.credentialId}` : provider;
        this.getNode(credKey).recordFailure({
          token: providerToken,
          now,
          faultScope,
          permanent: true,
          reason,
          notBefore,
          explicitCooldownMs
        });
        if (credKey === provider) {
          stats.lastStatus = 'degraded';
          stats.degradedUntil = Infinity;
          this.history.set(provider, stats);
        }
        if (modelToken && modelId) {
          this.getNode(`${provider}:${modelId}`).releaseProbe({ token: modelToken });
        }
      } else if (faultScope === 'ACCOUNT') {
        if (!options.accountId) {
          console.warn(`[HeartbeatRegistry] ⚠️ SCOPE_ID_MISSING: faultScope is ACCOUNT but accountId is missing for provider '${provider}'.`);
          if (providerToken) provNode.releaseProbe({ token: providerToken });
          if (modelToken && modelId) this.getNode(`${provider}:${modelId}`).releaseProbe({ token: modelToken });
          return;
        }
        const accKey = `${provider}:account:${options.accountId}`;
        const accountCooldown = explicitCooldownMs || 300000;
        this.getNode(accKey).recordFailure({
          token: providerToken,
          now,
          faultScope,
          permanent: false,
          reason,
          notBefore: notBefore || (now + accountCooldown),
          explicitCooldownMs: accountCooldown
        });
        if (providerToken) provNode.releaseProbe({ token: providerToken });
        if (modelToken && modelId) this.getNode(`${provider}:${modelId}`).releaseProbe({ token: modelToken });
      } else if (faultScope === 'UNKNOWN') {
        if (modelId) {
          console.warn(`[HeartbeatRegistry] ℹ️ UNKNOWN faultScope recorded at MODEL level for '${provider}:${modelId}'.`);
          this.getNode(`${provider}:${modelId}`).recordFailure({
            token: modelToken,
            now,
            faultScope: 'MODEL',
            permanent: false,
            reason: reason || 'UNKNOWN_FAULT',
            notBefore,
            explicitCooldownMs
          });
          if (providerToken) provNode.releaseProbe({ token: providerToken });
        } else {
          console.warn(`[HeartbeatRegistry] ⚠️ UNKNOWN_FAULT_WITHOUT_MODEL_ID: faultScope is UNKNOWN and modelId is missing for provider '${provider}'. Retaining diagnostics without isolating provider. Reason: ${reason}`);
          if (providerToken) provNode.releaseProbe({ token: providerToken });
          return;
        }
      } else {
        if (modelId) {
          this.getNode(`${provider}:${modelId}`).recordFailure({
            token: modelToken,
            now,
            faultScope: 'MODEL',
            permanent: false,
            reason,
            notBefore,
            explicitCooldownMs
          });
          if (providerToken) provNode.releaseProbe({ token: providerToken });
        } else {
          console.warn(`[HeartbeatRegistry] ⚠️ SCOPE_ID_MISSING: Unrecognized faultScope '${faultScope}' without modelId for provider '${provider}'. Not isolating provider.`);
          if (providerToken) provNode.releaseProbe({ token: providerToken });
          return;
        }
      }
    }
  }

  /**
   * Manually marks a provider or model as degraded.
   */
  markDegraded(provider, reason = 'API Error') {
    console.warn(`[HeartbeatRegistry] 🔥 Circuit Breaker: Target '${provider}' marked degraded (${reason}).`);
    this.record(provider, 9999, false, { reason, explicitCooldownMs: 300000 });
  }

  /**
   * Manually unblocks a model or provider from degraded/OPEN state.
   */
  unblock(provider, modelId = null) {
    if (modelId) {
      this.getNode(`${provider}:${modelId}`).unblock();
    } else {
      this.getNode(provider).unblock();
      const stats = this.history.get(provider);
      if (stats) {
        stats.lastStatus = 'healthy';
        stats.degradedUntil = 0;
      }
    }
  }

  /**
   * Returns average latency for a provider.
   */
  getAverageLatency(provider) {
    const stats = this.history.get(provider);
    if (!stats || stats.latency.length === 0) return 0;
    const sum = stats.latency.reduce((a, b) => a + b, 0);
    return sum / stats.latency.length;
  }

  /**
   * Returns the health status of a provider or model.
   */
  getStatus(provider, modelId = null, options = {}) {
    const now = options.now !== undefined ? options.now : this.nowFn();
    const key = modelId ? `${provider}:${modelId}` : provider;
    const node = this.nodes.get(key);
    if (node) {
      return node.getStatus(now);
    }
    const stats = this.history.get(provider);
    if (!stats) return 'unknown';

    if (stats.lastStatus === 'degraded' && now < (stats.degradedUntil || 0)) {
      return 'degraded';
    }

    if (now - stats.lastSeen > 300000) {
      return 'stale';
    }

    return stats.lastStatus;
  }

  /**
   * Returns stats across all providers and models.
   */
  getAllStats() {
    const all = {};
    for (const [provider, stats] of this.history.entries()) {
      const provNode = this.nodes.get(provider);
      all[provider] = {
        status: this.getStatus(provider),
        state: provNode ? provNode.state : (stats.lastStatus === 'healthy' ? 'CLOSED' : 'OPEN'),
        avgLatency: this.getAverageLatency(provider),
        models: {}
      };
    }

    for (const [key, node] of this.nodes.entries()) {
      if (key.includes(':') && !key.includes(':cred:') && !key.includes(':account:')) {
        const [provider, modelId] = key.split(':');
        if (!all[provider]) {
          all[provider] = {
            status: this.getStatus(provider),
            state: 'CLOSED',
            avgLatency: this.getAverageLatency(provider),
            models: {}
          };
        }
        all[provider].models[modelId] = {
          state: node.state,
          permanent: node.permanent,
          status: node.getStatus(this.nowFn())
        };
      }
    }

    return all;
  }
}

module.exports = new HeartbeatRegistry();
module.exports.HeartbeatRegistry = HeartbeatRegistry;
module.exports.CircuitBreakerNode = CircuitBreakerNode;
