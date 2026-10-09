import express from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { normalizeSearchOptions, runSearch, normalizeSearchQueries, runSearchBatch } from "./search.mjs";
import { createXPostReader, parseXPostUrl } from "./x-post.mjs";
import { createXSearcher, normalizeXSearch } from "./x-search.mjs";
import { readWebPage } from "./web-reader.mjs";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_KEY,
  MODEL_CATALOG,
  PROVIDERS,
  findModel,
  providerFor,
} from "./models.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const app = express();
const port = Number(process.env.PORT) || 3000;
const readXPost = createXPostReader();

app.disable("x-powered-by");
app.use(express.json({ limit: "20mb", strict: true }));

function normalizeSecret(raw) {
  return String(raw || "").trim();
}

function normalizeApiKey(raw) {
  let key = String(raw || "").trim();
  key = key.replace(/^Bearer\s+/i, "").trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

function requestAccessPassword(req) {
  return normalizeSecret(req.body?.access_password || req.get("x-access-password"));
}

function secretsMatch(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  const length = Math.max(leftBuffer.length, rightBuffer.length);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}

function authorizeRequest(req) {
  const configuredPassword = normalizeSecret(process.env.APP_ACCESS_PASSWORD);
  if (!configuredPassword) {
    return { ok: false, reason: "server_configuration" };
  }

  const suppliedPassword = requestAccessPassword(req);
  if (!suppliedPassword) {
    return { ok: false, reason: "missing_password" };
  }
  if (!secretsMatch(suppliedPassword, configuredPassword)) {
    return { ok: false, reason: "invalid_password" };
  }
  return { ok: true };
}

function requestedModel(body = {}) {
  return findModel(body.provider || DEFAULT_MODEL.provider, body.model || DEFAULT_MODEL.id);
}

function providerAccess(providerId) {
  const provider = providerFor(providerId);
  if (!provider) return { ok: false, reason: "unknown_provider" };
  if (providerId === "experientiallabs") return { ok: false, reason: "billing_safety", provider };
  if (providerId === "tokenharbor" && process.env.TOKENHARBOR_FREE_ACCESS_CONFIRMED !== "true") return { ok: false, reason: "tokenharbor_free_unconfirmed", provider };
  if (providerId === "gemini" && process.env.GEMINI_FREE_TIER_CONFIRMED !== "true") return { ok: false, reason: "free_tier_unconfirmed", provider };
  const apiKey = normalizeApiKey(process.env[provider.keyEnv]);
  if (!apiKey) return { ok: false, reason: "provider_configuration", provider };
  return { ok: true, provider, apiKey };
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/thk_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
}

function parseErrorBody(text, status, providerLabel = "OpenRouter") {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  const nested = parsed?.error;
  const message =
    nested?.message ||
    parsed?.message ||
    (text && text.trim()) ||
    `${providerLabel} が HTTP ${status} を返しました。`;

  return {
    message: redactSecrets(message).slice(0, 1200),
    code: nested?.code || parsed?.code || status,
    metadata: nested?.metadata || undefined,
  };
}

function authFailureMessage(reason, provider = null) {
  if (reason === "tokenharbor_free_unconfirmed") return "Token Harborのダッシュボードで無料モデルの利用条件・データ保存条件を確認し無料アクセスを有効化後、RenderにTOKENHARBOR_FREE_ACCESS_CONFIRMED=trueを設定してください。有料モデルへは切り替えません。";
  if (reason === "billing_safety") return "XPLの無料適用を保証できず課金報告があるため、このアプリからの送信を停止しています。XPLの利用履歴・Credits overflow・Waterfallを確認してください。";
  if (reason === "free_tier_unconfirmed") return "GeminiはFree Tierプロジェクトのキーを使用してください。Google AI Studioで確認後、RenderでGEMINI_FREE_TIER_CONFIRMED=trueを設定してください。有料キーを無料へ変更する機能ではありません。";
  if (reason === "server_configuration") {
    return "Renderに APP_ACCESS_PASSWORD と、利用するプロバイダのAPIキーを設定してください。";
  }
  if (reason === "missing_password") {
    return "アクセスパスワードが入力されていません。設定画面から入力してください。";
  }
  if (reason === "provider_configuration") {
    return `${provider?.label || "選択したプロバイダ"} のAPIキー（${provider?.keyEnv || "環境変数"}）がRenderに設定されていません。`;
  }
  if (reason === "unknown_provider") {
    return "指定されたプロバイダは許可されていません。";
  }
  return "アクセスパスワードが正しくありません。Render側の設定を確認してください。";
}

function sendAuthError(res, auth) {
  const serverConfiguration = ["server_configuration", "provider_configuration", "unknown_provider", "billing_safety", "free_tier_unconfirmed", "tokenharbor_free_unconfirmed"].includes(auth.reason);
  return res.status(serverConfiguration ? 503 : 401).json({
    error: {
      message: authFailureMessage(auth.reason, auth.provider),
      code: auth.reason,
    },
    proxy: true,
  });
}

function removeAccessPassword(body) {
  const { access_password: _accessPassword, ...forwarded } = body;
  return forwarded;
}

function adaptProviderBody(provider, body, model = null) {
  const adapted = { ...body };
  const supportsReasoning = model?.supportsReasoning !== false && provider.supportsReasoning !== false;
  const supportsTemperature = model?.supportsTemperature !== false && provider.supportsTemperature !== false;

  if (!supportsReasoning) {
    delete adapted.reasoning;
    delete adapted.reasoning_effort;
  } else if (provider.id !== "gemini" && provider.reasoningParameter === "reasoning_effort" && adapted.reasoning) {
    const enabled = adapted.reasoning.enabled !== false;
    delete adapted.reasoning;
    if (enabled) adapted.reasoning_effort = provider.defaultReasoningEffort || "medium";
  }
  if (!supportsTemperature) delete adapted.temperature;
  if (provider.id === "groq") {
    const enabled = body.reasoning?.enabled === true;
    delete adapted.reasoning; delete adapted.reasoning_effort;
    delete adapted.reasoning_format; delete adapted.include_reasoning;
    if (supportsReasoning && /^openai\/gpt-oss-(?:20b|120b)$/.test(adapted.model)) {
      adapted.reasoning_effort = enabled ? "medium" : "low";
      adapted.include_reasoning = enabled;
    } else if (supportsReasoning && /^qwen\//.test(adapted.model)) {
      adapted.reasoning_effort = enabled ? "medium" : "none";
      adapted.reasoning_format = enabled ? "parsed" : "hidden";
    }
  }
  if (provider.id === "tokenharbor") {
    // Model-default/automatic thinking is distinct from unsupported reasoning.
    // Do not guess gateway controls or discard returned reasoning on tool turns.
    delete adapted.reasoning; delete adapted.reasoning_effort;
    delete adapted.plugins; delete adapted.extra_body; delete adapted.service_tier;
    adapted.messages = (adapted.messages || []).map(message => {
      const { reasoning: _reasoning, reasoning_details: _details, ...rest } = message;
      if (message.role === "assistant" && message.tool_calls?.length && /^(deepseek|mimo)-/.test(adapted.model) && message.reasoning) rest.reasoning_content = message.reasoning;
      return rest;
    });
  }
  if (provider.id === "gemini") {
    delete adapted.reasoning; delete adapted.plugins;
    delete adapted.reasoning_effort;
    delete adapted.service_tier;
    adapted.messages = (adapted.messages || []).map(message => {
      const { reasoning: _reasoning, reasoning_details: _details, ...rest } = message;
      return rest;
    });
    // Gemini rejects reasoning_effort even when thinking_config only requests
    // summaries. Use one configuration path, including OFF/diagnostic requests.
    delete adapted.extra_body;
    if (supportsReasoning) {
      const enabled = body.reasoning?.enabled === true;
      const config = { include_thoughts: enabled };
      if (/^gemini-2\.5-/.test(adapted.model)) {
        config.thinking_budget = !enabled && /^gemini-2\.5-(?:flash|flash-lite)$/.test(adapted.model) ? 0 : 1024;
      } else config.thinking_level = "low";
      adapted.extra_body = { google: { thinking_config: config } };
    }
  }

  // OpenRouter Server Tools only work on OpenRouter. Strip them elsewhere so
  // upstream APIs do not reject the tools array.
  if (provider.id !== "openrouter" && Array.isArray(adapted.tools)) {
    adapted.tools = adapted.tools.filter(
      (tool) => !(tool && typeof tool === "object" && typeof tool.type === "string" && tool.type.startsWith("openrouter:")),
    );
    if (!adapted.tools.length) delete adapted.tools;
    if (!adapted.tools?.length) delete adapted.tool_choice;
  }

  return adapted;
}

async function providerFetch(providerId, endpoint, apiKey, init = {}) {
  const provider = providerFor(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const gatewayHeaders = providerId === "openrouter"
    ? {
        "HTTP-Referer": process.env.PUBLIC_APP_URL || "https://onrender.com",
        "X-Title": "Nemotron Workspace",
      }
    : {};
  return fetch(`${provider.baseUrl}${endpoint}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...gatewayHeaders,
      ...(init.headers || {}),
      Authorization: `Bearer ${apiKey}`,
    },
    signal: init.signal || AbortSignal.timeout(120000),
  });
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    proxy: true,
    keyMode: "password",
    configured: Boolean(normalizeSecret(process.env.APP_ACCESS_PASSWORD)),
    configuredProviders: Object.values(PROVIDERS)
      .filter((provider) => normalizeApiKey(process.env[provider.keyEnv]))
      .map((provider) => provider.id),
    provider: DEFAULT_MODEL.provider,
    model: DEFAULT_MODEL.id,
    service: "Nemotron Workspace",
  });
});

app.get("/api/models", (_req, res) => {
  res.json({
    default: { provider: DEFAULT_MODEL.provider, model: DEFAULT_MODEL.id, key: DEFAULT_MODEL_KEY },
    providers: Object.values(PROVIDERS).map((provider) => ({
      id: provider.id,
      label: provider.label,
      freeLabel: provider.freeLabel,
      docsUrl: provider.docsUrl,
      configured: Boolean(normalizeApiKey(process.env[provider.keyEnv])),
    })),
    models: MODEL_CATALOG.map((entry) => ({
      ...entry,
      providerLabel: PROVIDERS[entry.provider].label,
      configured: Boolean(normalizeApiKey(process.env[PROVIDERS[entry.provider].keyEnv])),
    })),
  });
});

app.post("/api/chat", async (req, res) => {
  const auth = authorizeRequest(req);
  if (!auth.ok) return sendAuthError(res, auth);

  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({
      error: { message: "リクエスト本文が JSON オブジェクトではありません。", code: "invalid_body" },
      proxy: true,
    });
  }

  const selected = requestedModel(req.body);
  if (!selected) {
    return res.status(400).json({
      error: { message: "許可されていないプロバイダまたはモデルです。", code: "invalid_model" },
      proxy: true,
    });
  }
  const access = providerAccess(selected.provider);
  if (!access.ok) return sendAuthError(res, access);

  const forwardedBody = adaptProviderBody(access.provider, {
    ...removeAccessPassword(req.body),
    model: selected.id,
    stream: req.body.stream !== false,
  }, selected);
  delete forwardedBody.provider;
  if (selected.provider !== "openrouter") delete forwardedBody.plugins;

  try {
    const upstream = await providerFetch(selected.provider, "/chat/completions", access.apiKey, {
      method: "POST",
      body: JSON.stringify(forwardedBody),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      const details = parseErrorBody(text, upstream.status, access.provider.label);
      return res.status(upstream.status).json({
        error: details,
        upstream_status: upstream.status,
        proxy: true,
      });
    }

    res.status(upstream.status);
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    );
    res.setHeader("Cache-Control", upstream.headers.get("cache-control") || "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    // Send an SSE comment immediately so proxies flush the stream before the first token.
    res.write(": stream-open\n\n");

    if (upstream.body) {
      Readable.fromWeb(upstream.body).on("error", (error) => {
        if (!res.headersSent) {
          res.status(502);
        }
        res.end();
        console.error(`${access.provider.label} stream error:`, error.message);
      }).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    const isAbort = error?.name === "TimeoutError" || error?.name === "AbortError";
    res.status(502).json({
      error: {
        message: isAbort
          ? `${access.provider.label} への接続がタイムアウトしました。もう一度試してください。`
          : `${access.provider.label} への接続に失敗しました: ${redactSecrets(error?.message || "unknown error")}`,
        code: isAbort ? "upstream_timeout" : "upstream_network_error",
      },
      upstream_status: 502,
      proxy: true,
    });
  }
});

function providerCheckEndpoint(providerId) {
  return providerId === "openrouter" ? "/key" : "/models";
}

async function diagnosticRequest(providerId, endpoint, apiKey, init) {
  const provider = providerFor(providerId);
  try {
    const response = await providerFetch(providerId, endpoint, apiKey, {
      ...init,
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Keep the plain response in detail below.
    }
    return {
      ok: response.ok,
      httpStatus: response.status,
      data,
      detail: response.ok
        ? `${provider.label} から正常な応答を受信しました。`
        : parseErrorBody(text, response.status, provider.label).message,
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      detail: error?.name === "TimeoutError"
        ? `${provider.label} への接続がタイムアウトしました。`
        : `接続エラー: ${redactSecrets(error?.message || "unknown error")}`,
    };
  }
}

app.post("/api/key-check", async (req, res) => {
  const auth = authorizeRequest(req);
  if (!auth.ok) return sendAuthError(res, auth);

  const selected = requestedModel(req.body) || DEFAULT_MODEL;
  const access = providerAccess(selected.provider);
  if (!access.ok) return sendAuthError(res, access);
  const check = await diagnosticRequest(selected.provider, providerCheckEndpoint(selected.provider), access.apiKey, { method: "GET" });
  const payload = { ok: check.ok, data: check.data };
  if (!check.ok) {
    payload.error = { message: check.detail, code: "upstream_error" };
  }
  return res.status(check.ok ? 200 : check.httpStatus || 502).json(payload);
});

app.post("/api/diagnostics", async (req, res) => {
  const auth = authorizeRequest(req);
  const selected = requestedModel(req.body) || DEFAULT_MODEL;
  if (!auth.ok) {
    return res.json({
      ok: false,
      provider: selected.provider,
      model: selected.id,
      steps: [
        {
          id: "access-password",
          label: "アクセスパスワード",
          ok: false,
          httpStatus: auth.reason === "server_configuration" ? 503 : 401,
          detail: authFailureMessage(auth.reason),
        },
      ],
    });
  }

  const access = providerAccess(selected.provider);
  if (!access.ok) {
    return res.json({
      ok: false,
      provider: selected.provider,
      model: selected.id,
      steps: [{
        id: "provider-key",
        label: "プロバイダAPIキー",
        ok: false,
        httpStatus: 503,
        detail: authFailureMessage(access.reason, access.provider),
      }],
    });
  }

  const steps = [];
  const keyCheck = await diagnosticRequest(selected.provider, providerCheckEndpoint(selected.provider), access.apiKey, { method: "GET" });
  steps.push({ id: "key", label: `${access.provider.label}認証`, ...keyCheck });

  if (keyCheck.ok) {
    const generation = await diagnosticRequest(selected.provider, "/chat/completions", access.apiKey, {
      method: "POST",
      body: JSON.stringify(adaptProviderBody(access.provider, {
        model: selected.id,
        messages: [{ role: "user", content: "Reply with only: OK" }],
        max_tokens: 16,
        temperature: 0,
        stream: false,
      }, selected)),
    });
    steps.push({ id: "generation", label: "最小生成", ...generation });

    const toolCalling = await diagnosticRequest(selected.provider, "/chat/completions", access.apiKey, {
      method: "POST",
      body: JSON.stringify(adaptProviderBody(access.provider, {
        model: selected.id,
        messages: [{ role: "user", content: "現在日時ツールを呼び出してください。" }],
        tools: [
          {
            type: "function",
            function: {
              name: "current_datetime",
              description: "現在日時を返す診断用ツール",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        max_tokens: 64,
        temperature: 0,
        stream: false,
      }, selected)),
    });
    steps.push({ id: "tools", label: "Tool Calling", ...toolCalling });
  } else {
    steps.push({
      id: "generation",
      label: "最小生成",
      ok: false,
      httpStatus: null,
      detail: `${access.provider.label}認証が失敗したためスキップしました。`,
    });
    steps.push({
      id: "tools",
      label: "Tool Calling",
      ok: false,
      httpStatus: null,
      detail: `${access.provider.label}認証が失敗したためスキップしました。`,
    });
  }

  res.json({ ok: steps.every((step) => step.ok), provider: selected.provider, model: selected.id, steps });
});

const SEARCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function isJunkSearchUrl(url) {
  const u = String(url || "");
  if (!u || !/^https?:\/\//i.test(u)) return true;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith("duckduckgo.com") && /\/y\.js|\/l\/|\/c\//i.test(parsed.pathname)) return true;
    if (host.endsWith("bing.com") && /\/ck\/|\/aclick/i.test(parsed.pathname)) return true;
    if (/ad_domain|ad_provider|doubleclick|googlesyndication/i.test(u)) return true;
    return false;
  } catch {
    return true;
  }
}

function pushUniqueResult(results, seen, item, maxResults) {
  if (!item || results.length >= maxResults) return false;
  const url = String(item.url || "").trim();
  if (isJunkSearchUrl(url) || seen.has(url)) return false;
  seen.add(url);
  results.push({
    title: String(item.title || url).slice(0, 200),
    url,
    snippet: String(item.snippet || "").slice(0, 500),
  });
  return true;
}

function decodeBingUrl(href) {
  const raw = decodeHtmlEntities(String(href || "").trim());
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) && !/bing\.com\/(ck|aclick)/i.test(raw)) return raw;
  try {
    const url = new URL(raw, "https://www.bing.com");
    const u = url.searchParams.get("u") || "";
    if (!u) return "";
    let encoded = u.replace(/^a1/i, "").replace(/-/g, "+").replace(/_/g, "/");
    while (encoded.length % 4) encoded += "=";
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function cleanCiteUrl(cite) {
  const text = stripHtml(cite).split("›")[0].trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return `https://${text}`;
}

function parseBingHtml(html, maxResults) {
  const results = [];
  const seen = new Set();
  const blocks = String(html || "").split(/class="b_algo"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const h2 = block.match(/<h2[\s\S]*?<\/h2>/i)?.[0] || "";
    const href = h2.match(/href="([^"]+)"/i)?.[1] || "";
    const title = stripHtml(h2.replace(/<a[\s\S]*?<\/a>/i, (m) => m.replace(/^<a[^>]*>|<\/a>$/gi, "")));
    const cite = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i)?.[1] || "";
    const snippet =
      stripHtml(block.match(/class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "")
      || stripHtml(block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "");
    let url = decodeBingUrl(href) || cleanCiteUrl(cite);
    if (!url || isJunkSearchUrl(url)) continue;
    pushUniqueResult(results, seen, { title: title || url, url, snippet }, maxResults);
  }
  return results;
}

function searchLocale(options) {
  const language = options.language || "en";
  const region = options.region === "auto" ? (language === "ja" ? "JP" : "US") : options.region;
  return { language, region, accept: language === "ja" ? "ja,en;q=0.7" : "en,ja;q=0.5" };
}

function ddgSearchParams(query, options) {
  const { language, region } = searchLocale(options);
  const locales = { JP: "jp-jp", US: "us-en", GB: "uk-en", DE: "de-de", FR: "fr-fr", CA: "ca-en", AU: "au-en" };
  const params = new URLSearchParams({ q: query, kl: locales[region], klang: language });
  const range = { day: "d", week: "w", month: "m", year: "y" }[options.time_range];
  if (range) params.set("df", range);
  return params;
}

async function searchViaBing(query, maxResults, options, signal) {
  const { language, region, accept } = searchLocale(options);
  const params = new URLSearchParams({ q: query, setlang: language, cc: region, count: String(maxResults) });
  const days = { day: 1, week: 7, month: 30, year: 365 }[options.time_range];
  if (days) params.set("filters", `ex1:"ez${days === 1 ? 1 : days === 7 ? 2 : days === 30 ? 3 : 4}"`);
  const endpoint = `https://www.bing.com/search?${params}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "User-Agent": SEARCH_UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": accept,
    },
    redirect: "follow",
    signal: signal || AbortSignal.timeout(6500),
  });
  if (!response.ok) throw Object.assign(new Error(`Bing HTTP ${response.status}`), { upstream_status: response.status });
  const html = await response.text();
  return parseBingHtml(html, maxResults);
}

function decodeDdgUrl(href) {
  const raw = decodeHtmlEntities(String(href || "").trim());
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return uddg;
    return url.href;
  } catch {
    return raw;
  }
}

function parseDdgHtml(html, maxResults) {
  const results = [];
  const seen = new Set();
  const blocks = String(html || "").split(/class="result\s+results_links/i).slice(1);
  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const anchor = block.match(/<a\b(?=[^>]*class="[^"]*\bresult__a\b)[^>]*>[\s\S]*?<\/a>/i)?.[0] || "";
    const hrefMatch = anchor.match(/href="([^"]+)"/i);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    if (!hrefMatch) continue;
    const url = decodeDdgUrl(hrefMatch[1]);
    if (isJunkSearchUrl(url)) continue;
    pushUniqueResult(
      results,
      seen,
      { title: stripHtml(anchor || url), url, snippet: stripHtml(snippetMatch?.[1] || "") },
      maxResults,
    );
  }
  return results;
}

function parseDdgLiteHtml(html, maxResults) {
  const results = [];
  const seen = new Set();
  const anchors = [...String(html || "").matchAll(/<a\b(?=[^>]*class="[^"]*\bresult-link\b)[^>]*>[\s\S]*?<\/a>/gi)];
  for (const [index, match] of anchors.entries()) {
    if (results.length >= maxResults) break;
    const href = match[0].match(/href="([^"]+)"/i)?.[1] || "";
    const title = stripHtml(match[0]);
    const following = String(html).slice(match.index + match[0].length, anchors[index + 1]?.index);
    const snippet = stripHtml(following.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i)?.[1] || "");
    const url = decodeDdgUrl(href);
    if (isJunkSearchUrl(url)) continue;
    pushUniqueResult(results, seen, { title: title || url, url, snippet }, maxResults);
  }
  return results;
}

async function searchViaDdgHtml(query, maxResults, options, signal) {
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "User-Agent": SEARCH_UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": searchLocale(options).accept,
    },
    body: ddgSearchParams(query, options).toString(),
    redirect: "follow",
    signal: signal || AbortSignal.timeout(6500),
  });
  if (!response.ok) throw Object.assign(new Error(`DuckDuckGo HTML HTTP ${response.status}`), { upstream_status: response.status });
  const html = await response.text();
  if (/anomaly|challenge|captcha/i.test(html) && !/result__a/i.test(html)) {
    throw new Error("DuckDuckGo HTML returned a challenge page");
  }
  return parseDdgHtml(html, maxResults);
}

async function searchViaDdgLite(query, maxResults, options, signal) {
  const endpoint = `https://lite.duckduckgo.com/lite/?${ddgSearchParams(query, options)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { "User-Agent": SEARCH_UA, Accept: "text/html" },
    redirect: "follow",
    signal: signal || AbortSignal.timeout(6500),
  });
  if (!response.ok) throw Object.assign(new Error(`DuckDuckGo Lite HTTP ${response.status}`), { upstream_status: response.status });
  const html = await response.text();
  return parseDdgLiteHtml(html, maxResults);
}


