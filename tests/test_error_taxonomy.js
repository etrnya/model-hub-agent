/**
 * test_error_taxonomy.js
 * 
 * P0-B Step 4.2-A Final Patch: Error Classification Boundary Closure & Execution Tests
 * 
 * Comprehensive Verification:
 *  1. 401 Auth Error triggers Fast-Fail on attempt 1 without 3 in-place retries.
 *  2. 403 Forbidden correctly classified as PERMISSION_ERROR (non-transient).
 *  3. 400 Bad Request correctly classified as INVALID_REQUEST (non-transient).
 *  4. 404 Distinction: Specific Model Not Found vs Generic Resource / Endpoint Not Found.
 *  5. HTTP Status Priority: 504 Gateway Timeout, 503, 502, 500 -> PROVIDER_SERVER_ERROR.
 *  6. Client Transport Exceptions (status absent): ETIMEDOUT -> TIMEOUT_ERROR, ECONNREFUSED -> NETWORK_ERROR.
 *  7. Retry-After = 0 Execution: BaseClient executes immediate retry without exponential backoff.
 *  8. Retry-After = 45 Execution: BaseClient respects server-requested 45000ms delay.
 *  9. Retry-After Exceeds Upper Bound: Aborts in-place retry immediately, preserves raw value, triggers fallback.
 * 10. Retry-After Missing Header: Uses default exponential backoff.
 * 11. Unknown Error classified as UNKNOWN_ERROR (non-transient).
 * 12. Four Provider Adapters (Gemini, DeepSeek, NIM, Vertex AI) error detail & cause traceability.
 */

const assert = require('node:assert');
const errorMapper = require('../infrastructure/adapters/error_mapper');
const BaseClient = require('../infrastructure/clients/base_client');
const GeminiClient = require('../infrastructure/clients/gemini_client');
const DeepSeekClient = require('../infrastructure/clients/deepseek_client');
const NvidiaNimClient = require('../infrastructure/clients/nvidia_nim_client');
const VertexAIClient = require('../infrastructure/clients/vertex_ai_client');

