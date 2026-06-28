const BaseClient = require('./base_client');
const errorMapper = require('../adapters/error_mapper');
const fs = require('fs');

/**
 * VertexAIClient
 * Client for interacting with Google's Gemini models via GCP Vertex AI API.
 * Uses Service Account JSON key credentials for postpaid billing.
 */
class VertexAIClient extends BaseClient {
  constructor(config = {}) {
    super(config);
    this.gcpKeyPath = process.env.GCP_KEY_PATH;
    if (!this.gcpKeyPath) {
      console.warn("[VertexAIClient] GCP_KEY_PATH environment variable is not set.");
    } else if (!fs.existsSync(this.gcpKeyPath)) {
      console.warn(`[VertexAIClient] Service account key file not found at: ${this.gcpKeyPath}`);
    }
    
    // Parse Project ID from the key file
    this.projectId = null;
    if (this.gcpKeyPath && fs.existsSync(this.gcpKeyPath)) {
      try {
        const keyData = JSON.parse(fs.readFileSync(this.gcpKeyPath, 'utf8'));
        this.projectId = keyData.project_id;
      } catch (e) {
        console.error("[VertexAIClient] Failed to parse project_id from GCP JSON key:", e.message);
      }
    }
    
    this.location = process.env.GCP_LOCATION || "us-central1";
    this._token = null;
    this._tokenExpiry = 0;
  }

  /**
   * Generates a temporary OAuth2 Access Token using the GCP JSON Key.
   * Scoped to 'https://www.googleapis.com/auth/cloud-platform'.
   */
  async _getAccessToken() {
    if (this._token && this._tokenExpiry > Date.now() + 60000) {
      return this._token;
    }
    try {
      const { GoogleAuth } = require('google-auth-library');
      const auth = new GoogleAuth({
        keyFile: this.gcpKeyPath,
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
      });
      const client = await auth.getClient();
      const tokenResponse = await client.getAccessToken();
      this._token = tokenResponse.token;
      this._tokenExpiry = Date.now() + 3500000; // 1 hour expiry
      return this._token;
    } catch (e) {
      throw new Error(`Failed to generate GCP access token for Vertex AI: ${e.message}`);
    }
  }

  /**
   * Implements the abstract method from BaseClient.
   * @param {Object} payload - The compressed state from ContextCompressor.
   * @param {Object} outputSchema - The expected JSON schema for the response.
   * @returns {string} The raw string output from the model.
   */
  async _callModelApi(payload, outputSchema) {
    if (!this.gcpKeyPath || !this.projectId) {
      throw new Error("Missing GCP Service Account Key file or project_id. Please set GCP_KEY_PATH in .env");
    }

    const token = await this._getAccessToken();

    // System instruction (camelCase for Vertex AI REST API)
    const systemInstructionText = `You are an AI assistant. Please respond to the user's request. 
      If you need to output structured data, ensure it strictly follows this JSON schema:
      ${JSON.stringify(outputSchema)}
      
      Here is your preferred tool format instruction: ${this.promptMapping ? this.promptMapping.tool_call_template : ''}`;

    // Format payload for Vertex AI (uses camelCase properties)
    const requestBody = {
      contents: [{
        role: "user",
        parts: [{ text: JSON.stringify(payload) }]
      }],
      systemInstruction: {
        parts: [{ text: systemInstructionText }]
      },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: "application/json" // Force JSON output
      }
    };

    // Strip 'vertex/' prefix if present
    let modelId = this.modelCapability.model_id.replace(/^vertex\//, '');

    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${modelId}:generateContent`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const mappedErrorType = errorMapper.map('google', { 
          status: response.status, 
          message: errorData.error?.message || response.statusText 
        });
        
        throw new Error(`[${mappedErrorType}] Vertex AI request failed: ${JSON.stringify(errorData)}`);
      }

      const data = await response.json();
      
      if (!data.candidates || data.candidates.length === 0) {
        throw new Error("Vertex AI returned an empty response.");
      }

      const content = data.candidates[0].content.parts[0].text;
      return content;

    } catch (error) {
      if (error.message.startsWith("[HUB_")) throw error;
      
      const mappedErrorType = errorMapper.map('google', { status: 500, message: error.message });
      throw new Error(`[${mappedErrorType}] Network or execution error on Vertex AI: ${error.message}`);
    }
  }
}

module.exports = VertexAIClient;
