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
        limits: { rpm: 50, tpm: 100000 },
        input_cost_per_1k: 0.0001,
        output_cost_per_1k: 0.0001
      },
      {
        model_id: "gemini-2.5-flash",
        provider: "google",
        context_window: 1000000,
        supported_modalities: ["text", "vision", "audio", "tool_use"],
        performance_tier: "base",
        limits: { rpm: 15, tpm: 1000000 },
        input_cost_per_1k: 0.000075,
        output_cost_per_1k: 0.0003
      },
      {
        model_id: "vertex/gemini-2.5-flash",
        provider: "vertex-ai",
        context_window: 1000000,
        supported_modalities: ["text", "vision", "audio", "tool_use"],
        performance_tier: "base",
        limits: { rpm: 60, tpm: 1000000 },
        input_cost_per_1k: 0.000075,
        output_cost_per_1k: 0.0003
      },
      // Note: Gemini 1.5 Flash models are de-prioritized to avoid outdated knowledge bases
      {
        model_id: "deepseek-chat",
        provider: "deepseek",
        context_window: 64000,
        supported_modalities: ["text", "tool_use"],
        performance_tier: "high",
        limits: { rpm: 100, tpm: 100000 },
        input_cost_per_1k: 0.00014,
        output_cost_per_1k: 0.00028
      },
      {
        model_id: "vertex/gemini-2.5-pro",
        provider: "vertex-ai",
        context_window: 1000000,
        supported_modalities: ["text", "vision", "audio", "tool_use"],
        performance_tier: "high",
        limits: { rpm: 60, tpm: 1000000 },
        input_cost_per_1k: 0.00125,
        output_cost_per_1k: 0.005
      },
      {
        model_id: "vertex/gemini-1.5-pro-002",
        provider: "vertex-ai",
        context_window: 1000000,
        supported_modalities: ["text", "vision", "audio", "tool_use"],
        performance_tier: "high",
        limits: { rpm: 60, tpm: 1000000 },
        input_cost_per_1k: 0.00125,
        output_cost_per_1k: 0.005
      },
      {
        model_id: "meta/llama-3.1-70b-instruct",
        provider: "nvidia-nim",
        context_window: 128000,
        supported_modalities: ["text", "tool_use"],
        performance_tier: "high",
        limits: { rpm: 50, tpm: 50000 },
        input_cost_per_1k: 0.0007,
        output_cost_per_1k: 0.0009
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
