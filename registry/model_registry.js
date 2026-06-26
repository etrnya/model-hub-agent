/**
 * ModelRegistry
 * Central repository of available models and their capabilities.
 */
class ModelRegistry {
  constructor() {
    this.models = [
      {
        model_id: "meta/llama-3.1-8b-instruct",
        provider: "nvidia-nim",
        context_window: 128000,
        supported_modalities: ["text"],
        performance_tier: "low",
        limits: { rpm: 50, tpm: 100000 }
      },
      {
        model_id: "gemini-2.5-flash",
        provider: "google",
        context_window: 1000000,
        supported_modalities: ["text", "vision", "audio", "tool_use"],
        performance_tier: "base",
        limits: { rpm: 15, tpm: 1000000 }
      },
      {
        model_id: "deepseek-chat",
        provider: "deepseek",
        context_window: 64000,
        supported_modalities: ["text", "tool_use"],
        performance_tier: "high",
        limits: { rpm: 100, tpm: 100000 }
      },
      {
        model_id: "meta/llama-3.1-70b-instruct",
        provider: "nvidia-nim",
        context_window: 128000,
        supported_modalities: ["text", "tool_use"],
        performance_tier: "high",
        limits: { rpm: 50, tpm: 50000 }
      }
    ];
  }

  getModelsByCapability(requiredModalities = []) {
    return this.models.filter(m => 
      requiredModalities.every(mod => m.supported_modalities.includes(mod))
    );
  }

  getModelById(id) {
    return this.models.find(m => m.model_id === id);
  }
}

module.exports = new ModelRegistry();
