// Curated snapshot checked on 2026-09-06 (JST).
// "Free" means a provider free plan/offer or an OpenRouter :free endpoint.
// Availability and rate limits can change; the server still validates every
// provider/model pair against this allowlist before forwarding a request.

export const PROVIDERS = Object.freeze({
  groq: Object.freeze({
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    freeLabel: "Free plan枠",
    docsUrl: "https://console.groq.com/docs/rate-limits",
  }),
  bai: Object.freeze({
    id: "bai",
    label: "B.AI",
    baseUrl: "https://api.b.ai/v1",
    keyEnv: "BAI_API_KEY",
    freeLabel: "API 0 Credits",
    docsUrl: "https://docs.b.ai/llmservice/promotions-and-pricing-notices/",
  }),
  experientiallabs: Object.freeze({
    id: "experientiallabs",
    label: "Experiential Labs",
    baseUrl: "https://api.experientiallabs.ai/v1",
    keyEnv: "EXPERIENTIAL_LABS_API_KEY",
    freeLabel: "Free catalog",
    docsUrl: "https://platform.experientiallabs.ai/models",
  }),
  openrouter: Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    freeLabel: ":free endpoint",
    docsUrl: "https://openrouter.ai/docs/guides/routing/model-variants/free",
  }),
});

function model(provider, id, name, options = {}) {
  return Object.freeze({
    key: `${provider}:${id}`,
    provider,
    id,
    name,
    vision: Boolean(options.vision),
    inputModalities: options.inputModalities || (options.vision ? ["text", "image"] : ["text"]),
    outputModalities: options.outputModalities || ["text"],
    supportsTools: options.supportsTools !== false,
    freeLabel: options.freeLabel || PROVIDERS[provider].freeLabel,
    note: options.note || "",
  });
}

export const MODEL_CATALOG = Object.freeze([
  // Groq Free Plan Limits: chat-capable models from the current catalog.
  model("groq", "openai/gpt-oss-120b", "GPT OSS 120B"),
  model("groq", "openai/gpt-oss-20b", "GPT OSS 20B"),
  model("groq", "openai/gpt-oss-safeguard-20b", "GPT OSS Safeguard 20B", { supportsTools: false }),
  model("groq", "qwen/qwen3.6-27b", "Qwen3.6 27B", { vision: true }),
  model("groq", "qwen/qwen3.8-27b", "Qwen3.8 27B", { vision: true }),
  model("groq", "groq/compound", "Groq Compound"),
  model("groq", "groq/compound-mini", "Groq Compound Mini"),

  // B.AI's current 0-Credit API offers.
  model("bai", "glm-5.3-flash", "GLM-5.3 Flash", { vision: true }),
  model("bai", "qwen3.8-flash", "Qwen3.8 Flash", { vision: true }),
  model("bai", "mimo-v2.5", "MiMo-V2.5", { vision: true }),

  // Experiential Labs catalog entries marked free on 2026-09-06.
  model("experientiallabs", "claude-fable-5.1", "Claude Fable 5.1", { vision: true }),
  model("experientiallabs", "deepseek-v4-flash", "DeepSeek V4 Flash", { supportsTools: true }),
  model("experientiallabs", "gpt-5.6-luna", "GPT-5.6 Luna", { vision: true }),
  model("experientiallabs", "gpt-6-astra", "GPT-6 Astra", { vision: true }),
  model("experientiallabs", "qwen3.8-27b", "Qwen3.8 27B", { vision: true }),

  // OpenRouter Models API snapshot: zero-priced chat endpoints.
  model("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", "NVIDIA Nemotron 3 Ultra", { supportsTools: true }),
  model("openrouter", "openrouter/free", "Free Models Router", { vision: true }),
  model("openrouter", "inclusionai/ling-3.0-flash-sante:free", "Ling 3.0 Flash Sante", { supportsTools: true }),
  model("openrouter", "inclusionai/ling-3.0-flash-fin:free", "Ling 3.0 Flash Fin", { supportsTools: true }),
  model("openrouter", "dots-studio/dots-3-note-preview:free", "Dots3 Note Preview", { vision: true }),
  model("openrouter", "liquid/lfm-2.5-2.6b:free", "LFM2.5 2.6B"),
  model("openrouter", "nvidia/nemotron-3.5-lightning:free", "NVIDIA Nemotron 3.5 Lightning"),
  model("openrouter", "thinkingmachines/inkling-small:free", "Inkling Small", { vision: true }),
  model("openrouter", "poolside/laguna-s-2.1:free", "Laguna S 2.1"),
  model("openrouter", "thinkingmachines/inkling:free", "Inkling", { vision: true }),
  model("openrouter", "poolside/laguna-xs-2.1:free", "Laguna XS 2.1"),
  model("openrouter", "cohere/north-mini-code:free", "Cohere North Mini Code"),
  model("openrouter", "z-ai/glm-5.2:free", "GLM 5.2"),
  model("openrouter", "nvidia/nemotron-3.5-content-safety:free", "NVIDIA Nemotron 3.5 Content Safety", { vision: true, supportsTools: false }),
  model("openrouter", "minimax/minimax-m3:free", "MiniMax M3", { vision: true }),
  model("openrouter", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "NVIDIA Nemotron 3 Nano Omni", { vision: true }),
  model("openrouter", "google/gemma-4-26b-a4b-it:free", "Gemma 4 26B", { vision: true }),
  model("openrouter", "google/gemma-4-31b-it:free", "Gemma 4 31B", { vision: true }),
  model("openrouter", "minimax/minimax-m2.7:free", "MiniMax M2.7"),
  model("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", "NVIDIA Nemotron 3 Super"),
]);

export const DEFAULT_MODEL = MODEL_CATALOG.find(
  (entry) => entry.provider === "openrouter" && entry.id === "nvidia/nemotron-3-ultra-550b-a55b:free",
);
export const DEFAULT_MODEL_KEY = DEFAULT_MODEL.key;

export function findModel(providerId, modelId) {
  return MODEL_CATALOG.find((entry) => entry.provider === providerId && entry.id === modelId) || null;
}

export function providerFor(providerId) {
  return PROVIDERS[providerId] || null;
}
