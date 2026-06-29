const BaseClient = require('./base_client');
const errorMapper = require('../adapters/error_mapper');

/**
 * GeminiClient
 * Client for interacting with Google's Gemini models via the Gemini API.
 */
class GeminiClient extends BaseClient {
  constructor(config = {}) {
    super(config);
    this.apiKey = process.env.GEMINI_API_KEY;
    this.gcpKeyPath = process.env.GCP_KEY_PATH;
    if (!this.apiKey && !this.gcpKeyPath) {
      console.warn("[GeminiClient] Neither GEMINI_API_KEY nor GCP_KEY_PATH environment variable is set.");
    }
    this._token = null;
    this._tokenExpiry = 0;
  }

  /**
   * Generates a temporary OAuth2 Access Token using gcp-key.json.
   * Caches the token for up to 1 hour to prevent redundant auth requests.
   */
  async _getAccessToken() {
    if (this._token && this._tokenExpiry > Date.now() + 60000) {
      return this._token;
    }
    try {
      const { GoogleAuth } = require('google-auth-library');
      const auth = new GoogleAuth({
        keyFile: this.gcpKeyPath,
        scopes: ['https://www.googleapis.com/auth/generative-language']
      });
      const client = await auth.getClient();
      const tokenResponse = await client.getAccessToken();
      this._token = tokenResponse.token;
      this._tokenExpiry = Date.now() + 3500000; // Standard 1 hour expiry
      return this._token;
    } catch (e) {
      throw new Error(`Failed to generate GCP access token: ${e.message}`);
    }
  }

  /**
   * Implements the abstract method from BaseClient.
   * @param {Object} payload - The compressed state from ContextCompressor.
   * @param {Object} outputSchema - The expected JSON schema for the response.
   * @returns {string} The raw string output from the model.
   */
  async _callModelApi(payload, outputSchema) {
    let url;
    const headers = {
      "Content-Type": "application/json"
    };

    if (this.gcpKeyPath) {
      const token = await this._getAccessToken();
      headers["Authorization"] = `Bearer ${token}`;
      url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelCapability.model_id}:generateContent`;
    } else {
      if (!this.apiKey) {
        throw new Error("Missing Gemini API Key. Please set GEMINI_API_KEY or GCP_KEY_PATH in .env");
      }
      url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelCapability.model_id}:generateContent?key=${this.apiKey}`;
    }

    // Format the payload for Gemini API
    const systemInstruction = `You are an AI assistant. Please respond to the user's request. 
      If you need to output structured data, ensure it strictly follows this JSON schema:
      ${JSON.stringify(outputSchema)}
      
      Here is your preferred tool format instruction: ${this.promptMapping ? this.promptMapping.tool_call_template : ''}`;

    const requestBody = {
      system_instruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [{
        role: "user",
        parts: [{ text: JSON.stringify(payload) }]
      }],
      generationConfig: {
        temperature: 0.2,
        max_output_tokens: 8192,
        response_mime_type: "application/json" // Force JSON output for Gemini
      }
    };

    try {
      const routed = this.resolveRequestRoute(url, headers, payload.integrity_headers || {});
      const response = await fetch(routed.url, {
        method: "POST",
        headers: routed.headers,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const mappedErrorType = errorMapper.map('google', { 
          status: response.status, 
          message: errorData.error?.message || response.statusText 
        });
        
        throw new Error(`[${mappedErrorType}] Gemini API request failed: ${JSON.stringify(errorData)}`);
      }

      const data = await response.json();
      
      if (!data.candidates || data.candidates.length === 0) {
        throw new Error("Gemini API returned an empty response.");
      }

      // Extract the text content from the Gemini response structure
      const content = data.candidates[0].content.parts[0].text;
      return content;

    } catch (error) {
      if (error.message.startsWith("[HUB_")) throw error;
      
      const mappedErrorType = errorMapper.map('google', { status: 500, message: error.message });
      throw new Error(`[${mappedErrorType}] Network or execution error: ${error.message}`);
    }
  }
}

module.exports = GeminiClient;
