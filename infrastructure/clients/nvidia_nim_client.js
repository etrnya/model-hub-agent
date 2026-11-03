const BaseClient = require('./base_client');
const errorMapper = require('../adapters/error_mapper');

/**
 * NvidiaNimClient
 * Client for interacting with NVIDIA NIM models (e.g., Llama 3.1) via OpenAI compatible API.
 * High-performance optimizations: SSE streaming parsing, Connection keep-alive, prompt minification, TTFT latency tracking.
 */
class NvidiaNimClient extends BaseClient {
  constructor(config = {}) {
    super(config);
    this.apiKey = process.env.NVIDIA_API_KEY;
    this.enableStream = config.enableStream !== undefined ? config.enableStream : true;
    if (!this.apiKey) {
      console.warn("[NvidiaNimClient] NVIDIA_API_KEY environment variable is not set.");
    }
  }

  /**
   * Implements the abstract method from BaseClient.
   * @param {Object} payload - The compressed state from ContextCompressor.
   * @param {Object} outputSchema - The expected JSON schema for the response.
   * @returns {string} The raw string output from the model.
   */
  async _callModelApi(payload, outputSchema) {
    if (!this.apiKey) {
      throw new Error("Missing NVIDIA API Key. Please set NVIDIA_API_KEY in .env");
    }

    // Minify system prompt instruction to reduce payload size and ensure strict JSON response
    const toolCallTemplate = this.promptMapping ? this.promptMapping.tool_call_template : '';
    const systemInstruction = `You are an AI assistant. You MUST output ONLY a valid raw JSON object conforming strictly to this JSON schema. Do NOT wrap output in markdown code blocks or text:\n${JSON.stringify(outputSchema)}\n${toolCallTemplate}`.trim();

    const userPayloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

    const messages = [
      { role: "system", content: systemInstruction },
      { role: "user", content: userPayloadStr }
    ];

    try {
      const originalUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
      const { url, headers } = this.resolveRequestRoute(
        originalUrl,
        {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Accept": this.enableStream ? "text/event-stream" : "application/json",
          "Connection": "keep-alive"
        },
        payload.integrity_headers || {}
      );

      const requestBody = {
        model: this.modelCapability.model_id,
        messages: messages,
        temperature: 0.1,
        max_tokens: this.modelCapability.max_output_tokens || 4096,
        stream: this.enableStream,
        ...(!this.enableStream && { response_format: { type: "json_object" } })
      };

      const startTime = Date.now();
      const response = await fetch(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw errorMapper.createError('nvidia-nim', {
          status: response.status,
          message: errorData.message || response.statusText,
          headers: response.headers,
          error: errorData,
          modelId: this.modelCapability.model_id
        });
      }

      if (this.enableStream && response.body) {
        let text = await this._parseSseStream(response.body, startTime);
        // Clean markdown fences if any returned by model
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        return text;
      } else {
        const data = await response.json();
        if (!data.choices || data.choices.length === 0) {
          throw new Error("NVIDIA API returned an empty response.");
        }
        let text = data.choices[0].message.content;
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        return text;
      }

    } catch (error) {
      if (error instanceof errorMapper.HubError || error.message.startsWith("[HUB_")) {
        throw error;
      }
      
      throw errorMapper.createError('nvidia-nim', {
        cause: error,
        message: error.message,
        modelId: this.modelCapability.model_id
      });
    }
  }

  /**
   * Helper method to parse Server-Sent Events (SSE) stream chunks and log TTFT
   */
  async _parseSseStream(bodyStream, startTime) {
    let ttftLogged = false;
    let fullText = "";
    
    // Support Node 18+ Web Stream (bodyStream.getReader())
    if (typeof bodyStream.getReader === 'function') {
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        if (!ttftLogged) {
          const ttft = Date.now() - startTime;
          console.log(`[NvidiaNimClient] ⚡ TTFT (Time-To-First-Token): ${ttft}ms`);
          ttftLogged = true;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") continue;
          if (trimmed.startsWith("data: ")) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
              if (delta) {
                fullText += delta;
              }
            } catch (e) {
              // Ignore partial line parse errors
            }
          }
        }
      }
    } else {
      // Fallback for async iterable standard Node streams
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      for await (const chunk of bodyStream) {
        if (!ttftLogged) {
          const ttft = Date.now() - startTime;
          console.log(`[NvidiaNimClient] ⚡ TTFT (Time-To-First-Token): ${ttft}ms`);
          ttftLogged = true;
        }
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") continue;
          if (trimmed.startsWith("data: ")) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
              if (delta) {
                fullText += delta;
              }
            } catch (e) {}
          }
        }
      }
    }

    if (!fullText) {
      throw new Error("NVIDIA API SSE stream returned empty content.");
    }

    return fullText;
  }
}

module.exports = NvidiaNimClient;