const SEARCH_BACKENDS = [
  { id: "bing", label: "Bing", run: searchViaBing },
  { id: "duckduckgo-html", label: "DuckDuckGo HTML", run: searchViaDdgHtml },
  { id: "duckduckgo-lite", label: "DuckDuckGo Lite", run: searchViaDdgLite },
];


function extractReadableText(html, maxChars) {
  let text = String(html || "");
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripHtml(titleMatch?.[1] || "").slice(0, 200);
  text = text
    .replace(/<\/(p|div|section|article|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n…[truncated]";
  return { title, text };
}

function isPrivateOrLocalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return true;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return true;
    }
    // Block obvious private IPv4 ranges.
    const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

app.post("/api/web-search", async (req, res) => {
  const auth = authorizeRequest(req);
  if (!auth.ok) return sendAuthError(res, auth);

  let queries;
  try { queries = normalizeSearchQueries(req.body); }
  catch (error) {
    return res.status(400).json({
      error: { message: error.message, code: "invalid_query" },
      proxy: true,
    });
  }
  const query = queries[0];
  const maxResults = Math.floor(Math.min(Math.max(Number(req.body?.max_results) || 5, 1), 10));
  let options;
  try { options = normalizeSearchOptions(req.body, query); }
  catch (error) {
    return res.status(400).json({ error: { message: error.message, code: "invalid_search_filter" }, proxy: true });
  }

  try {
    if (req.body.queries !== undefined) {
      const result = await runSearchBatch(queries, q => runSearch(SEARCH_BACKENDS, q, maxResults, normalizeSearchOptions(req.body, q)));
      return res.json({ ...result, warnings: result.warnings.map(redactSecrets), retrieved_at: new Date().toISOString() });
    }
    const { results, provider, errors, ...metadata } = await runSearch(SEARCH_BACKENDS, query, maxResults, options);
    return res.json({
      ok: true,
      query,
      provider,
      results,
      count: results.length,
      ...metadata,
      warnings: errors.map(error => redactSecrets(error)),
      retrieved_at: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(502).json({
      error: {
        message: `Web検索に失敗しました: ${redactSecrets(error?.message || "unknown error")}`,
        code: "web_search_failed",
        retryable: error.retryable, backend_failures: error.backend_failures,
        details: error?.details?.map(detail => redactSecrets(detail)),
      },
      proxy: true,
    });
  }
});

async function sendXPost(req, res) {
  try { parseXPostUrl(req.body?.url); }
  catch (error) { return res.status(400).json({ error: { message: error.message, code: "invalid_x_post_url" }, proxy: true }); }
  try { return res.json(await readXPost(req.body.url)); }
  catch (error) { return res.status(502).json({ error: { message: redactSecrets(error.message), code: "x_post_unavailable" }, proxy: true }); }
}

const searchX = createXSearcher();
app.post("/api/x-search", async (req, res) => {
  const auth = authorizeRequest(req);
  if (!auth.ok) return sendAuthError(res, auth);
  try { normalizeXSearch(req.body); }
  catch (error) { return res.status(400).json({ error: { message: error.message, code: "invalid_x_query" }, proxy: true }); }
  try {
    return res.json(await searchX(req.body, { enabled: process.env.X_SEARCH_ENABLED === "true", bearerToken: normalizeSecret(process.env.X_BEARER_TOKEN) }));
  } catch (error) {
    return res.status(error.status || 502).json({ error: { message: redactSecrets(error.message), code: error.code || "x_search_failed" }, proxy: true });
  }
});

app.post("/api/x-post", async (req, res) => {
  const auth = authorizeRequest(req);
  if (!auth.ok) return sendAuthError(res, auth);
  return sendXPost(req, res);
});

app.post("/api/web-fetch", async (req, res) => {
  const auth = authorizeRequest(req);
  if (!auth.ok) return sendAuthError(res, auth);

  const url = String(req.body?.url || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({
      error: { message: "Valid http(s) url is required", code: "invalid_url" },
      proxy: true,
    });
  }
  if (isPrivateOrLocalUrl(url)) {
    return res.status(400).json({
      error: { message: "Local or private URLs cannot be fetched", code: "blocked_url" },
      proxy: true,
    });
  }
  const maxChars = Math.min(Math.max(Number(req.body?.max_chars) || 12000, 500), 50000);
  // X's ordinary HTML is a login/JS shell; public post URLs need structured data.
  try { parseXPostUrl(url); return sendXPost(req, res); } catch { /* Ordinary page. */ }

  try {
    const response = await readWebPage(url, {
      validateUrl: target => { if (isPrivateOrLocalUrl(target)) throw Object.assign(new Error("Local or private URLs cannot be fetched"), { code: "blocked_url" }); },
      headers: {
        "User-Agent": SEARCH_UA,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
      },
    });
    const { contentType, raw } = response;

    let title = "";
    let content = "";
    if (/text\/html|application\/xhtml/i.test(contentType) || /<html[\s>]/i.test(raw.slice(0, 2000))) {
      const extracted = extractReadableText(raw, maxChars);
      title = extracted.title;
      content = extracted.text;
    } else {
      content = raw.slice(0, maxChars);
    }

    return res.json({
      ok: true,
      url,
      title,
      content,
      content_type: contentType,
      status: response.status,
      final_url: response.final_url, attempts: response.attempts,
      retrieved_at: new Date().toISOString(),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return res.status(502).json({
      error: {
        message: timedOut
          ? "URLの取得がタイムアウトしました。"
          : `URLの取得に失敗しました: ${redactSecrets(error?.message || "unknown error")}`,
        code: error.code || (timedOut ? "web_fetch_timeout" : "web_fetch_failed"),
        upstream_status: error.upstream_status, network_code: error.network_code,
        retryable: error.retryable, attempts: error.attempts, next_action: error.next_action,
      },
      url,
      proxy: true,
    });
  }
});

app.use(express.static(publicDir, { extensions: ["html"] }));

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      error: { message: "リクエストが大きすぎます。", code: "payload_too_large" },
      proxy: true,
    });
  }
  console.error(error);
  return res.status(500).json({
    error: { message: "サーバー内部でエラーが発生しました。", code: "server_error" },
    proxy: true,
  });
});

app.listen(port, () => {
  console.log(`Nemotron Workspace listening on port ${port}`);
});
