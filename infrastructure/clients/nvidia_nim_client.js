const BaseClient = require('./base_client');
const errorMapper = require('../adapters/error_mapper');

/**
 * NvidiaNimClient
 * Client for interacting with NVIDIA NIM models (e.g., Llama 3.1) via OpenAI compatible API.
 */
class NvidiaNimClient extends BaseClient {
  constructor(config = {}) {
    super(config);
    this.apiKey = process.env.NVIDIA_API_KEY;
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

    // Format the payload into an OpenAI-compatible messages array
    const messages = [
      {
        role: "system",
        content: `You are an AI assistant. Please respond to the user's request. 
          If you need to output structured data, ensure it strictly follows this JSON schema:
          ${JSON.stringify(outputSchema)}
          
          Here is your preferred tool format instruction: ${this.promptMapping ? this.promptMapping.tool_call_template : ''}`
      },
      {
        role: "user",
        content: JSON.stringify(payload)
      }
    ];

    try {
      const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          model: this.modelCapability.model_id,
          messages: messages,
          temperature: 0.2, // Low temperature for deterministic output
          max_tokens: this.modelCapability.max_output_tokens || 4096
        })
      });

      if (!response.ok) {
        // Map external errors to internal standard errors
        const errorData = await response.json().catch(() => ({}));
        const mappedErrorType = errorMapper.map('nvidia-nim', { 
          status: response.status, 
          message: errorData.message || response.statusText 
        });
        
        throw new Error(`[${mappedErrorType}] NVIDIA API request failed with status ${response.status}: ${JSON.stringify(errorData)}`);
      }

      const data = await response.json();
      
      if (!data.choices || data.choices.length === 0) {
        throw new Error("NVIDIA API returned an empty response.");
      }

      return data.choices[0].message.content;

    } catch (error) {
      // If it's already a mapped error, rethrow it
      if (error.message.startsWith("[HUB_")) {
        throw error;
      }
      
      // Handle network errors or other unexpected errors
      const mappedErrorType = errorMapper.map('nvidia-nim', { status: 500, message: error.message });
      throw new Error(`[${mappedErrorType}] Network or execution error: ${error.message}`);
    }
  }
}

module.exports = NvidiaNimClient;