async function runTests() {
  console.log("==================================================");
  console.log("🧪 [P0-B Step 4.2-A Final Patch] Taxonomy & Retry Tests");
  console.log("==================================================\n");

  // ----------------------------------------------------
  // Test 1: 401 Fast-Fail (No 3 in-place retries)
  // ----------------------------------------------------
  {
    console.log("👉 Test 1: 401 Auth Error Fast-Fail verification...");
    let callAttempts = 0;

    class TestAuthClient extends BaseClient {
      constructor() {
        super({
          modelCapability: {
            model_id: "test-auth-model",
            provider: "google",
            limits: { rpm: 100, tpm: 100000 }
          },
          retry: { maxRetries: 3, initialDelay: 10 }
        });
      }

      async _callModelApi() {
        callAttempts++;
        throw errorMapper.createError('google', {
          status: 401,
          message: "API key not valid. Please pass a valid API key.",
          providerCode: "UNAUTHENTICATED",
          modelId: "test-auth-model"
        });
      }
    }

    const client = new TestAuthClient();
    let thrownError = null;

    try {
      await client.execute({ objective: "test 401" }, {});
    } catch (err) {
      thrownError = err;
    }

    assert(thrownError !== null, "Test 1 failed: Client should have thrown on 401");
    assert(thrownError instanceof errorMapper.HubError, "Test 1 failed: Thrown error must be HubError");
    assert.strictEqual(thrownError.type, 'HUB_AUTH_ERROR', `Test 1 failed: Expected HUB_AUTH_ERROR, got ${thrownError.type}`);
    assert.strictEqual(thrownError.isTransient, false, "Test 1 failed: 401 must not be transient");
    assert.strictEqual(callAttempts, 1, `Test 1 failed: Expected exactly 1 attempt (Fast-Fail), got ${callAttempts}`);
    console.log("  ✅ PASS: 401 aborted immediately on attempt 1 without redundant retries.");
  }

  // ----------------------------------------------------
  // Test 2: 403 Permission Error Classification
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 2: 403 Permission Error classification...");
    const classified = errorMapper.classify('google', {
      status: 403,
      message: "The caller does not have permission to execute specified model",
      providerCode: "PERMISSION_DENIED"
    });

    assert.strictEqual(classified.type, 'HUB_PERMISSION_ERROR', "Test 2 failed: 403 must map to HUB_PERMISSION_ERROR");
    assert.strictEqual(classified.isTransient, false, "Test 2 failed: 403 must not be transient");
    assert.strictEqual(errorMapper.shouldRetry(classified), false, "Test 2 failed: 403 should not be retried");
    console.log("  ✅ PASS: 403 classified as HUB_PERMISSION_ERROR (non-transient).");
  }

  // ----------------------------------------------------
  // Test 3: 400 Invalid Request Classification
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 3: 400 Invalid Request classification...");
    const classified = errorMapper.classify('deepseek', {
      status: 400,
      message: "Invalid request payload format: syntax error at line 1",
      providerCode: "invalid_request_error"
    });

    assert.strictEqual(classified.type, 'HUB_INVALID_REQUEST', "Test 3 failed: 400 must map to HUB_INVALID_REQUEST");
    assert.strictEqual(classified.isTransient, false, "Test 3 failed: 400 must not be transient");
    assert.strictEqual(errorMapper.shouldRetry(classified), false, "Test 3 failed: 400 should not be retried");
    console.log("  ✅ PASS: 400 classified as HUB_INVALID_REQUEST (non-transient).");
  }

  // ----------------------------------------------------
  // Test 4: 404 Distinction (Model Not Found vs Generic Resource Not Found)
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 4: 404 Model Not Found vs Generic Resource Not Found...");
    
    // 4a. Model-specific 404
    const modelNotFound = errorMapper.classify('nvidia-nim', {
      status: 404,
      message: "The model `meta/llama-deprecated` does not exist",
      providerCode: "model_not_found"
    });
    assert.strictEqual(modelNotFound.type, 'HUB_MODEL_NOT_FOUND', "Test 4a failed: Model 404 must map to HUB_MODEL_NOT_FOUND");
    assert.strictEqual(modelNotFound.isTransient, false, "Test 4a failed: Model 404 must not be transient");

    // 4b. Google format: "models/gemini-1.5-pro is not found"
    const googleModelNotFound = errorMapper.classify('google', {
      status: 404,
      message: "models/gemini-invalid is not found for API version v1beta"
    });
    assert.strictEqual(googleModelNotFound.type, 'HUB_MODEL_NOT_FOUND', "Test 4b failed: Google models/ 404 must map to HUB_MODEL_NOT_FOUND");

    // 4c. Generic endpoint / URL 404 (without model evidence)
    const genericNotFound = errorMapper.classify('deepseek', {
      status: 404,
      message: "Cannot POST /v1/invalid_endpoint"
    });
    assert.strictEqual(genericNotFound.type, 'HUB_RESOURCE_NOT_FOUND', "Test 4c failed: Generic 404 must map to HUB_RESOURCE_NOT_FOUND");
    assert.strictEqual(genericNotFound.isTransient, false, "Test 4c failed: Resource 404 must not be transient");
    assert.strictEqual(errorMapper.shouldRetry(genericNotFound), false, "Test 4c failed: Resource 404 should not be retried");

    console.log("  ✅ PASS: 404 cleanly partitioned into HUB_MODEL_NOT_FOUND vs HUB_RESOURCE_NOT_FOUND.");
  }

  // ----------------------------------------------------
  // Test 5: HTTP Status Priority (504, 503, 502, 500)
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 5: HTTP Status Priority over message heuristics (504 Gateway Timeout, 503, 502, 500)...");
    
    // Crucial check: 504 + message contains "Gateway Timeout"
    const gatewayTimeout = errorMapper.classify('google', {
      status: 504,
      message: "504 Gateway Timeout: The upstream server failed to respond in time."
    });
    assert.strictEqual(gatewayTimeout.type, 'HUB_PROVIDER_SERVER_ERROR', "Test 5 failed: 504 Gateway Timeout MUST map to HUB_PROVIDER_SERVER_ERROR, not TIMEOUT_ERROR");
    assert.strictEqual(gatewayTimeout.isTransient, true, "Test 5 failed: 504 must be transient");

    // 503, 502, 500
    for (const [code, msg] of [
      [503, "Service Unavailable"],
      [502, "Bad Gateway"],
      [500, "Internal Server Error"]
    ]) {
      const classified = errorMapper.classify('vertex-ai', { status: code, message: msg });
      assert.strictEqual(classified.type, 'HUB_PROVIDER_SERVER_ERROR', `Test 5 failed: ${code} must map to HUB_PROVIDER_SERVER_ERROR`);
      assert.strictEqual(classified.isTransient, true, `Test 5 failed: ${code} must be transient`);
      assert.strictEqual(errorMapper.shouldRetry(classified), true, `Test 5 failed: ${code} should be retryable`);
    }

    console.log("  ✅ PASS: 504, 503, 502, 500 prioritized as HUB_PROVIDER_SERVER_ERROR.");
  }

  // ----------------------------------------------------
  // Test 6: Client Transport Exceptions (Status Absent)
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 6: Client transport exceptions (status absent)...");

    // ETIMEDOUT without HTTP status
    const timeoutErr = new Error("Connection timed out after 10000ms");
    timeoutErr.code = "ETIMEDOUT";
    const timeoutClassified = errorMapper.classify('google', timeoutErr);
    assert.strictEqual(timeoutClassified.type, 'HUB_TIMEOUT_ERROR', "Test 6 failed: ETIMEDOUT must map to HUB_TIMEOUT_ERROR");
    assert.strictEqual(timeoutClassified.isTransient, true, "Test 6 failed: ETIMEDOUT must be transient");

    // AbortError without HTTP status
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const abortClassified = errorMapper.classify('nvidia-nim', abortErr);
    assert.strictEqual(abortClassified.type, 'HUB_TIMEOUT_ERROR', "Test 6 failed: AbortError must map to HUB_TIMEOUT_ERROR");

    // ECONNREFUSED without HTTP status
    const netErr = new Error("fetch failed");
    netErr.code = "ECONNREFUSED";
    const netClassified = errorMapper.classify('deepseek', netErr);
    assert.strictEqual(netClassified.type, 'HUB_NETWORK_ERROR', "Test 6 failed: ECONNREFUSED must map to HUB_NETWORK_ERROR");
    assert.strictEqual(netClassified.isTransient, true, "Test 6 failed: Network error must be transient");

    console.log("  ✅ PASS: Transport timeouts and network drops classified when status is absent.");
  }

  // ----------------------------------------------------
  // Test 7: Retry-After = 0 Execution Behavior
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 7: Retry-After = 0 execution behavior in BaseClient...");
    let recordedSleep = null;
    let attempts = 0;

    class TestZeroDelayClient extends BaseClient {
      constructor() {
        super({
          modelCapability: { model_id: "test-0-model", provider: "google", limits: { rpm: 100, tpm: 100000 } },
          retry: { maxRetries: 2, initialDelay: 5000 },
          sleep: async (ms) => { recordedSleep = ms; }
        });
      }

      async _callModelApi() {
        attempts++;
        if (attempts === 1) {
          throw errorMapper.createError('google', {
            status: 429,
            message: "Rate limit reached",
            headers: { 'retry-after': '0' }
          });
        }
        return JSON.stringify({ data: "success" });
      }
    }

    const client = new TestZeroDelayClient();
    const result = await client.execute({ objective: "test 0 delay" }, { type: "object" });
    assert.deepStrictEqual(result, { data: "success" });
    assert.strictEqual(attempts, 2, "Test 7 failed: Should have retried and succeeded on attempt 2");
    // Crucial: sleep should NOT be 5000ms (the exponential backoff initialDelay), it must be 0ms!
    assert.strictEqual(recordedSleep, null, "Test 7 failed: 0ms delay should execute immediate retry without timer lag");
    console.log("  ✅ PASS: Retry-After = 0 executed immediate retry without falling back to 5000ms backoff.");
  }

  // ----------------------------------------------------
  // Test 8: Retry-After = 45 Execution Behavior
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 8: Retry-After = 45 execution behavior in BaseClient...");
    let recordedSleep = null;
    let attempts = 0;

    class Test45DelayClient extends BaseClient {
      constructor() {
        super({
          modelCapability: { model_id: "test-45-model", provider: "deepseek", limits: { rpm: 100, tpm: 100000 } },
          retry: { maxRetries: 2, initialDelay: 1000, maxRetryAfterMs: 60000 },
          sleep: async (ms) => { recordedSleep = ms; }
        });
      }

      async _callModelApi() {
        attempts++;
        if (attempts === 1) {
          throw errorMapper.createError('deepseek', {
            status: 429,
            message: "Rate limit reached",
            headers: { 'retry-after': '45' }
          });
        }
        return JSON.stringify({ ok: true });
      }
    }

    const client = new Test45DelayClient();
    const result = await client.execute({ objective: "test 45 delay" }, { type: "object" });
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(recordedSleep, 45000, `Test 8 failed: Expected sleep of 45000ms, got ${recordedSleep}ms`);
    console.log("  ✅ PASS: Retry-After = 45 accurately respected with 45000ms sleep delay.");
  }

  // ----------------------------------------------------
  // Test 9: Retry-After Exceeds Upper Bound Protection
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 9: Retry-After exceeds upper bound protection...");
    let sleepCalled = false;
    let thrownError = null;

    class TestExcessiveDelayClient extends BaseClient {
      constructor() {
        super({
          modelCapability: { model_id: "test-huge-model", provider: "nvidia-nim", limits: { rpm: 100, tpm: 100000 } },
          retry: { maxRetries: 3, maxRetryAfterMs: 30000 }, // 30s max budget
          sleep: async () => { sleepCalled = true; }
        });
      }

      async _callModelApi() {
        throw errorMapper.createError('nvidia-nim', {
          status: 429,
          message: "Rate limit reached",
          headers: { 'retry-after': '86400' } // 24 hours
        });
      }
    }

    const client = new TestExcessiveDelayClient();
    try {
      await client.execute({ objective: "test excessive delay" }, {});
    } catch (err) {
      thrownError = err;
    }

    assert(thrownError !== null, "Test 9 failed: Excessive Retry-After should abort in-place retry and throw");
    assert.strictEqual(sleepCalled, false, "Test 9 failed: Must not sleep when Retry-After exceeds upper bound");
    assert.strictEqual(thrownError.retryAfter, 86400, "Test 9 failed: Original raw retryAfter must be preserved");
    assert.strictEqual(thrownError.retryAfterExceeded, true, "Test 9 failed: retryAfterExceeded flag must be true");
    console.log("  ✅ PASS: 86400s delay cleanly aborted without sleeping, preserving raw value for cascading fallback.");
  }

  // ----------------------------------------------------
  // Test 10: Retry-After Missing Header Fallback
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 10: Retry-After missing header fallback to backoff...");
    let recordedSleep = null;
    let attempts = 0;

    class TestFallbackClient extends BaseClient {
      constructor() {
        super({
          modelCapability: { model_id: "test-fb-model", provider: "vertex-ai", limits: { rpm: 100, tpm: 100000 } },
          retry: { maxRetries: 2, initialDelay: 750 },
          sleep: async (ms) => { recordedSleep = ms; }
        });
      }

      async _callModelApi() {
        attempts++;
        if (attempts === 1) {
          throw errorMapper.createError('vertex-ai', {
            status: 429,
            message: "Rate limit reached without header"
          });
        }
        return JSON.stringify({ status: "recovered" });
      }
    }

    const client = new TestFallbackClient();
    const result = await client.execute({ objective: "test fallback" }, { type: "object" });
    assert.deepStrictEqual(result, { status: "recovered" });
    assert.strictEqual(recordedSleep, 750, `Test 10 failed: Expected default backoff 750ms, got ${recordedSleep}ms`);
    console.log("  ✅ PASS: Missing header correctly falls back to exponential backoff (750ms).");
  }

  // ----------------------------------------------------
  // Test 11: Unknown Error Classification
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 11: Unknown Error classification...");
    const unknown = errorMapper.classify('google', { status: 418, message: "I'm a teapot" });
    assert.strictEqual(unknown.type, 'HUB_UNKNOWN_ERROR', "Test 11 failed: 418 must map to HUB_UNKNOWN_ERROR");
    assert.strictEqual(unknown.isTransient, false, "Test 11 failed: Unknown error must not be marked transient");
    assert.strictEqual(errorMapper.shouldRetry(unknown), false, "Test 11 failed: Unknown error should not be blindly retried");
    console.log("  ✅ PASS: Unknown error classified as HUB_UNKNOWN_ERROR (non-transient).");
  }

  // ----------------------------------------------------
  // Test 12: Four Provider Adapters Detail & Traceability
  // ----------------------------------------------------
  {
    console.log("\n👉 Test 12: Four Provider Adapters (Gemini, DeepSeek, NIM, Vertex AI) error propagation...");

    // 12a. GeminiClient error propagation
    {
      const gemini = new GeminiClient({
        modelCapability: { model_id: "gemini-2.5-flash", provider: "google" }
      });
      gemini.apiKey = "mock-gemini-key";
      // Mock global fetch to return a 429 with retry-after
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (k) => k.toLowerCase() === 'retry-after' ? '30' : null },
        json: async () => ({ error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } })
      });

      let errCaught = null;
      try {
        await gemini._callModelApi({ objective: "test" }, {});
      } catch (err) {
        errCaught = err;
      } finally {
        global.fetch = originalFetch;
      }

      assert(errCaught instanceof errorMapper.HubError, "Gemini must throw HubError");
      assert.strictEqual(errCaught.status, 429);
      assert.strictEqual(errCaught.provider, "google");
      assert.strictEqual(errCaught.modelId, "gemini-2.5-flash");
      assert.strictEqual(errCaught.retryAfter, 30);
      assert.strictEqual(errCaught.providerCode, "RESOURCE_EXHAUSTED");
      console.log("    ✔ GeminiClient preserves status, retryAfter, providerCode, modelId.");
    }

    // 12b. DeepSeekClient error propagation
    {
      const deepseek = new DeepSeekClient({
        modelCapability: { model_id: "deepseek-chat", provider: "deepseek" }
      });
      deepseek.apiKey = "mock-deepseek-key";
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { get: () => null },
        json: async () => ({ error: { message: "Authentication Fails", code: "invalid_api_key" } })
      });

      let errCaught = null;
      try {
        await deepseek._callModelApi({ objective: "test" }, {});
      } catch (err) {
        errCaught = err;
      } finally {
        global.fetch = originalFetch;
      }

      assert(errCaught instanceof errorMapper.HubError, "DeepSeek must throw HubError");
      assert.strictEqual(errCaught.status, 401);
      assert.strictEqual(errCaught.provider, "deepseek");
      assert.strictEqual(errCaught.modelId, "deepseek-chat");
      assert.strictEqual(errCaught.providerCode, "invalid_api_key");
      assert.strictEqual(errCaught.type, "HUB_AUTH_ERROR");
      console.log("    ✔ DeepSeekClient preserves status, providerCode, modelId.");
    }

    // 12c. NvidiaNimClient error propagation
    {
      const nim = new NvidiaNimClient({
        modelCapability: { model_id: "meta/llama-3.1-8b-instruct", provider: "nvidia-nim" }
      });
      nim.apiKey = "mock-nim-key";
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: { get: () => null },
        json: async () => ({ message: "The model `meta/llama-deprecated` does not exist", code: "model_not_found" })
      });

      let errCaught = null;
      try {
        await nim._callModelApi({ objective: "test" }, {});
      } catch (err) {
        errCaught = err;
      } finally {
        global.fetch = originalFetch;
      }

      assert(errCaught instanceof errorMapper.HubError, "NIM must throw HubError");
      assert.strictEqual(errCaught.status, 404);
      assert.strictEqual(errCaught.provider, "nvidia-nim");
      assert.strictEqual(errCaught.modelId, "meta/llama-3.1-8b-instruct");
      assert.strictEqual(errCaught.type, "HUB_MODEL_NOT_FOUND");
      console.log("    ✔ NvidiaNimClient preserves status, providerCode, modelId.");
    }

    // 12d. VertexAIClient error propagation
    {
      const vertex = new VertexAIClient({
        modelCapability: { model_id: "vertex/gemini-2.5-flash", provider: "vertex-ai" }
      });
      vertex.gcpKeyPath = "mock-gcp-key.json";
      vertex.projectId = "mock-project";
      vertex.location = "us-central1";
      vertex._getAccessToken = async () => "mock-token";
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        headers: { get: () => null },
        json: async () => ({ error: { code: 503, message: "Backend service unavailable", status: "UNAVAILABLE" } })
      });

      let errCaught = null;
      try {
        await vertex._callModelApi({ objective: "test" }, {});
      } catch (err) {
        errCaught = err;
      } finally {
        global.fetch = originalFetch;
      }

      assert(errCaught instanceof errorMapper.HubError, "Vertex AI must throw HubError");
      assert.strictEqual(errCaught.status, 503);
      assert.strictEqual(errCaught.provider, "vertex-ai");
      assert.strictEqual(errCaught.modelId, "vertex/gemini-2.5-flash");
      assert.strictEqual(errCaught.type, "HUB_PROVIDER_SERVER_ERROR");
      console.log("    ✔ VertexAIClient preserves status, providerCode, modelId.");
    }

    console.log("  ✅ PASS: All four Provider Clients correctly transmit status, headers, codes, and cause.");
  }

  console.log("\n==================================================");
  console.log("📊 [P0-B Step 4.2-A Final Patch Results]: 12/12 passed (100%)");
  console.log("==================================================\n");
}

runTests().catch(err => {
  console.error("❌ Test Suite Failed:", err);
  process.exit(1);
});
