import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const app = express();
const port = Number(process.env.PORT) || 3000;
const model = "nvidia/nemotron-3-ultra-550b-a55b:free";
const openRouterBase = "https://openrouter.ai/api/v1";

app.disable("x-powered-by");
app.use(express.json({ limit: "20mb", strict: true }));

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

function requestApiKey(req) {
  return normalizeApiKey(req.get("x-openrouter-key"));
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
}

function parseErrorBody(text, status) {
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
    `OpenRouter が HTTP ${status} を返しました。`;

  return {
    message: redactSecrets(message).slice(0, 1200),
    code: nested?.code || parsed?.code || status,
    metadata: nested?.metadata || undefined,
  };
}

function sendMissingClientKeyError(res) {
  return res.status(401).json({
    error: {
      message: "APIキーが入力されていません。設定画面から各自の OpenRouter APIキーを入力してください。",
      code: "missing_client_api_key",
    },
    proxy: true,
  });
}

async function openRouterFetch(endpoint, apiKey, init = {}) {
  return fetch(`${openRouterBase}${endpoint}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_APP_URL || "https://onrender.com",
      "X-Title": "Nemotron Workspace",
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
    keyMode: "per_user",
    acceptsClientKey: true,
    model,
    service: "Nemotron Workspace",
  });
});

app.post("/api/chat", async (req, res) => {
  const apiKey = requestApiKey(req);
  if (!apiKey) {
    return sendMissingClientKeyError(res);
  }

  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({
      error: { message: "リクエスト本文が JSON オブジェクトではありません。", code: "invalid_body" },
      proxy: true,
    });
  }

  const forwardedBody = {
    ...req.body,
    model,
    stream: req.body.stream !== false,
  };

  try {
    const upstream = await openRouterFetch("/chat/completions", apiKey, {
      method: "POST",
      body: JSON.stringify(forwardedBody),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      const details = parseErrorBody(text, upstream.status);
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

    if (upstream.body) {
      Readable.fromWeb(upstream.body).on("error", (error) => {
        if (!res.headersSent) {
          res.status(502);
        }
        res.end();
        console.error("OpenRouter stream error:", error.message);
      }).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    const isAbort = error?.name === "TimeoutError" || error?.name === "AbortError";
    res.status(502).json({
      error: {
        message: isAbort
          ? "OpenRouter への接続がタイムアウトしました。もう一度試してください。"
          : `OpenRouter への接続に失敗しました: ${redactSecrets(error?.message || "unknown error")}`,
        code: isAbort ? "upstream_timeout" : "upstream_network_error",
      },
      upstream_status: 502,
      proxy: true,
    });
  }
});

async function diagnosticRequest(endpoint, apiKey, init) {
  try {
    const response = await openRouterFetch(endpoint, apiKey, {
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
        ? "OpenRouter から正常な応答を受信しました。"
        : parseErrorBody(text, response.status).message,
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      detail: error?.name === "TimeoutError"
        ? "OpenRouter への接続がタイムアウトしました。"
        : `接続エラー: ${redactSecrets(error?.message || "unknown error")}`,
    };
  }
}

app.post("/api/key-check", async (req, res) => {
  const apiKey = requestApiKey(req);
  if (!apiKey) {
    return sendMissingClientKeyError(res);
  }

  const check = await diagnosticRequest("/key", apiKey, { method: "GET" });
  const payload = { ok: check.ok, data: check.data };
  if (!check.ok) {
    payload.error = { message: check.detail, code: "upstream_error" };
  }
  return res.status(check.ok ? 200 : check.httpStatus || 502).json(payload);
});

app.post("/api/diagnostics", async (req, res) => {
  const apiKey = requestApiKey(req);
  if (!apiKey) {
    return res.json({
      ok: false,
      model,
      steps: [
        {
          id: "client-key",
          label: "APIキー入力",
          ok: false,
          httpStatus: null,
          detail: "設定画面からAPIキーを入力してください。",
        },
      ],
    });
  }

  const steps = [];
  const keyCheck = await diagnosticRequest("/key", apiKey, { method: "GET" });
  steps.push({ id: "key", label: "APIキー認証", ...keyCheck });

  if (keyCheck.ok) {
    const generation = await diagnosticRequest("/chat/completions", apiKey, {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with only: OK" }],
        max_tokens: 16,
        temperature: 0,
        stream: false,
      }),
    });
    steps.push({ id: "generation", label: "最小生成", ...generation });

    const toolCalling = await diagnosticRequest("/chat/completions", apiKey, {
      method: "POST",
      body: JSON.stringify({
        model,
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
      }),
    });
    steps.push({ id: "tools", label: "Tool Calling", ...toolCalling });
  } else {
    steps.push({
      id: "generation",
      label: "最小生成",
      ok: false,
      httpStatus: null,
      detail: "APIキー認証が失敗したためスキップしました。",
    });
    steps.push({
      id: "tools",
      label: "Tool Calling",
      ok: false,
      httpStatus: null,
      detail: "APIキー認証が失敗したためスキップしました。",
    });
  }

  res.json({ ok: steps.every((step) => step.ok), model, steps });
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
