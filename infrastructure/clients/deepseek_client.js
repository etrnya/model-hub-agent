const BaseClient = require('./base_client');
const errorMapper = require('../adapters/error_mapper');

/**
 * DeepSeekClient
 * Client for interacting with DeepSeek models via OpenAI compatible API.
 */
class DeepSeekClient extends BaseClient {
  constructor(config = {}) {
    super(config);
    this.apiKey = process.env.DEEPSEEK_API_KEY;
    if (!this.apiKey) {
      console.warn("[DeepSeekClient] DEEPSEEK_API_KEY environment variable is not set.");
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
      throw new Error("Missing DeepSeek API Key. Please set DEEPSEEK_API_KEY in .env");
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
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          model: this.modelCapability.model_id,
          messages: messages,
          temperature: 0.2, // Low temperature for stability
          response_format: { type: "json_object" } // DeepSeek supports JSON mode
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const mappedErrorType = errorMapper.map('deepseek', { 
          status: response.status, 
          message: errorData.error?.message || response.statusText 
        });
        
        throw new Error(`[${mappedErrorType}] DeepSeek API request failed: ${JSON.stringify(errorData)}`);
      }

      const data = await response.json();
      
      if (!data.choices || data.choices.length === 0) {
        throw new Error("DeepSeek API returned an empty response.");
      }

      return data.choices[0].message.content;

    } catch (error) {
      if (error.message.startsWith("[HUB_")) throw error;
      
      const mappedErrorType = errorMapper.map('deepseek', { status: 500, message: error.message });
      throw new Error(`[${mappedErrorType}] Network or execution error: ${error.message}`);
    }
  }
}

module.exports = DeepSeekClient;
