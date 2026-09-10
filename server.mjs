import express from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
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
  const apiKey = normalizeApiKey(process.env[provider.keyEnv]);
  if (!apiKey) return { ok: false, reason: "provider_configuration", provider };
  return { ok: true, provider, apiKey };
}

function redactSecrets(value) {
  return String(value || "")
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
  const serverConfiguration = ["server_configuration", "provider_configuration", "unknown_provider"].includes(auth.reason);
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
  } else if (provider.reasoningParameter === "reasoning_effort" && adapted.reasoning) {
    const enabled = adapted.reasoning.enabled !== false;
    delete adapted.reasoning;
    if (enabled) adapted.reasoning_effort = provider.defaultReasoningEffort || "medium";
  }
  if (!supportsTemperature) delete adapted.temperature;

  // OpenRouter Server Tools only work on OpenRouter. Strip them elsewhere so
  // upstream APIs do not reject the tools array.
  if (provider.id !== "openrouter" && Array.isArray(adapted.tools)) {
    adapted.tools = adapted.tools.filter(
      (tool) => !(tool && typeof tool === "object" && typeof tool.type === "string" && tool.type.startsWith("openrouter:")),
    );
    if (!adapted.tools.length) delete adapted.tools;
    delete adapted.tool_choice;
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

function decodeDdgUrl(href) {
  const raw = String(href || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/") {
      return raw;
    }
    return raw;
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
    const hrefMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/i)
      || block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/i);
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    if (!hrefMatch) continue;
    const url = decodeDdgUrl(hrefMatch[1]);
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: stripHtml(titleMatch?.[1] || url),
      url,
      snippet: stripHtml(snippetMatch?.[1] || "").slice(0, 500),
    });
  }
  return results;
}

async function duckduckgoSearch(query, maxResults) {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "User-Agent": SEARCH_UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);
  }
  const results = parseDdgHtml(html, maxResults);
  if (!results.length) {
    // Fallback: Instant Answer API (limited but sometimes useful).
    const ia = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": SEARCH_UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) },
    );
    if (ia.ok) {
      const data = await ia.json();
      if (data.AbstractText && data.AbstractURL) {
        results.push({
          title: data.Heading || query,
          url: data.AbstractURL,
          snippet: String(data.AbstractText).slice(0, 500),
        });
      }
      for (const topic of data.RelatedTopics || []) {
        if (results.length >= maxResults) break;
        if (topic?.FirstURL && topic?.Text) {
          results.push({ title: String(topic.Text).slice(0, 120), url: topic.FirstURL, snippet: String(topic.Text).slice(0, 400) });
        }
      }
    }
  }
  return results.slice(0, maxResults);
}

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

  const query = String(req.body?.query || "").trim();
  if (!query) {
    return res.status(400).json({
      error: { message: "query is required", code: "invalid_query" },
      proxy: true,
    });
  }
  const maxResults = Math.min(Math.max(Number(req.body?.max_results) || 5, 1), 10);

  try {
    const results = await duckduckgoSearch(query, maxResults);
    return res.json({
      ok: true,
      query,
      provider: "duckduckgo",
      results,
      count: results.length,
      retrieved_at: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(502).json({
      error: {
        message: `Web検索に失敗しました: ${redactSecrets(error?.message || "unknown error")}`,
        code: "web_search_failed",
      },
      proxy: true,
    });
  }
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

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": SEARCH_UA,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
    });
    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();
    if (!response.ok) {
      return res.status(502).json({
        error: {
          message: `Fetch failed: HTTP ${response.status}`,
          code: "web_fetch_failed",
        },
        url,
        status: response.status,
        proxy: true,
      });
    }

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
      retrieved_at: new Date().toISOString(),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return res.status(502).json({
      error: {
        message: timedOut
          ? "URLの取得がタイムアウトしました。"
          : `URLの取得に失敗しました: ${redactSecrets(error?.message || "unknown error")}`,
        code: timedOut ? "web_fetch_timeout" : "web_fetch_failed",
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
