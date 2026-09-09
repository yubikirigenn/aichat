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

function adaptProviderBody(provider, body) {
  const adapted = { ...body };
  if (provider.supportsReasoning === false) {
    delete adapted.reasoning;
  } else if (provider.reasoningParameter === "reasoning_effort" && adapted.reasoning) {
    const enabled = adapted.reasoning.enabled !== false;
    delete adapted.reasoning;
    if (enabled) adapted.reasoning_effort = provider.defaultReasoningEffort || "medium";
  }
  if (provider.supportsTemperature === false) delete adapted.temperature;
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
  });
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
      })),
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
      })),
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
