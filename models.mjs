// Curated snapshot checked on 2026-10-04 (JST).
// "Free" means a current zero-priced promotion/tier or OpenRouter zero-priced endpoint.
// Availability and rate limits can change; the server still validates every
// provider/model pair against this allowlist before forwarding a request.

export const PROVIDERS = Object.freeze({
  groq: Object.freeze({
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    supportsReasoning: false,
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
    supportsReasoning: true,
    reasoningParameter: "reasoning_effort",
    defaultReasoningEffort: "high",
    freeLabel: "FREE",
    docsUrl: "https://platform.experientiallabs.ai/models",
  }),
  openrouter: Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    freeLabel: "FREE",
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
    supportsReasoning: options.supportsReasoning !== false,
    supportsTemperature: options.supportsTemperature !== false,
    freeLabel: options.freeLabel || PROVIDERS[provider].freeLabel,
    note: options.note || "",
  });
}

// Experiential Labs free chat models checked on 2026-10-04 (JST).
// The public catalog's current promotional list includes four chat-capable models;
// Jev is excluded because Experiential documents it as a non-chat decision API.
// The two daily free tiers have account eligibility and rate limits.
const EXPERIENTIAL_FREE_MODELS = Object.freeze([
  {
    id: "glm-5.3-flash-abliterated",
    name: "GLM-5.3 Flash Abliterated",
    vision: true,
    supportsTools: true,
    supportsReasoning: true,
    supportsTemperature: true,
    freeLabel: "FREE promo",
    note: "Listed as a free promotion in the current Experiential Labs model catalog; caps and availability may change.",
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    vision: true,
    supportsTools: true,
    supportsReasoning: true,
    supportsTemperature: true,
    freeLabel: "FREE promo",
    note: "Listed at $0 during the current Experiential Labs promotion; availability may change.",
  },
  {
    id: "qwen3.8-27b",
    name: "Qwen3.8 27B",
    vision: true,
    supportsTools: true,
    supportsReasoning: true,
    supportsTemperature: true,
    freeLabel: "FREE promo",
    note: "Listed at $0 during the current Experiential Labs promotion; availability may change.",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    vision: false,
    supportsTools: true,
    supportsReasoning: true,
    supportsTemperature: true,
    freeLabel: "FREE promo",
    note: "Listed at $0 during the current Experiential Labs promotion; availability may change.",
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra (daily tier)",
    vision: true,
    supportsTools: true,
    supportsReasoning: true,
    supportsTemperature: false,
    freeLabel: "FREE daily*",
    note: "Daily free tier requires a saved card and one settled $1+ charge; hourly and daily token allowances apply.",
  },
  {
    id: "claude-fable-5.1",
    name: "Claude Fable 5.1 (daily tier)",
    vision: true,
    supportsTools: true,
    supportsReasoning: true,
    supportsTemperature: false,
    freeLabel: "FREE daily*",
    note: "Daily free tier requires a saved card and one settled $1+ charge; hourly and daily token allowances apply.",
  },
]);

const EXPERIENTIAL_MODEL_CATALOG = EXPERIENTIAL_FREE_MODELS.map(
  ({ id, name, ...options }) => model("experientiallabs", id, name, options),
);

const OPENROUTER_FREE_MODELS = Object.freeze([
  ["apodex/apodex-1.1-mini:free", "Apodex 1.1 Mini", {}],
  ["cohere/north-mini-code:free", "Cohere North Mini Code", {}],
  ["dots-studio/dots-3-note-preview:free", "Dots3 Note Preview", {
    vision: true,
    freeLabel: "FREE · 12/31",
    note: "OpenRouter model API lists this free endpoint through 2026-12-31.",
  }],
  ["google/gemma-4-26b-a4b-it:free", "Gemma 4 26B A4B", { vision: true }],
  ["google/gemma-4-31b-it:free", "Gemma 4 31B", { vision: true }],
  ["inclusionai/ling-3.0-flash-sante:free", "Ling 3.0 Flash Sante", {}],
  ["inclusionai/ling-3.1-flash", "Ling 3.1 Flash", {}],
  ["liquid/lfm-2.5-2.6b:free", "LFM2.5 2.6B", {}],
  ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "NVIDIA Nemotron 3 Nano Omni", { vision: true }],
  ["nvidia/nemotron-3-super-120b-a12b:free", "NVIDIA Nemotron 3 Super", {}],
  ["nvidia/nemotron-3-ultra-550b-a55b:free", "NVIDIA Nemotron 3 Ultra", {}],
  ["nvidia/nemotron-3.5-content-safety:free", "NVIDIA Nemotron 3.5 Content Safety", {
    vision: true,
    supportsTools: false,
  }],
  ["nvidia/nemotron-3.5-lightning:free", "NVIDIA Nemotron 3.5 Lightning", {}],
  ["openrouter/free", "Free Models Router", { vision: true }],
  ["poolside/laguna-s-2.1:free", "Laguna S 2.1", {
    freeLabel: "FREE · 10/31",
    note: "OpenRouter model API lists this free endpoint through 2026-10-31.",
  }],
  ["poolside/laguna-xs-2.1:free", "Laguna XS 2.1", {
    freeLabel: "FREE · 10/31",
    note: "OpenRouter model API lists this free endpoint through 2026-10-31.",
  }],
  ["qwen/qwen3.8-27b:free", "Qwen3.8 27B", { vision: true }],
  ["stealth/space-bunny-alpha", "Space Bunny Alpha", {
    vision: true,
    freeLabel: "FREE · 10/05",
    note: "OpenRouter model API lists this free preview through 2026-10-05.",
  }],
  ["thinkingmachines/inkling:free", "Inkling", { vision: true }],
  ["thinkingmachines/inkling-small:free", "Inkling Small", { vision: true }],
]);

const OPENROUTER_MODEL_CATALOG = OPENROUTER_FREE_MODELS.map(
  ([id, name, options]) => model("openrouter", id, name, options),
);

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

  // Experiential Labs promotional models and documented daily free tiers.
  ...EXPERIENTIAL_MODEL_CATALOG,

  // OpenRouter zero-priced text-generation endpoints checked on 2026-10-04.
  ...OPENROUTER_MODEL_CATALOG,
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
