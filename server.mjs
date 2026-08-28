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

function hasApiKey() {
  return Boolean(String(process.env.OPENROUTER_API_KEY || "").trim());
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

function sendServerConfigurationError(res) {
  return res.status(503).json({
    error: {
      message:
        "Render 側に OPENROUTER_API_KEY が設定されていません。Environment Variables を確認してください。",
      code: "missing_api_key",
    },
    proxy: true,
  });
}

async function openRouterFetch(endpoint, init = {}) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
  return fetch(`${openRouterBase}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_APP_URL || "https://onrender.com",
      "X-Title": "Nemotron Workspace",
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(120000),
  });
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    proxy: true,
    configured: hasApiKey(),
    model,
    service: "Nemotron Workspace",
  });
});

app.post("/api/chat", async (req, res) => {
  if (!hasApiKey()) {
    return sendServerConfigurationError(res);
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
    const upstream = await openRouterFetch("/chat/completions", {
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

async function diagnosticRequest(endpoint, init) {
  try {
    const response = await openRouterFetch(endpoint, {
      ...init,
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      httpStatus: response.status,
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

app.post("/api/diagnostics", async (_req, res) => {
  if (!hasApiKey()) {
    return res.status(503).json({
      ok: false,
      model,
      steps: [
        {
          id: "config",
          label: "Render 環境変数",
          ok: false,
          httpStatus: null,
          detail:
            "OPENROUTER_API_KEY が未設定です。Render の Environment Variables に追加してください。",
        },
      ],
    });
  }

  const steps = [];
  const keyCheck = await diagnosticRequest("/key", { method: "GET" });
  steps.push({ id: "key", label: "APIキー認証", ...keyCheck });

  if (keyCheck.ok) {
    const generation = await diagnosticRequest("/chat/completions", {
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

    const toolCalling = await diagnosticRequest("/chat/completions", {
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
