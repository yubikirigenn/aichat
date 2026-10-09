// Curated snapshot checked on 2026-10-09 (JST).
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
  experientiallabs: Object.freeze({
    id: "experientiallabs",
    label: "Experiential Labs",
    baseUrl: "https://api.experientiallabs.ai/v1",
    keyEnv: "EXPERIENTIAL_LABS_API_KEY",
    supportsReasoning: true,
    reasoningParameter: "reasoning_effort",
    defaultReasoningEffort: "medium",
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

// Active public free promotions, checked on 2026-10-09 (JST).
// Paid-plan discounts and non-chat decision APIs are excluded.
// Older daily tiers are not present in current model routes/promotion data.
const EXPERIENTIAL_FREE_MODELS = Object.freeze([
  {
    id: "qwen3.8-flash-next-uncensored",
    name: "Qwen3.8 Flash Next Uncensored",
    vision: false,
    supportsTools: true,
    supportsReasoning: true,
    supportsTemperature: true,
    freeLabel: "FREE promo",
    note: "無料プロモーション。時間・日次上限あり。画像非対応。上限後の課金はXPLのCredits overflow設定によります。",
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
  model("groq", "qwen/qwen3.8-27b", "Qwen3.8 27B", { vision: true }),

  // Experiential Labs active free chat promotion.
  ...EXPERIENTIAL_MODEL_CATALOG,

  // OpenRouter zero-priced text-generation endpoints checked on 2026-10-09.
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
